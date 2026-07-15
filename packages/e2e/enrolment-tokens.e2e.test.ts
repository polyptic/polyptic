/**
 * @polyptic/e2e — POL-104 batch enrolment tokens + pre-registration, against the REAL control plane.
 *
 * The server is spawned with `POLYPTIC_BOOTSTRAP_TOKEN` set — i.e. exactly as an EXISTING gated
 * deployment upgrading into POL-104 comes up, with one flat secret already baked into every boot
 * medium in the field. The suite then asserts, in order:
 *
 *   1. BACK-COMPAT. That legacy secret still enrols a brand-new box, and appears in the token table as
 *      a legacy record: no expiry, no cap, and it is still the token `/boot/grub.cfg` bakes (which is
 *      the token `build-boot-medium.sh` lifts back out of that very menu). A medium flashed before the
 *      upgrade boots and enrols after it.
 *   2. A batch token, CAPPED at one machine: the first box enrols, the second is refused — "used up".
 *   3. REVOCATION: a new box on a revoked token is refused, while the box that already enrolled on it
 *      reconnects on its per-machine credential and is admitted. Revoking must never darken a wall.
 *   4. ROTATION with a grace window: the old secret keeps enrolling, and the NEW one is what
 *      `/boot/grub.cfg` now bakes.
 *   5. PRE-REGISTRATION: a box declared by MAC enrols, auto-names, and auto-approves with ZERO clicks —
 *      `server/apply` lands on its first hello, no pending card, no operator.
 *   6. Pending cards are INFORMATIVE: admin/state carries the box's MAC, serial, arch and live IP.
 *   7. `/boot/report` still authenticates on a token we have since REVOKED (the box that cannot enrol
 *      is the box whose boot report we most need).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8118;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
/** The pre-POL-104 flat token — as if it had been baked into every stick in the estate. */
const LEGACY_TOKEN = "legacy-flat-token";
const TEST_TIMEOUT = 15_000;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Frame = any;

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: {
    pred: (m: Frame) => boolean;
    resolve: (m: Frame) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  private closed = false;
  private closeResolvers: Array<() => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: { data: unknown }) => this.ingest(ev.data));
    ws.addEventListener("close", () => {
      this.closed = true;
      const resolvers = this.closeResolvers;
      this.closeResolvers = [];
      for (const r of resolvers) r();
    });
  }

  static connect(url: string, timeoutMs = 5_000): Promise<WsClient> {
    return new Promise<WsClient>((resolveConn, rejectConn) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => rejectConn(new Error(`ws open timeout: ${url}`)), timeoutMs);
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
    let msg: Frame;
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data));
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

  waitFor(pred: (m: Frame) => boolean, label = "frame", timeoutMs = 4_000): Promise<Frame> {
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

  async sawWithin(pred: (m: Frame) => boolean, timeoutMs: number): Promise<boolean> {
    try {
      await this.waitFor(pred, "probe", timeoutMs);
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

const openClients: WsClient[] = [];

async function openAgent(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/agent`);
  openClients.push(client);
  return client;
}

async function connectAdmin(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/admin`);
  openClients.push(client);
  client.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  return client;
}

function hello(machineId: string, extra: Record<string, unknown> = {}): Frame {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
    ...extra,
  };
}

function postJson(path: string, body?: unknown): Promise<Response> {
  if (body === undefined) return fetch(`${BASE}${path}`, { method: "POST" });
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tokens(): Promise<Frame[]> {
  const res = await fetch(`${BASE}/api/v1/settings/enrollment`);
  const info = (await res.json()) as Frame;
  return info.tokens as Frame[];
}

/** The token `/boot/grub.cfg` actually bakes RIGHT NOW — read out of the real menu, exactly the way
 *  `deploy/build-boot-medium.sh` does it at bake time (`sed -n 's/.*polyptic\.token=…/\1/p'`). */
async function bakedToken(): Promise<string | undefined> {
  const res = await fetch(`${BASE}/boot/grub.cfg`);
  const menu = await res.text();
  return /polyptic\.token=(\S+)/.exec(menu)?.[1];
}

let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/state`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}`);
}

beforeAll(async () => {
  // Spawn the server on THE SAME bun that is running this test (not whatever `bun` is on PATH): the
  // peer address of a WS upgrade is only exposed by newer Bun runtimes, and the IP assertion below
  // must not silently depend on which bun a developer happens to have installed. CI runs 1.3.14.
  proc = Bun.spawn([process.execPath, serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      // An EXISTING gated deployment: one flat token, already baked into every medium in the field.
      POLYPTIC_BOOTSTRAP_TOKEN: LEGACY_TOKEN,
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

describe("POL-104 · the upgrade does not strand the media already in the field", () => {
  test(
    "the flat bootstrap token is lifted verbatim: legacy record, no expiry, no cap, still baked",
    async () => {
      const list = await tokens();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        secret: LEGACY_TOKEN,
        expiresAt: null,
        maxEnrollments: null,
        bake: true,
        legacy: true,
      });
      // The physical consequence: a stick baked yesterday carries this secret, and `/boot/grub.cfg`
      // still hands out this secret today.
      expect(await bakedToken()).toBe(LEGACY_TOKEN);
    },
    TEST_TIMEOUT,
  );

  test(
    "a box booting from an ALREADY-FLASHED medium still enrols",
    async () => {
      const agent = await openAgent();
      agent.send(hello("old-medium-box", { bootstrapToken: LEGACY_TOKEN }));
      const enrolled = await agent.waitFor((m) => m.t === "server/enrolled", "server/enrolled");
      expect(enrolled.status).toBe("pending");
      expect(enrolled.credential).toBeString();
      await agent.waitFor((m) => m.t === "server/pending", "server/pending");
    },
    TEST_TIMEOUT,
  );
});

describe("POL-104 · a capped batch token", () => {
  let batchSecret = "";
  let batchId = "";

  test(
    "cutting one does not disturb the legacy token",
    async () => {
      const res = await postJson("/api/v1/settings/enrollment/tokens", {
        name: "Floor 3 rollout",
        maxEnrollments: 1,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Frame;
      batchSecret = body.token.secret;
      batchId = body.token.id;
      expect(body.token.maxEnrollments).toBe(1);
      // It is NOT the bake token unless asked — the media in the field are still the legacy ones.
      expect(body.token.bake).toBe(false);
      expect(await bakedToken()).toBe(LEGACY_TOKEN);
    },
    TEST_TIMEOUT,
  );

  test(
    "the first box enrols on it",
    async () => {
      const agent = await openAgent();
      agent.send(hello("batch-box-1", { bootstrapToken: batchSecret }));
      const enrolled = await agent.waitFor((m) => m.t === "server/enrolled", "server/enrolled");
      expect(enrolled.status).toBe("pending");

      const list = await tokens();
      expect(list.find((t) => t.id === batchId)?.uses).toBe(1);
    },
    TEST_TIMEOUT,
  );

  test(
    "the SECOND box is refused — the batch is used up",
    async () => {
      const agent = await openAgent();
      agent.send(hello("batch-box-2", { bootstrapToken: batchSecret }));
      const rejected = await agent.waitFor((m) => m.t === "server/rejected", "server/rejected");
      expect(rejected.reason).toContain("maximum number of enrolments");
    },
    TEST_TIMEOUT,
  );
});

describe("POL-104 · revocation blocks the door, not the room", () => {
  let secret = "";
  let tokenId = "";
  let credential = "";

  test(
    "a box enrols on a token, and is approved",
    async () => {
      const created = (await (
        await postJson("/api/v1/settings/enrollment/tokens", { name: "Site B" })
      ).json()) as Frame;
      secret = created.token.secret;
      tokenId = created.token.id;

      const agent = await openAgent();
      agent.send(hello("revoke-box", { bootstrapToken: secret }));
      const enrolled = await agent.waitFor((m) => m.t === "server/enrolled", "server/enrolled");
      credential = enrolled.credential;

      const approve = await postJson("/api/v1/machines/revoke-box/approve");
      expect(approve.status).toBe(200);
      agent.close();
    },
    TEST_TIMEOUT,
  );

  test(
    "revoking it refuses a NEW box",
    async () => {
      const res = await postJson(`/api/v1/settings/enrollment/tokens/${tokenId}/revoke`);
      expect(res.status).toBe(200);

      const agent = await openAgent();
      agent.send(hello("revoke-box-2", { bootstrapToken: secret }));
      const rejected = await agent.waitFor((m) => m.t === "server/rejected", "server/rejected");
      expect(rejected.reason).toContain("revoked");
    },
    TEST_TIMEOUT,
  );

  test(
    "…while the box ALREADY enrolled on it reconnects and is admitted — the wall stays up",
    async () => {
      const agent = await openAgent();
      agent.send(hello("revoke-box", { credential }));
      const apply = await agent.waitFor((m) => m.t === "server/apply", "server/apply");
      expect(apply.machineId).toBe("revoke-box");
      expect(apply.screens.length).toBe(1);
      expect(await agent.sawWithin((m) => m.t === "server/rejected", 300)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "its card says which (revoked) token it came in on — provenance, not a status",
    async () => {
      const admin = await connectAdmin();
      const state = await admin.waitFor(
        (m) => m.t === "admin/state" && m.machines.some((mm: Frame) => mm.id === "revoke-box"),
        "admin/state",
      );
      const machine = state.machines.find((mm: Frame) => mm.id === "revoke-box");
      expect(machine.status).toBe("approved");
      expect(machine.enrolledVia).toMatchObject({ tokenId, name: "Site B", revoked: true });
    },
    TEST_TIMEOUT,
  );
});

describe("POL-104 · rotation leaves a grace window", () => {
  test(
    "the old secret still enrols, and the NEW one is what /boot/grub.cfg bakes",
    async () => {
      const legacy = (await tokens()).find((t) => t.legacy)!;
      const res = await postJson(`/api/v1/settings/enrollment/tokens/${legacy.id}/rotate`, {
        graceHours: 24,
      });
      expect(res.status).toBe(200);
      const rotated = (await res.json()) as Frame;

      // New media carry the successor…
      expect(await bakedToken()).toBe(rotated.token.secret);
      // …and the old secret — the one on every stick already flashed — is still good for 24 h.
      const agent = await openAgent();
      agent.send(hello("grace-box", { bootstrapToken: LEGACY_TOKEN }));
      const enrolled = await agent.waitFor((m) => m.t === "server/enrolled", "server/enrolled");
      expect(enrolled.status).toBe("pending");

      const old = (await tokens()).find((t) => t.id === legacy.id)!;
      expect(old.expiresAt).toBeString();
      expect(old.bake).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

describe("POL-104 · pre-registration is zero-click commissioning", () => {
  test(
    "a pre-registered box auto-names and auto-approves on its FIRST hello — no pending card",
    async () => {
      const bakeSecret = (await bakedToken())!;

      const imported = await postJson("/api/v1/pre-registrations/import", {
        csv: "Lobby left, aa:bb:cc:dd:ee:01, floor-1\nnonsense-with-no-identifier",
        autoApprove: true,
      });
      expect(imported.status).toBe(200);
      const importBody = (await imported.json()) as Frame;
      expect(importBody.created).toHaveLength(1);
      // The bad line is REPORTED, not silently dropped.
      expect(importBody.errors).toHaveLength(1);
      expect(importBody.errors[0].line).toBe(2);

      const agent = await openAgent();
      agent.send(
        hello("prereg-box", {
          bootstrapToken: bakeSecret,
          hardware: { macs: ["aa:bb:cc:dd:ee:01"], dmiSerial: "SN-777", arch: "arm64" },
        }),
      );

      // The zero-click path: enrolled → approved → apply, with no operator anywhere.
      await agent.waitFor((m) => m.t === "server/enrolled", "server/enrolled");
      const apply = await agent.waitFor((m) => m.t === "server/apply", "server/apply");
      expect(apply.machineId).toBe("prereg-box");
      expect(apply.screens).toHaveLength(1);
      expect(await agent.sawWithin((m) => m.t === "server/pending", 300)).toBe(false);

      const admin = await connectAdmin();
      const state = await admin.waitFor(
        (m) => m.t === "admin/state" && m.machines.some((mm: Frame) => mm.id === "prereg-box"),
        "admin/state",
      );
      const machine = state.machines.find((mm: Frame) => mm.id === "prereg-box");
      expect(machine.status).toBe("approved");
      expect(machine.label).toBe("Lobby left");
      expect(machine.preRegistered).toBe(true);

      const records = (await (await fetch(`${BASE}/api/v1/pre-registrations`)).json()) as Frame;
      const claimed = records.records.find((r: Frame) => r.mac === "aa:bb:cc:dd:ee:01");
      expect(claimed.matchedMachineId).toBe("prereg-box");
      expect(claimed.matchedOn).toBe("mac");
    },
    TEST_TIMEOUT,
  );

  test(
    "a pending card carries the hardware an operator needs to tell one box from another",
    async () => {
      const bakeSecret = (await bakedToken())!;
      const agent = await openAgent();
      agent.send(
        hello("facts-box", {
          bootstrapToken: bakeSecret,
          hardware: {
            macs: ["aa:bb:cc:dd:ee:99"],
            dmiSerial: "SN-90210",
            dmiVendor: "ACME",
            dmiProduct: "MiniPC 3",
            arch: "x64",
          },
        }),
      );
      await agent.waitFor((m) => m.t === "server/pending", "server/pending");

      const admin = await connectAdmin();
      const state = await admin.waitFor(
        (m) => m.t === "admin/state" && m.machines.some((mm: Frame) => mm.id === "facts-box"),
        "admin/state",
      );
      const machine = state.machines.find((mm: Frame) => mm.id === "facts-box");
      expect(machine.status).toBe("pending");
      expect(machine.hardware).toMatchObject({
        macs: ["aa:bb:cc:dd:ee:99"],
        dmiSerial: "SN-90210",
        dmiVendor: "ACME",
        arch: "x64",
      });
      // Live-only, and the box IS online: the operator can see where it is dialling from.
      expect(machine.ip).toBeString();
      expect(machine.enrolledVia?.name).toBeString();
    },
    TEST_TIMEOUT,
  );
});

describe("POL-104 · the boot depot", () => {
  test(
    "POST /boot/report accepts a token we have since REVOKED (that box is the one we need to hear from)",
    async () => {
      const created = (await (
        await postJson("/api/v1/settings/enrollment/tokens", { name: "Doomed" })
      ).json()) as Frame;
      await postJson(`/api/v1/settings/enrollment/tokens/${created.token.id}/revoke`);

      const res = await fetch(`${BASE}/boot/report`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${created.token.secret}`,
        },
        body: JSON.stringify({ ok: true, code: "installed", machineId: "report-box" }),
      });
      // 204: the report is accepted and mutates nothing (it only writes a Live Activity line).
      expect(res.status).toBe(204);
    },
    TEST_TIMEOUT,
  );

  test(
    "…but an unknown token is still refused",
    async () => {
      const res = await fetch(`${BASE}/boot/report`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nonsense" },
        body: JSON.stringify({ ok: true, code: "installed", machineId: "report-box" }),
      });
      expect(res.status).toBe(401);
    },
    TEST_TIMEOUT,
  );
});
