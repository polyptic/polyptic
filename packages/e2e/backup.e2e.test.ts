/**
 * @polyptic/e2e — POL-113 BACKUP / RESTORE against two REAL control planes.
 *
 * The disaster-recovery claim, end to end and for real: a deployment's configuration is exported to a
 * portable document, and a DIFFERENT, EMPTY deployment restores it and comes up with the same wall.
 *
 * Stack A (:8211) is furnished the way an operator would furnish it, over REST:
 *   - one fake agent with three outputs → three screens, renamed;
 *   - a credential profile (with a client secret the export must never carry);
 *   - a library: an authenticated dashboard + an image;
 *   - screens A+B placed adjacent and COMBINED into a wall spanning the dashboard;
 *   - screen C placed alone, showing the image;
 *   - a scene snapshotting the lot.
 *
 * Then:
 *   - GET  /api/v1/export           → the document; the client secret is nowhere in it, machines are
 *                                     nowhere in it, and it says what it left out;
 *   - Stack B (:8212, fresh memory store, NO agent):
 *       POST /api/v1/import dryRun  → a plan of pure CREATES, reporting that none of these screens'
 *                                     machines are enrolled here and that the profile needs a secret;
 *       POST /api/v1/import         → applies it: B's admin/state now carries the same murals,
 *                                     screens, walls, scenes and library as A;
 *       the same agent then dials into B and ADOPTS its screens (same ids, same names) — its players
 *       get a `server/render` with the RESTORED content (a span surface on A+B, the image on C). This
 *       is the "a restore must not strand a wall" clause: the fan-out is the ordinary instant push.
 *   - a NON-EMPTY restore on B: drift it (rename the mural, add a source), dry-run in `replace` mode →
 *     the diff names the deletion, and the apply performs exactly the promised changes.
 *
 * Own ports, own memory stores, independent of every other suite.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT_A = 8211;
const PORT_B = 8212;
const A = `http://localhost:${PORT_A}`;
const B = `http://localhost:${PORT_B}`;
const WS_B = `ws://localhost:${PORT_B}`;

const MACHINE_ID = "backup-host-1";
const RES_W = 1920;
const RES_H = 1080;
const CONN_A = "HDMI-1";
const CONN_B = "HDMI-2";
const CONN_C = "HDMI-3";

const CLIENT_SECRET = "backup-e2e-client-secret-must-never-be-exported";
const DASH_URL = "https://grafana.example.com/d/ops-overview";
const IMAGE_URL = "https://cdn.example.com/lobby.png";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Frame = any;

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client: never miss a frame between awaits.
// ─────────────────────────────────────────────────────────────────────────────

interface Waiter {
  pred: (m: Frame) => boolean;
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

// ─────────────────────────────────────────────────────────────────────────────
// REST + wire helpers
// ─────────────────────────────────────────────────────────────────────────────

async function post(base: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function put(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(base: string, path: string): Promise<Frame> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (await res.json()) as Frame;
}

async function postJson(base: string, path: string, body: unknown): Promise<Frame> {
  const res = await post(base, path, body);
  const json = (await res.json()) as Frame;
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

function agentHello(outputs: Array<{ connector: string; width: number; height: number }>): unknown {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId: MACHINE_ID,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs,
  };
}

const OUTPUTS = [
  { connector: CONN_A, width: RES_W, height: RES_H },
  { connector: CONN_B, width: RES_W, height: RES_H },
  { connector: CONN_C, width: RES_W, height: RES_H },
];

async function adminState(base: string, wsBase: string): Promise<Frame> {
  const admin = await WsClient.connect(`${wsBase}/admin`);
  admin.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  const state = await admin.waitFor((m) => m.t === "admin/state", "admin/state");
  admin.close();
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Two server processes
// ─────────────────────────────────────────────────────────────────────────────

const procs: Array<ReturnType<typeof Bun.spawn>> = [];
const clients: WsClient[] = [];

function spawnServer(port: number): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(port),
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
      AUTH_ENABLED: "false",
      // Each stack owns its own media dir, so B genuinely does not hold A's uploads.
      MEDIA_DIR: `/tmp/polyptic-e2e-backup-${port}`,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  procs.push(proc);
  return proc;
}

async function waitForServer(base: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/v1/state`);
      if (res.ok) {
        await drain(res);
        return;
      }
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${base}: ${lastErr}`);
}

// Shared across the ordered flow.
let screenA = "";
let screenB = "";
let screenC = "";
let muralId = "";
let wallId = "";
let dashSourceId = "";
let imageSourceId = "";
let backup: Frame;

beforeAll(async () => {
  spawnServer(PORT_A);
  spawnServer(PORT_B);
  await waitForServer(A);
  await waitForServer(B);

  // ── Furnish stack A the way an operator would ──────────────────────────────
  const agent = await WsClient.connect(`ws://localhost:${PORT_A}/agent`);
  clients.push(agent);
  agent.send(agentHello(OUTPUTS));
  const apply = await agent.waitFor((m) => m.t === "server/apply", "server/apply on A");
  const byConnector = new Map<string, string>(
    (apply.screens as Frame[]).map((s) => [s.connector as string, s.screenId as string]),
  );
  screenA = byConnector.get(CONN_A)!;
  screenB = byConnector.get(CONN_B)!;
  screenC = byConnector.get(CONN_C)!;

  await drain(await post(A, `/api/v1/screens/${screenA}/rename`, { friendlyName: "Atrium Left" }));
  await drain(await post(A, `/api/v1/screens/${screenB}/rename`, { friendlyName: "Atrium Right" }));
  await drain(await post(A, `/api/v1/screens/${screenC}/rename`, { friendlyName: "Reception" }));

  const profile = await postJson(A, "/api/v1/credential-profiles", {
    name: "Grafana",
    tokenEndpoint: "https://idp.example.com/token",
    clientId: "polyptic",
    clientSecret: CLIENT_SECRET,
  });
  expect(profile.profile.id).toBeTruthy();

  const dash = await postJson(A, "/api/v1/content-sources", {
    name: "Ops dashboard",
    kind: "dashboard",
    url: DASH_URL,
    credentialProfileId: profile.profile.id,
  });
  dashSourceId = dash.source.id;

  const image = await postJson(A, "/api/v1/content-sources", {
    name: "Lobby image",
    kind: "image",
    url: IMAGE_URL,
  });
  imageSourceId = image.source.id;

  const state = await adminState(A, `ws://localhost:${PORT_A}`);
  muralId = state.murals[0].id;

  await drain(await put(A, `/api/v1/screens/${screenA}/placement`, { muralId, x: 0, y: 0 }));
  await drain(await put(A, `/api/v1/screens/${screenB}/placement`, { muralId, x: RES_W, y: 0 }));
  await drain(await put(A, `/api/v1/screens/${screenC}/placement`, { muralId, x: 4000, y: 0 }));

  const wall = await postJson(A, `/api/v1/murals/${muralId}/walls`, {
    muralId,
    memberScreenIds: [screenA, screenB],
    name: "Atrium Wall",
  });
  wallId = wall.wall.id;

  await drain(await put(A, `/api/v1/walls/${wallId}/content`, { sourceId: dashSourceId }));
  await drain(await put(A, `/api/v1/screens/${screenC}/content`, { sourceId: imageSourceId }));
  await postJson(A, "/api/v1/scenes", { name: "Opening", muralId });
}, 40_000);

afterAll(() => {
  for (const client of clients) client.close();
  for (const proc of procs) proc.kill();
});

test("GET /export returns a portable, version-stamped document with no secret in it", async () => {
  const res = await fetch(`${A}/api/v1/export`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toContain("polyptic-backup-");
  const raw = await res.text();

  // The load-bearing guarantee: the client secret is nowhere in the bytes that leave the building.
  expect(raw).not.toContain(CLIENT_SECRET);
  expect(raw).not.toContain("clientSecret");

  backup = JSON.parse(raw) as Frame;
  expect(backup.polypticBackup).toBe(1);
  expect(backup.generator.product).toBe("polyptic");
  expect(backup.murals).toHaveLength(1);
  expect(backup.screens.map((s: Frame) => s.friendlyName).sort()).toEqual([
    "Atrium Left",
    "Atrium Right",
    "Reception",
  ]);
  expect(backup.videoWalls).toHaveLength(1);
  expect(backup.videoWalls[0].content).toEqual({ sourceId: dashSourceId });
  expect(backup.contentSources).toHaveLength(2);
  expect(backup.scenes).toHaveLength(1);
  expect(backup.credentialProfiles[0].secretExcluded).toBe(true);

  // Machines are NOT in it (they are per-box identity), and the file says so in plain English.
  expect(Object.keys(backup)).not.toContain("machines");
  expect(backup.notIncluded.join(" ")).toContain("Machines");
  expect(backup.notIncluded.join(" ")).toContain("Secrets");
});

test("the dry run on an EMPTY stack B plans pure creates and names what it can't bring", async () => {
  const plan = await postJson(B, "/api/v1/import", { document: backup, dryRun: true });

  expect(plan.dryRun).toBe(true);
  expect(plan.mode).toBe("merge");
  expect(plan.summary.delete).toBe(0);
  expect(plan.summary.create).toBeGreaterThan(0);

  // No machine of ours is enrolled on B — every screen is reported, and imported anyway.
  expect(plan.screensWithoutMachine.sort()).toEqual([screenA, screenB, screenC].sort());
  // The secret could not travel, so the profile is named as needing one.
  expect(plan.credentialProfilesNeedingSecret).toEqual(["Grafana"]);

  // A dry run writes NOTHING: B still has no screens, no walls, no library.
  const state = await adminState(B, WS_B);
  expect(state.machines).toHaveLength(0);
  expect(state.videoWalls).toHaveLength(0);
  expect(state.contentSources).toHaveLength(0);
  expect(state.scenes).toHaveLength(0);
});

test("POST /import reproduces the murals, screens, walls, scenes and content on stack B", async () => {
  const result = await postJson(B, "/api/v1/import", { document: backup });
  expect(result.dryRun).toBe(false);
  expect(result.summary.delete).toBe(0);

  const state = await adminState(B, WS_B);
  expect(state.murals[0].id).toBe(muralId);
  expect(state.placements).toHaveLength(3);
  expect(state.videoWalls).toHaveLength(1);
  expect(state.videoWalls[0].id).toBe(wallId);
  expect(state.videoWalls[0].name).toBe("Atrium Wall");
  expect(state.videoWalls[0].memberScreenIds).toEqual([screenA, screenB]);
  expect(state.contentSources.map((s: Frame) => s.name).sort()).toEqual([
    "Lobby image",
    "Ops dashboard",
  ]);
  expect(state.scenes.map((s: Frame) => s.name)).toEqual(["Opening"]);
  expect(state.credentialProfiles.map((p: Frame) => p.name)).toEqual(["Grafana"]);

  // The screens exist by NAME and ID even though no machine of ours has ever dialled into B.
  const screens = (state.machines as Frame[]).flatMap((m) => m.screens as Frame[]);
  expect(screens).toHaveLength(0); // …they are not on a live machine yet

  const desired = await getJson(B, "/api/v1/state");
  expect((desired.screens as Frame[]).map((s) => s.friendlyName).sort()).toEqual([
    "Atrium Left",
    "Atrium Right",
    "Reception",
  ]);

  // And the wall's content is already on the restored slices — spanning surfaces, ready to render.
  const sliceA = desired.slices[screenA];
  expect(sliceA.surfaces[0].type).toBe("dashboard");
  expect(sliceA.surfaces[0].url).toBe(DASH_URL);
  expect(sliceA.surfaces[0].span).toBeDefined();
  expect(desired.slices[screenC].surfaces[0].type).toBe("image");
  expect(desired.slices[screenC].surfaces[0].src).toBe(IMAGE_URL);
});

test("the box dials into stack B, ADOPTS its restored screens, and the wall renders — nothing stranded", async () => {
  const agent = await WsClient.connect(`ws://localhost:${PORT_B}/agent`);
  clients.push(agent);
  agent.send(agentHello(OUTPUTS));
  const apply = await agent.waitFor((m) => m.t === "server/apply", "server/apply on B");

  // Same ids: the machine adopted the screens the RESTORE created, rather than minting new ones.
  const adopted = new Map<string, string>(
    (apply.screens as Frame[]).map((s) => [s.connector as string, s.screenId as string]),
  );
  expect(adopted.get(CONN_A)).toBe(screenA);
  expect(adopted.get(CONN_B)).toBe(screenB);
  expect(adopted.get(CONN_C)).toBe(screenC);

  const state = await adminState(B, WS_B);
  const machine = (state.machines as Frame[]).find((m) => m.id === MACHINE_ID)!;
  expect((machine.screens as Frame[]).map((s) => s.friendlyName).sort()).toEqual([
    "Atrium Left",
    "Atrium Right",
    "Reception",
  ]);

  // A player for a wall member gets the RESTORED span content on its very first render.
  const player = await WsClient.connect(`${WS_B}/player`);
  clients.push(player);
  player.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId: screenA });
  const render = await player.waitFor(
    (m) => m.t === "server/render" && m.slice?.screenId === screenA,
    "restored render",
  );
  const surface = render.slice.surfaces[0];
  expect(surface.type).toBe("dashboard");
  expect(surface.url).toContain(DASH_URL); // (a stamped auth token may be appended — POL-24)
  expect(surface.span.contentW).toBe(RES_W * 2);
  expect(surface.span.contentH).toBe(RES_H);
  expect(render.friendlyName).toBe("Atrium Left");
});

test("a restore into a NON-EMPTY stack shows the deletions first, then performs exactly them", async () => {
  // Drift stack B away from the backup.
  await drain(await post(B, `/api/v1/murals/${muralId}/rename`, { name: "Renamed locally" }));
  const extra = await postJson(B, "/api/v1/content-sources", {
    name: "Local only",
    kind: "web",
    url: "https://local.example.com/only-here",
  });

  // Merge mode never deletes; replace mode does, and says exactly what.
  const mergePlan = await postJson(B, "/api/v1/import", { document: backup, dryRun: true });
  expect(mergePlan.summary.delete).toBe(0);

  const replacePlan = await postJson(B, "/api/v1/import", {
    document: backup,
    mode: "replace",
    dryRun: true,
  });
  const deletions = (replacePlan.changes as Frame[]).filter((c) => c.action === "delete");
  expect(deletions.map((c) => c.id)).toEqual([extra.source.id]);
  expect(deletions[0].entity).toBe("contentSource");
  expect((replacePlan.changes as Frame[]).find((c) => c.entity === "mural")!.action).toBe("update");

  // The dry run changed nothing.
  let state = await adminState(B, WS_B);
  expect(state.murals[0].name).toBe("Renamed locally");
  expect(state.contentSources).toHaveLength(3);

  // Apply: exactly the promised plan.
  const applied = await postJson(B, "/api/v1/import", { document: backup, mode: "replace" });
  expect(applied.changes).toEqual(replacePlan.changes);
  expect(applied.summary).toEqual(replacePlan.summary);

  state = await adminState(B, WS_B);
  expect(state.murals[0].name).toBe("Wall");
  expect(state.contentSources.map((s: Frame) => s.name).sort()).toEqual([
    "Lobby image",
    "Ops dashboard",
  ]);
  expect(state.videoWalls[0].memberScreenIds).toEqual([screenA, screenB]);
});

test("a document from an unknown future format is REFUSED, not half-applied", async () => {
  const res = await post(B, "/api/v1/import", {
    document: { ...backup, polypticBackup: 99 },
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as Frame;
  expect(body.error).toContain("unsupported backup format");
});
