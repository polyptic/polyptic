/**
 * @polyptic/e2e — MACHINE TAGS + SELECTOR-TARGETED BULK OPERATIONS (POL-103) against the REAL control
 * plane.
 *
 * Spawns the actual server (`packages/server/src/index.ts`) on its own PORT (8221) against the
 * MemoryStore, in GATED mode (POLYPTIC_BOOTSTRAP_TOKEN set) so the fleet arrives `pending` and the
 * bulk APPROVE has something to admit. Then drives the routes exactly as the console does:
 *
 *   PUT  /machines/:id/tags          — tags round-trip, normalize (case/dupes), and survive a re-hello.
 *   POST /machines/bulk/approve      — a selector admits a GROUP; the boxes outside it stay pending.
 *   POST /machines/bulk/reboot       — the matched ONLINE boxes get `server/reboot`; the dark one is an
 *                                      `offline` OUTCOME in the result list, and the call still 200s.
 *   POST /machines/bulk/shell        — arm a group; the flag persists per machine.
 *   POST /machines/bulk/ident        — fans out over a group's screens.
 *   400s                             — a bulk verb with NO target, and a selector that doesn't parse.
 *                                      An unknown TAG is not an error: it is an honest `matched: 0`.
 *
 * Independent of the other e2e suites (own port + fresh store): polyptych (8090), enrollment (8091),
 * murals (8092), walls (8093), content (8094), remove (8100), reboot (8101). All must stay green.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";
import type { BulkOpResponse, Machine } from "@polyptic/protocol";

const PORT = 8221;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const BOOTSTRAP_TOKEN = "tags-e2e-token";
const TEST_TIMEOUT = 15_000;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client (same shape as the other suites): never miss a frame between awaits.
// ─────────────────────────────────────────────────────────────────────────────

type Frame = any;

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: Array<{
    pred: (m: Frame) => boolean;
    resolve: (m: Frame) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: { data: unknown }) => this.ingest(ev.data));
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
      const timer = setTimeout(
        () => rejectMsg(new Error(`timed out waiting for ${label} after ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.waiters.push({ pred, resolve: resolveMsg, timer });
    });
  }

  /** True iff a matching frame arrives within the window; never throws (for absence checks). */
  async sawWithin(pred: (m: Frame) => boolean, timeoutMs: number): Promise<boolean> {
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

// ─────────────────────────────────────────────────────────────────────────────
// REST helpers
// ─────────────────────────────────────────────────────────────────────────────

function json(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function machines(): Promise<Machine[]> {
  const res = await fetch(`${BASE}/api/v1/machines`);
  expect(res.status).toBe(200);
  return (await res.json()) as Machine[];
}

async function machineById(id: string): Promise<Machine | undefined> {
  return (await machines()).find((m) => m.id === id);
}

async function bulk(action: string, body: unknown): Promise<BulkOpResponse> {
  const res = await json("POST", `/api/v1/machines/bulk/${action}`, body);
  expect(res.status).toBe(200);
  return (await res.json()) as BulkOpResponse;
}

function outcomeOf(response: BulkOpResponse, machineId: string): string | undefined {
  return response.results.find((r) => r.machineId === machineId)?.outcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server + fleet lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;
const openClients: WsClient[] = [];

const ATRIUM_ONLINE = "tags-wall-a"; // atrium + canary, stays connected
const ATRIUM_DARK = "tags-wall-b"; // atrium, socket closed → the offline box in every fan-out
const FLOOR2 = "tags-wall-c"; // floor:2, never in an atrium selector

let agentA: WsClient;
let agentB: WsClient;
let agentC: WsClient;

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

/** A gated first contact: hello with the bootstrap token → the machine registers as `pending`. */
async function enrollPending(machineId: string): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/agent`);
  openClients.push(client);
  client.send({
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
    bootstrapToken: BOOTSTRAP_TOKEN,
  });
  await client.waitFor((m) => m.t === "server/enrolled", `server/enrolled for ${machineId}`);
  return client;
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
      POLYPTIC_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();

  agentA = await enrollPending(ATRIUM_ONLINE);
  agentB = await enrollPending(ATRIUM_DARK);
  agentC = await enrollPending(FLOOR2);
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

// ─────────────────────────────────────────────────────────────────────────────
// Tags — CRUD + normalization
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-103 machine tags", () => {
  test(
    "PUT /machines/:id/tags stores the tag set, normalized and de-duplicated",
    async () => {
      const res = await json("PUT", `/api/v1/machines/${ATRIUM_ONLINE}/tags`, {
        tags: ["atrium", "canary"],
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { tags: string[] }).tags).toEqual(["atrium", "canary"]);

      await json("PUT", `/api/v1/machines/${ATRIUM_DARK}/tags`, { tags: ["atrium"] });
      await json("PUT", `/api/v1/machines/${FLOOR2}/tags`, { tags: ["floor:2"] });

      expect((await machineById(ATRIUM_ONLINE))?.tags).toEqual(["atrium", "canary"]);
      expect((await machineById(ATRIUM_DARK))?.tags).toEqual(["atrium"]);
      expect((await machineById(FLOOR2))?.tags).toEqual(["floor:2"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "an ILLEGAL tag is refused (400), and the machine keeps the tags it had",
    async () => {
      const res = await json("PUT", `/api/v1/machines/${ATRIUM_ONLINE}/tags`, {
        tags: ["two words"],
      });
      expect(res.status).toBe(400);
      expect((await machineById(ATRIUM_ONLINE))?.tags).toEqual(["atrium", "canary"]);
    },
    TEST_TIMEOUT,
  );

  test(
    "tags on an UNKNOWN machine are a 404, not a silent create",
    async () => {
      const res = await json("PUT", "/api/v1/machines/ghost/tags", { tags: ["atrium"] });
      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Bulk operations over a selector
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-103 selector-targeted bulk operations", () => {
  test(
    "bulk approve over `tag=atrium` admits exactly the atrium — the floor:2 box stays pending",
    async () => {
      const response = await bulk("approve", { selector: "tag=atrium" });
      expect(response.matched).toBe(2);
      expect(response.applied).toBe(2);
      expect(response.target).toBe("tag=atrium");
      expect(outcomeOf(response, ATRIUM_ONLINE)).toBe("applied");
      expect(outcomeOf(response, ATRIUM_DARK)).toBe("applied");

      // The connected boxes get their screens live; the untagged-for-this-selector box is untouched.
      await agentA.waitFor(
        (m) => m.t === "server/apply" && m.machineId === ATRIUM_ONLINE,
        "server/apply for the approved atrium box",
      );
      expect((await machineById(ATRIUM_ONLINE))?.status).toBe("approved");
      expect((await machineById(ATRIUM_DARK))?.status).toBe("approved");
      expect((await machineById(FLOOR2))?.status).toBe("pending");

      // Re-running it is idempotent: already-approved boxes are `skipped`, not re-admitted.
      const again = await bulk("approve", { selector: "tag=atrium" });
      expect(again.applied).toBe(0);
      expect(outcomeOf(again, ATRIUM_ONLINE)).toBe("skipped");
    },
    TEST_TIMEOUT,
  );

  test(
    "bulk reboot over `tag=atrium`: the online box reboots, the DARK one is an offline outcome (still 200)",
    async () => {
      // Take one atrium box down — three offline boxes must never fail the whole call.
      agentB.close();
      await sleep(300);

      const response = await bulk("reboot", {
        selector: "tag=atrium",
        reason: "e2e bulk reboot",
      });
      expect(response.matched).toBe(2);
      expect(response.applied).toBe(1);
      expect(outcomeOf(response, ATRIUM_ONLINE)).toBe("applied");
      expect(outcomeOf(response, ATRIUM_DARK)).toBe("offline");
      expect(response.results.find((r) => r.machineId === ATRIUM_DARK)?.detail).toContain("offline");

      // The reboot really reached the live box, carrying the operator's reason…
      const reboot = await agentA.waitFor((m) => m.t === "server/reboot", "server/reboot on wall-a");
      expect(reboot.reason).toBe("e2e bulk reboot");
      // …and never reached the box outside the selector.
      expect(await agentC.sawWithin((m) => m.t === "server/reboot", 400)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "bulk shell arms a whole group; the flag lands on each machine",
    async () => {
      const response = await bulk("shell", { selector: "tag=atrium", enabled: true });
      expect(response.applied).toBe(2); // arming is persisted state — an offline box arms fine
      expect((await machineById(ATRIUM_ONLINE))?.shellEnabled).toBe(true);
      expect((await machineById(ATRIUM_DARK))?.shellEnabled).toBe(true);
      expect((await machineById(FLOOR2))?.shellEnabled).toBe(false);

      const off = await bulk("shell", { selector: "tag=atrium", enabled: false });
      expect(off.applied).toBe(2);
      expect((await machineById(ATRIUM_ONLINE))?.shellEnabled).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "bulk ident fans out over the group's screens; a box with no player is an offline outcome",
    async () => {
      const response = await bulk("ident", { selector: "tag=atrium", on: true, ttlMs: 500 });
      expect(response.matched).toBe(2);
      // No players are connected in this suite, so nothing lands — but the call still reports honestly.
      expect(outcomeOf(response, ATRIUM_ONLINE)).toBe("offline");
      expect(response.results.every((r) => r.outcome !== "failed")).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "an explicit machineIds target works, and an UNKNOWN id is reported, not fatal",
    async () => {
      const response = await bulk("shell", {
        machineIds: [FLOOR2, "ghost"],
        enabled: true,
      });
      expect(response.matched).toBe(2); // one real machine + the reported ghost
      expect(response.applied).toBe(1);
      expect(outcomeOf(response, FLOOR2)).toBe("applied");
      expect(outcomeOf(response, "ghost")).toBe("failed");
      expect((await machineById(FLOOR2))?.shellEnabled).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "an UNKNOWN TAG is not an error — it is an honest `matched: 0`, and nothing is touched",
    async () => {
      const response = await bulk("reboot", { selector: "tag=basement" });
      expect(response.matched).toBe(0);
      expect(response.applied).toBe(0);
      expect(response.results).toEqual([]);
      expect(await agentA.sawWithin((m) => m.t === "server/reboot", 400)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "a bulk verb with NO target is a 400 — it must never mean 'the whole fleet'",
    async () => {
      const res = await json("POST", "/api/v1/machines/bulk/reboot", {});
      expect(res.status).toBe(400);
      const empty = await json("POST", "/api/v1/machines/bulk/reboot", { selector: "  " });
      expect(empty.status).toBe(400);
      expect(await agentA.sawWithin((m) => m.t === "server/reboot", 400)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "a selector that does not PARSE is a 400 whose sentence names the grammar",
    async () => {
      const res = await json("POST", "/api/v1/machines/bulk/reboot", { selector: "atrium" });
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error?: string };
      expect(String(payload.error)).toContain("tag=<value>");
    },
    TEST_TIMEOUT,
  );

  test(
    "naming BOTH a selector and a machineIds list is a 400 — one target, unambiguously",
    async () => {
      const res = await json("POST", "/api/v1/machines/bulk/reboot", {
        selector: "tag=atrium",
        machineIds: [FLOOR2],
      });
      expect(res.status).toBe(400);
    },
    TEST_TIMEOUT,
  );

  test(
    "tags survive an agent re-hello — they are registry state, not something the box reports",
    async () => {
      const reconnected = await WsClient.connect(`${WS}/agent`);
      openClients.push(reconnected);
      reconnected.send({
        t: "agent/hello",
        protocol: PROTOCOL_VERSION,
        machineId: FLOOR2,
        agentVersion: "e2e",
        backend: "dev-open",
        outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
        bootstrapToken: BOOTSTRAP_TOKEN,
      });
      await reconnected.waitFor(
        (m) => m.t === "server/enrolled" || m.t === "server/apply" || m.t === "server/pending",
        "re-hello ack",
      );
      await sleep(200);
      expect((await machineById(FLOOR2))?.tags).toEqual(["floor:2"]);
    },
    TEST_TIMEOUT,
  );
});
