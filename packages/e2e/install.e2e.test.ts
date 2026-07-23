/**
 * @polyptic/e2e — INSTALL-TO-DISK suite (POL-176) against the REAL control plane.
 *
 * Spawns the actual server in OPEN mode on its own PORT (8150) against the MemoryStore, then drives
 * the whole install contract exactly as the console will:
 *
 *   agent/hello with bootMode/disks/stagedImageId  → the facts land on the MachineView (bootMode,
 *                                                     the disk inventory the INSTALL dialog names,
 *                                                     the staged image id).
 *   POST /api/v1/machines/:id/install { device }   → a `server/install` frame reaches THAT agent,
 *                                                     and every refusal answers the right status:
 *                                                     404 unknown, 400 unknown/removable device,
 *                                                     409 installed / unknown boot mode / offline.
 *   agent/install-status frames                    → fold into MachineView.installing live, and the
 *                                                     terminal `done`/`failed` lands one feed line.
 *   vitals.stagedImageId on the heartbeat          → persists + one "update ready" feed line on the
 *                                                     change, silence on the steady repeat.
 *
 * The agent-side validation (refusing a non-live box, tailing the real status file) is unit-tested
 * in packages/agent/test/install.test.ts — here the "agent" is a raw socket that reports whatever
 * facts the scenario needs.
 *
 * Independent of the other e2e suites (own port + fresh store).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8150;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── A buffering WS client (same shape as the other suites) ───────────────────

type Frame = any;
type Predicate = (m: Frame) => boolean;

interface Waiter {
  pred: Predicate;
  resolve: (m: Frame) => void;
  timer: ReturnType<typeof setTimeout>;
}

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: Waiter[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: { data: unknown }) => this.ingest(ev.data));
  }

  static connect(url: string, timeoutMs = 5_000): Promise<WsClient> {
    return new Promise<WsClient>((resolveConn, rejectConn) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        rejectConn(new Error(`ws open timeout: ${url}`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolveConn(new WsClient(ws));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          rejectConn(new Error(`ws error before open: ${url}`));
        },
        { once: true },
      );
    });
  }

  private ingest(data: unknown): void {
    const text = typeof data === "string" ? data : String(data);
    let msg: Frame;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const idx = this.waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  waitFor(pred: Predicate, label = "frame", timeoutMs = 4_000): Promise<Frame> {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise<Frame>((resolveMsg, rejectMsg) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        rejectMsg(new Error(`timed out waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolveMsg, timer });
    });
  }

  async sawWithin(pred: Predicate, timeoutMs: number): Promise<boolean> {
    try {
      await this.waitFor(pred, "presence-probe", timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }
}

// ── REST + wire helpers ──────────────────────────────────────────────────────

async function errorOf(res: Response): Promise<string> {
  const payload = (await res.json()) as { error?: unknown };
  return String(payload.error ?? "");
}

function postJson(path: string, body?: unknown): Promise<Response> {
  if (body === undefined) return fetch(`${BASE}${path}`, { method: "POST" });
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The disk inventory every live box in this suite reports: one internal SSD + one USB stick. */
const DISKS = [
  {
    device: "/dev/sda",
    sizeBytes: 256_060_514_304,
    model: "SAMSUNG MZ7LN256",
    removable: false,
    contents: "empty",
  },
  {
    device: "/dev/sdb",
    sizeBytes: 15_931_539_456,
    model: "USB Flash Disk",
    removable: true,
    contents: "vfat (POLYPTIC)",
  },
];

function agentHello(machineId: string, facts: Record<string, unknown> = {}): Frame {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
    ...facts,
  };
}

const openClients: WsClient[] = [];

async function openAgent(machineId: string, facts: Record<string, unknown> = {}): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/agent`);
  openClients.push(client);
  client.send(agentHello(machineId, facts));
  await client.waitFor(
    (m) => m.t === "server/apply" && m.machineId === machineId,
    `server/apply for ${machineId}`,
  );
  return client;
}

async function connectAdmin(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/admin`);
  openClients.push(client);
  client.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  return client;
}

function machineIn(state: Frame, machineId: string): any {
  return (state.machines as any[]).find((m) => m.id === machineId);
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/state`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}: ${lastErr}`);
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
      AUTH_ENABLED: "false",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();
}, 30_000);

afterAll(async () => {
  for (const c of openClients) c.close();
  if (proc) {
    proc.kill();
    try {
      await proc.exited;
    } catch {
      /* already gone */
    }
  }
}, 10_000);

const LIVE = "install-live-box"; // netbooted, install target
const INSTALLED = "install-done-box"; // already on its disk
const DEV = "install-dev-box"; // no boot mode at all
let liveAgent: WsClient;

// ─────────────────────────────────────────────────────────────────────────────
// The facts on the view
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-176 — the hello's boot facts reach the MachineView", () => {
  test(
    "bootMode, disks and stagedImageId land on the machine card (and absence stays absent)",
    async () => {
      liveAgent = await openAgent(LIVE, {
        bootMode: "live",
        disks: DISKS,
        stagedImageId: "20260720T000000Z-aaaa1111",
      });
      await openAgent(INSTALLED, { bootMode: "installed", disks: [DISKS[0]] });
      await openAgent(DEV); // a dev box: no facts at all

      const admin = await connectAdmin();
      const state = await admin.waitFor(
        (m) => m.t === "admin/state" && machineIn(m, DEV) !== undefined,
        "admin/state with all three boxes",
      );

      const live = machineIn(state, LIVE);
      expect(live.bootMode).toBe("live");
      expect(live.disks).toHaveLength(2);
      expect(live.disks[0].device).toBe("/dev/sda");
      expect(live.disks[0].model).toBe("SAMSUNG MZ7LN256");
      expect(live.stagedImageId).toBe("20260720T000000Z-aaaa1111");

      expect(machineIn(state, INSTALLED).bootMode).toBe("installed");

      const dev = machineIn(state, DEV);
      expect(dev.bootMode).toBeUndefined();
      expect(dev.disks).toBeUndefined();
      expect(dev.stagedImageId).toBeUndefined();
      admin.close();
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The REST gate
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-176 — POST /machines/:id/install", () => {
  test(
    "delivers server/install (with the device) to THAT agent, and the feed names the disk",
    async () => {
      const res = await postJson(`/api/v1/machines/${LIVE}/install`, { device: "/dev/sda" });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { ok: boolean; device: string; delivered: number };
      expect(payload.ok).toBe(true);
      expect(payload.device).toBe("/dev/sda");
      expect(payload.delivered).toBe(1);

      const frame = await liveAgent.waitFor((m) => m.t === "server/install", "server/install");
      expect(frame.device).toBe("/dev/sda");

      // The operator's click leaves an immediate feed trace naming the disk — the record of consent.
      // (The feed only travels folded into admin/state, so read it off a fresh admin snapshot.)
      const admin = await connectAdmin();
      const state = await admin.waitFor((m) => m.t === "admin/state", "admin/state with the feed");
      expect(
        (state.activity as any[]).some(
          (e) => String(e.text).includes("/dev/sda") && String(e.text).includes("Installing"),
        ),
      ).toBe(true);
      admin.close();
    },
    TEST_TIMEOUT,
  );

  test(
    "an unknown device is a 400 that says the box never reported it",
    async () => {
      const res = await postJson(`/api/v1/machines/${LIVE}/install`, { device: "/dev/sdz" });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain("/dev/sdz");
    },
    TEST_TIMEOUT,
  );

  test(
    "removable media is a 400 — the boot stick is never an install target",
    async () => {
      const res = await postJson(`/api/v1/machines/${LIVE}/install`, { device: "/dev/sdb" });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain("removable");
    },
    TEST_TIMEOUT,
  );

  test(
    "an INSTALLED box is a 409 that says there is nothing to install",
    async () => {
      const res = await postJson(`/api/v1/machines/${INSTALLED}/install`, { device: "/dev/sda" });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain("already runs from its internal disk");
    },
    TEST_TIMEOUT,
  );

  test(
    "a box with NO reported boot mode is a 409 — never wipe a disk on an unknown mode",
    async () => {
      const res = await postJson(`/api/v1/machines/${DEV}/install`, { device: "/dev/sda" });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain("boot mode is unknown");
    },
    TEST_TIMEOUT,
  );

  test(
    "an unknown machine is a 404, and a missing device a 400",
    async () => {
      expect((await postJson(`/api/v1/machines/ghost/install`, { device: "/dev/sda" })).status).toBe(404);
      expect((await postJson(`/api/v1/machines/${LIVE}/install`, {})).status).toBe(400);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The narration + the outcome
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-176 — install narration folds into the view; the outcome lands in the feed", () => {
  test(
    "install-ack + install-status drive MachineView.installing; done lands one good line",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      liveAgent.send({ t: "agent/install-ack", machineId: LIVE, accepted: true });
      const starting = await admin.waitFor(
        (m) => m.t === "admin/state" && machineIn(m, LIVE)?.installing?.phase === "starting",
        "installing: starting",
      );
      expect(machineIn(starting, LIVE).installing.at).toBeDefined();

      liveAgent.send({
        t: "agent/install-status",
        machineId: LIVE,
        phase: "fetching",
        percent: 42,
        detail: "rootfs.squashfs 210 MiB of 492 MiB",
      });
      const fetching = await admin.waitFor(
        (m) => m.t === "admin/state" && machineIn(m, LIVE)?.installing?.phase === "fetching",
        "installing: fetching",
      );
      expect(machineIn(fetching, LIVE).installing.percent).toBe(42);

      liveAgent.send({
        t: "agent/install-status",
        machineId: LIVE,
        phase: "done",
        percent: 100,
        detail: "installed to /dev/sda, slot A",
      });
      const done = await admin.waitFor(
        (m) => m.t === "admin/state" && machineIn(m, LIVE)?.installing?.phase === "done",
        "installing: done",
      );
      const line = (done.activity as any[]).find((e) => String(e.text).includes("installed Polyptic to disk"));
      expect(line).toBeDefined();
      expect(line.severity).toBe("good");
      expect(line.text).toContain("restarting");

      // POL-177 — the control plane finishes the job: a successful install earns an immediate
      // server/reboot to THAT box, so it restarts into the installed system without a click.
      const reboot = await liveAgent.waitFor((m) => m.t === "server/reboot", "server/reboot after done");
      expect(String(reboot.reason)).toContain("install finished");
      admin.close();
    },
    TEST_TIMEOUT,
  );

  test(
    "a REFUSED ack is loud: the operator's click did nothing, and the feed says why",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");
      liveAgent.send({
        t: "agent/install-ack",
        machineId: LIVE,
        accepted: false,
        reason: "no privileged install helper on this box",
      });
      const state = await admin.waitFor(
        (m) =>
          m.t === "admin/state" &&
          (m.activity as any[]).some((e) => String(e.text).includes("refused to install")),
        "refusal feed line",
      );
      const line = (state.activity as any[]).find((e) => String(e.text).includes("refused to install"));
      expect(line.severity).toBe("bad");
      expect(line.text).toContain("no privileged install helper");
      admin.close();
    },
    TEST_TIMEOUT,
  );

  test(
    "a FAILED install lands one bad line carrying the installer's own sentence",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");
      liveAgent.send({
        t: "agent/install-status",
        machineId: LIVE,
        phase: "failed",
        detail: "disk too small: need 8 GiB, have 4 GiB",
      });
      const state = await admin.waitFor(
        (m) =>
          m.t === "admin/state" &&
          (m.activity as any[]).some((e) => String(e.text).includes("could not install to disk")),
        "failure feed line",
      );
      const line = (state.activity as any[]).find((e) => String(e.text).includes("could not install to disk"));
      expect(line.severity).toBe("bad");
      expect(line.text).toContain("disk too small");
      admin.close();
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The staged image id on the heartbeat
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-176 — vitals.stagedImageId persists and announces the update-ready edge", () => {
  test(
    "a staged id CHANGE reaches the view + one feed line; the steady repeat is silent",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      const status = (staged: string): Frame => ({
        t: "agent/status",
        machineId: LIVE,
        observedRevision: 0,
        screens: [],
        vitals: { imageId: "20260720T000000Z-aaaa1111", stagedImageId: staged },
      });

      liveAgent.send(status("20260723T000000Z-bbbb2222"));
      const state = await admin.waitFor(
        (m) => m.t === "admin/state" && machineIn(m, LIVE)?.stagedImageId === "20260723T000000Z-bbbb2222",
        "staged image on the view",
      );
      const line = (state.activity as any[]).find((e) =>
        String(e.text).includes("staged image 20260723T000000Z-bbbb2222"),
      );
      expect(line).toBeDefined();
      expect(line.text).toContain("reboot");

      // The same id arrives every heartbeat — it must not add a second line.
      liveAgent.send(status("20260723T000000Z-bbbb2222"));
      await sleep(300);
      const fresh = await connectAdmin();
      const after = await fresh.waitFor((m) => m.t === "admin/state", "post-repeat snapshot");
      const staged = (after.activity as any[]).filter((e) =>
        String(e.text).includes("staged image 20260723T000000Z-bbbb2222"),
      );
      expect(staged.length).toBe(1);
      admin.close();
      fresh.close();
    },
    TEST_TIMEOUT,
  );
});
