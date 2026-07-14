/**
 * @polyptic/e2e — POL-95: the ACTIVE scene is SERVER-AUTHORITATIVE, and the apply-preview diff, both
 * against the REAL control plane.
 *
 * Before POL-95 the console's "Active" badge was a client-side fiction: `activeSceneId` was set
 * optimistically when THAT console clicked Apply and never came from the server — so a reloaded tab,
 * or a second operator watching the same wall, saw no badge (or a stale one). That breaks the project's
 * first principle: one global desired-state, reconciled; the control plane is the brain.
 *
 * This suite pins the fix end-to-end, with TWO admin sockets open at once (operator 1 and operator 2)
 * plus a FRESH connection standing in for a reloaded tab:
 *   - `admin/state` carries `activeSceneId`, and it starts null;
 *   - POST /scenes/:id/apply → BOTH live consoles are pushed the new activeSceneId (no refetch, no
 *     reload — it rides the same broadcast as the re-laid wall), and a freshly-connected console's
 *     first snapshot agrees;
 *   - a MANUAL content change (the kind a second operator makes) CLEARS it on both consoles;
 *   - GET /scenes/:id/diff previews the apply: `identical` right after one, and afterwards a
 *     structured changeset (content from → to, with the library source's NAME) that says what the wall
 *     will do before it visibly jumps;
 *   - the diff of an unknown scene is a 404.
 *
 * Own port (8124), own memory store, independent of every other suite.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8124;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 15_000;

const MACHINE_ID = "active-scene-host";
const RES_W = 1920;
const RES_H = 1080;
const CONN_A = "HDMI-1";
const CONN_B = "HDMI-2";

const LIB_NAME = "Ops dashboard";
const LIB_URL = "https://example.com/ops";
const MANUAL_URL = "https://example.com/manual-override";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Frame = any;

/** A buffering WS client: a frame arriving between awaits is never missed. */
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
      const timer = setTimeout(() => {
        ws.close();
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

  waitFor(pred: (m: Frame) => boolean, label = "frame", timeoutMs = 5_000): Promise<Frame> {
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

async function postJson(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function putJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

const openClients: WsClient[] = [];

function adminHello(): unknown {
  return { t: "admin/hello", protocol: PROTOCOL_VERSION };
}

/** An admin console that stays connected (an operator with the console open). */
async function openConsole(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/admin`);
  openClients.push(client);
  client.send(adminHello());
  await client.waitFor((m) => m.t === "admin/state", "initial admin/state");
  return client;
}

/** A brand-new console connection — the reloaded tab. Its FIRST snapshot is current server state. */
async function freshSnapshot(label: string): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send(adminHello());
  const state = await admin.waitFor((m) => m.t === "admin/state", label);
  admin.close();
  return state;
}

/** The next admin/state on a LIVE console whose activeSceneId is `expected` (pushed, never polled). */
function waitForActive(client: WsClient, expected: string | null, label: string): Promise<Frame> {
  return client.waitFor(
    (m) => m.t === "admin/state" && (m.activeSceneId ?? null) === expected,
    label,
    6_000,
  );
}

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

let screenA = "";
let screenB = "";
let muralId = "";
let sourceId = "";
let sceneId = "";

/** Two operators watching the same wall at the same time. */
let operator1: WsClient;
let operator2: WsClient;

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

  const agent = await WsClient.connect(`${WS}/agent`);
  openClients.push(agent);
  agent.send({
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId: MACHINE_ID,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [
      { connector: CONN_A, width: RES_W, height: RES_H },
      { connector: CONN_B, width: RES_W, height: RES_H },
    ],
  });
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "server/apply",
  );
  screenA = apply.screens.find((s: Frame) => s.connector === CONN_A).screenId;
  screenB = apply.screens.find((s: Frame) => s.connector === CONN_B).screenId;

  const seeded = await freshSnapshot("admin/state with the seeded mural");
  muralId = seeded.murals.find((m: Frame) => m.name === "Wall").id;

  for (const [screenId, x] of [
    [screenA, 0],
    [screenB, RES_W],
  ] as const) {
    const res = await putJson(`/api/v1/screens/${screenId}/placement`, {
      muralId,
      x,
      y: 0,
      w: RES_W,
      h: RES_H,
    });
    expect(res.ok).toBe(true);
    await drain(res);
  }

  const srcRes = await postJson(`/api/v1/content-sources`, {
    name: LIB_NAME,
    kind: "web",
    url: LIB_URL,
  });
  expect(srcRes.status).toBe(201);
  sourceId = ((await srcRes.json()) as Frame).source.id;

  // The wall we will save: A shows the library source, B shows nothing.
  const content = await putJson(`/api/v1/screens/${screenA}/content`, { sourceId });
  expect(content.status).toBe(200);
  await drain(content);

  operator1 = await openConsole();
  operator2 = await openConsole();
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

describe("POL-95 — the active scene is server-authoritative", () => {
  test(
    "admin/state carries activeSceneId, and nothing is active before an apply",
    async () => {
      const state = await freshSnapshot("admin/state before any apply");
      expect(state.activeSceneId ?? null).toBeNull();

      // Save the current wall as a scene — SAVING does not make it active (the wall was photographed,
      // not applied).
      const res = await postJson(`/api/v1/scenes`, { name: "Opening", muralId });
      expect(res.status).toBe(201);
      sceneId = ((await res.json()) as Frame).scene.id;

      const after = await freshSnapshot("admin/state after saving the scene");
      expect(after.activeSceneId ?? null).toBeNull();
    },
    TEST_TIMEOUT,
  );

  test(
    "applying it pushes the Active badge to BOTH live consoles, and to a reloaded tab",
    async () => {
      const res = await postJson(`/api/v1/scenes/${sceneId}/apply`);
      expect(res.status).toBe(200);
      await drain(res);

      // Operator 1 clicked Apply; operator 2 never touched anything — both are TOLD, over the same
      // WS broadcast that carries the re-laid wall. No refetch, no reload.
      await waitForActive(operator1, sceneId, "operator 1 sees the scene active");
      await waitForActive(operator2, sceneId, "operator 2 sees the scene active");

      // A reloaded tab (a brand-new connection) agrees — the badge is not session state.
      const reloaded = await freshSnapshot("a reloaded console");
      expect(reloaded.activeSceneId).toBe(sceneId);

      // ...and so does the desired state itself.
      const desired = (await (await fetch(`${BASE}/api/v1/state`)).json()) as Frame;
      expect(desired.activeSceneId).toBe(sceneId);
    },
    TEST_TIMEOUT,
  );

  test(
    "a second operator's manual change clears the badge on EVERY console",
    async () => {
      // Operator 2 drops other content on screen A — the wall is no longer the scene.
      const res = await putJson(`/api/v1/screens/${screenA}/content`, { url: MANUAL_URL });
      expect(res.status).toBe(200);
      await drain(res);

      await waitForActive(operator1, null, "operator 1's badge goes out");
      await waitForActive(operator2, null, "operator 2's badge goes out");

      const reloaded = await freshSnapshot("a console reloaded after the divergence");
      expect(reloaded.activeSceneId ?? null).toBeNull();
    },
    TEST_TIMEOUT,
  );
});

describe("POL-95 — the apply-preview diff", () => {
  test(
    "GET /scenes/:id/diff previews what the apply would change (content, from → to)",
    async () => {
      const res = await fetch(`${BASE}/api/v1/scenes/${sceneId}/diff`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Frame;
      const diff = body.diff;

      expect(diff.sceneId).toBe(sceneId);
      expect(diff.identical).toBe(false);
      expect(diff.summary.contentChanges).toBe(1);

      const entry = diff.entries.find((e: Frame) => e.id === screenA);
      expect(entry).toBeDefined();
      expect(entry.target).toBe("screen");
      expect(entry.changes).toContain("content");
      // The read-out names things the way an operator does: the ad-hoc url it shows now → the LIBRARY
      // SOURCE'S NAME it would show after the apply.
      expect(entry.from.url).toBe(MANUAL_URL);
      expect(entry.to.sourceId).toBe(sourceId);
      expect(entry.to.label).toBe(LIB_NAME);
      expect(diff.warnings.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "re-applying makes the diff IDENTICAL — the preview and the badge cannot disagree",
    async () => {
      const res = await postJson(`/api/v1/scenes/${sceneId}/apply`);
      expect(res.status).toBe(200);
      await drain(res);
      await waitForActive(operator1, sceneId, "the badge is back");

      const diffRes = await fetch(`${BASE}/api/v1/scenes/${sceneId}/diff`);
      expect(diffRes.status).toBe(200);
      const diff = ((await diffRes.json()) as Frame).diff;
      expect(diff.identical).toBe(true);
      expect(diff.entries.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "combining two screens is previewed as a COMBINE (and clears the badge as a divergence)",
    async () => {
      const combine = await postJson(`/api/v1/murals/${muralId}/walls`, {
        muralId,
        memberScreenIds: [screenA, screenB],
      });
      expect(combine.status).toBeGreaterThanOrEqual(200);
      expect(combine.status).toBeLessThan(300);
      await drain(combine);

      await waitForActive(operator1, null, "combining diverges the wall from the scene");

      const diff = ((await (await fetch(`${BASE}/api/v1/scenes/${sceneId}/diff`)).json()) as Frame)
        .diff;
      // The scene has no walls, so applying it would SPLIT the one we just made.
      expect(diff.summary.splits).toBe(1);
      const splitEntry = diff.entries.find((e: Frame) => e.changes.includes("split"));
      expect(splitEntry.target).toBe("wall");
      expect(splitEntry.screenIds.sort()).toEqual([screenA, screenB].sort());
    },
    TEST_TIMEOUT,
  );

  test(
    "the diff of an unknown scene is a 404",
    async () => {
      const res = await fetch(`${BASE}/api/v1/scenes/scene-does-not-exist/diff`);
      expect(res.status).toBe(404);
      await drain(res);
    },
    TEST_TIMEOUT,
  );
});
