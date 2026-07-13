/**
 * @polyptic/e2e — PLAYER-CHANNEL ACCESS CONTROL suite (POL-54) against the live control plane.
 *
 * THE GAP THIS PINS SHUT: /player was completely ungated — anyone who could reach the server could
 * send `player/hello {screenId}` and receive that screen's full slice, live, forever. A slice is not
 * public: web/dashboard URLs are credential-stamped at send time (`?auth_token=`, POL-24), so the
 * open channel leaked live IdP tokens to anyone on the network, let outsiders mark screens ONLINE in
 * the console, and let them spoof `player/ack` revisions.
 *
 * THE FIX UNDER TEST: the server mints a per-screen bearer token (HMAC of a persisted per-deployment
 * secret) into every `playerUrl` it hands an agent (`server/apply`); the player echoes it in
 * `player/hello`; the channel admits only the matching (screenId, token) pair. Enforcement rides
 * AUTH_ENABLED — the switch that already gates REST and the /admin WS.
 *
 * TWO REAL SERVERS, spawned like the netboot suite's OPEN/GATED pair:
 *   :8121 GATED  — AUTH_ENABLED left unset (secure-by-default = ON). Proves the gate:
 *     1. `server/apply` playerUrls carry `?token=` — the legit boot chain needs no extra step.
 *     2. hello with NO token   → closed 4401, no render, and the screen never reads online.
 *     3. hello with a WRONG token → closed 4401, no render.
 *     4. hello with screen A's token claiming screen B → closed 4401 (a token scopes ONE screen).
 *     5. hello with the right token → server/render + server/settings (the normal boot).
 *     6. reconnect with the SAME token (reload / WS blip) → render again — the wall never dies
 *        because a token "aged out"; tokens don't age (that is the design).
 *   :8122 DEV-OPEN — AUTH_ENABLED=false. Proves nothing regressed for dev workflows:
 *     7. a tokenless hello (the paste-a-URL dev flow) is admitted and rendered.
 *     8. playerUrls STILL carry tokens (so flipping auth on later needs no re-enrolment).
 *     9. the per-socket screen BINDING holds even with auth off: a player admitted for screen A
 *        cannot ack/diag in screen B's name (dropped, snapshot unchanged), and a re-hello for a
 *        different screen closes the socket (4400).
 *
 * SECURITY DISCIPLINE: token VALUES are treated as opaque bearer secrets — asserted on presence,
 * equality of behaviour, and status codes, never logged.
 *
 * Ports: 8090–8117 belong to the other suites; this one owns 8121 + 8122.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const GATED_PORT = 8121;
const OPEN_PORT = 8122;
const TEST_TIMEOUT = 15_000;

const GATED_WS = `ws://localhost:${GATED_PORT}`;
const OPEN_WS = `ws://localhost:${OPEN_PORT}`;

const GATED_MACHINE = "player-auth-gated-1";
const OPEN_MACHINE = "player-auth-open-1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client (the house pattern): never miss a frame between awaits,
// and — new here — record the close event so a REJECTION is assertable.
// ─────────────────────────────────────────────────────────────────────────────

type Frame = any;
type Predicate = (m: Frame) => boolean;

interface Waiter {
  pred: Predicate;
  resolve: (m: Frame) => void;
  timer: ReturnType<typeof setTimeout>;
  label: string;
}

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: Waiter[] = [];
  /** Resolves with the close code when the SERVER (or anyone) closes this socket. */
  readonly closed: Promise<number>;
  private closeCode: number | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: { data: unknown }) => this.ingest(ev.data));
    this.closed = new Promise<number>((resolveClose) => {
      ws.addEventListener("close", (ev: { code: number }) => {
        this.closeCode = ev.code;
        resolveClose(ev.code);
      });
    });
  }

  static connect(url: string, timeoutMs = 5_000): Promise<WsClient> {
    return new Promise<WsClient>((resolveConn, rejectConn) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        rejectConn(err instanceof Error ? err : new Error(String(err)));
        return;
      }
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
      return; // never trust a malformed frame
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

  waitFor(pred: Predicate, label = "frame", timeoutMs = 3_000): Promise<Frame> {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise<Frame>((resolveMsg, rejectMsg) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        rejectMsg(new Error(`timed out waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolveMsg, timer, label });
    });
  }

  /** True if a frame matching `pred` is sitting in the buffer (no waiting). */
  received(pred: Predicate): boolean {
    return this.queue.some(pred);
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  get closeCodeOrNull(): number | null {
    return this.closeCode;
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
// Wire-shape builders
// ─────────────────────────────────────────────────────────────────────────────

function agentHello(machineId: string, connectors: string[]): unknown {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: connectors.map((connector) => ({ connector, width: 1920, height: 1080 })),
  };
}

function playerHello(screenId: string, token?: string): unknown {
  return {
    t: "player/hello",
    protocol: PROTOCOL_VERSION,
    screenId,
    ...(token ? { token } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Server lifecycle — two processes, spawned once, torn down in afterAll.
// ─────────────────────────────────────────────────────────────────────────────

let gatedProc: ReturnType<typeof Bun.spawn> | null = null;
let openProc: ReturnType<typeof Bun.spawn> | null = null;
const openClients: WsClient[] = [];

async function waitForServer(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      // /healthz is ungated on both servers (the gated one 401s /api/v1 without a cookie).
      const res = await fetch(`http://localhost:${port}/healthz`);
      await res.body?.cancel();
      if (res.ok) return;
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on :${port}: ${lastErr}`);
}

function spawnServer(port: number, authEnabled: boolean): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(port),
      // No POLYPTIC_BOOTSTRAP_TOKEN → OPEN enrolment: the fake agent is auto-approved. The player
      // gate is INDEPENDENT of enrolment mode — it rides AUTH_ENABLED, like REST and /admin.
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
      // The gated server leaves AUTH_ENABLED unset → secure-by-default = ON (the auth.e2e pattern).
      ...(authEnabled ? {} : { AUTH_ENABLED: "false" }),
      ...(authEnabled ? { COOKIE_SECRET: "player-auth-e2e-cookie-secret" } : {}),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
}

/** Enrol a fake agent and return connector → {screenId, playerUrl} from its server/apply. */
async function enrolAgent(
  wsBase: string,
  machineId: string,
  connectors: string[],
): Promise<Map<string, { screenId: string; playerUrl: string }>> {
  const agent = await WsClient.connect(`${wsBase}/agent`);
  openClients.push(agent);
  agent.send(agentHello(machineId, connectors));
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === machineId,
    `server/apply for ${machineId}`,
    5_000,
  );
  const byConnector = new Map<string, { screenId: string; playerUrl: string }>();
  for (const s of apply.screens as Frame[]) {
    byConnector.set(s.connector, { screenId: s.screenId, playerUrl: s.playerUrl });
  }
  expect(byConnector.size).toBe(connectors.length);
  return byConnector;
}

/** The `?token=` a server/apply playerUrl carries (undefined when absent). */
function tokenOf(playerUrl: string): string | undefined {
  return new URL(playerUrl).searchParams.get("token") ?? undefined;
}

/** A fresh admin snapshot's screens, flattened across machines (ScreenView lives on MachineView).
 *  Only used against the DEV-OPEN server, whose /admin WS is ungated (AUTH_ENABLED=false). */
async function adminScreens(): Promise<Frame[]> {
  const admin = await WsClient.connect(`${OPEN_WS}/admin`);
  openClients.push(admin);
  const state = await admin.waitFor((m) => m.t === "admin/state", "admin snapshot", 4_000);
  admin.close();
  return (state.machines as Frame[]).flatMap((m) => (m.screens as Frame[]) ?? []);
}

// Shared across the ordered flow (bun runs tests in source order, sequentially).
let gatedA = { screenId: "", playerUrl: "" }; // gated server, HDMI-1
let gatedB = { screenId: "", playerUrl: "" }; // gated server, HDMI-2
let openA = { screenId: "", playerUrl: "" }; // dev-open server, HDMI-1
let openB = { screenId: "", playerUrl: "" }; // dev-open server, HDMI-2

beforeAll(async () => {
  gatedProc = spawnServer(GATED_PORT, true);
  openProc = spawnServer(OPEN_PORT, false);
  await waitForServer(GATED_PORT);
  await waitForServer(OPEN_PORT);

  const gated = await enrolAgent(GATED_WS, GATED_MACHINE, ["HDMI-1", "HDMI-2"]);
  gatedA = gated.get("HDMI-1")!;
  gatedB = gated.get("HDMI-2")!;

  const open = await enrolAgent(OPEN_WS, OPEN_MACHINE, ["HDMI-1", "HDMI-2"]);
  openA = open.get("HDMI-1")!;
  openB = open.get("HDMI-2")!;
}, 40_000);

afterAll(async () => {
  for (const c of openClients) c.close();
  for (const proc of [gatedProc, openProc]) {
    if (!proc) continue;
    proc.kill();
    try {
      await proc.exited;
    } catch {
      /* already gone */
    }
  }
}, 10_000);

// ─────────────────────────────────────────────────────────────────────────────
// GATED server (:8121) — the POL-54 gate itself
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-54 gated /player (AUTH default-on)", () => {
  test(
    "server/apply playerUrls carry the per-screen token — the legit boot chain is automatic",
    () => {
      // Presence + shape only; the value is a bearer secret and stays out of assertions/logs.
      for (const { playerUrl, screenId } of [gatedA, gatedB]) {
        const url = new URL(playerUrl);
        expect(url.searchParams.get("screen")).toBe(screenId);
        expect(tokenOf(playerUrl)).toMatch(/^[0-9a-f]{64}$/);
      }
      // Per-screen: the two screens' tokens differ (one leaked token scopes ONE screen).
      expect(tokenOf(gatedA.playerUrl)).not.toBe(tokenOf(gatedB.playerUrl));
    },
    TEST_TIMEOUT,
  );

  test(
    "hello with NO token → closed 4401, and no render ever arrives",
    async () => {
      const intruder = await WsClient.connect(`${GATED_WS}/player`);
      openClients.push(intruder);
      intruder.send(playerHello(gatedA.screenId));
      const code = await intruder.closed;
      expect(code).toBe(4401);
      expect(intruder.received((m) => m.t === "server/render")).toBe(false);
      expect(intruder.received((m) => m.t === "server/settings")).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "hello with a WRONG token → closed 4401, no render",
    async () => {
      const intruder = await WsClient.connect(`${GATED_WS}/player`);
      openClients.push(intruder);
      intruder.send(playerHello(gatedA.screenId, "f".repeat(64)));
      expect(await intruder.closed).toBe(4401);
      expect(intruder.received((m) => m.t === "server/render")).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "screen A's token does NOT admit screen B (a token authorizes exactly one screen)",
    async () => {
      const intruder = await WsClient.connect(`${GATED_WS}/player`);
      openClients.push(intruder);
      intruder.send(playerHello(gatedB.screenId, tokenOf(gatedA.playerUrl)));
      expect(await intruder.closed).toBe(4401);
      expect(intruder.received((m) => m.t === "server/render")).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "the legit boot: hello with the minted token → server/render + server/settings",
    async () => {
      const player = await WsClient.connect(`${GATED_WS}/player`);
      openClients.push(player);
      player.send(playerHello(gatedA.screenId, tokenOf(gatedA.playerUrl)));
      const render = await player.waitFor(
        (m) => m.t === "server/render" && m.slice?.screenId === gatedA.screenId,
        "initial render on the gated server",
        5_000,
      );
      expect(typeof render.friendlyName).toBe("string");
      await player.waitFor((m) => m.t === "server/settings", "settings after first render");
      player.close();
    },
    TEST_TIMEOUT,
  );

  test(
    "reconnect/reload with the SAME token keeps working — tokens never age out under the wall",
    async () => {
      // Twice, sequentially: the same URL a box was launched with must repaint on every reconnect.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const player = await WsClient.connect(`${GATED_WS}/player`);
        openClients.push(player);
        player.send(playerHello(gatedA.screenId, tokenOf(gatedA.playerUrl)));
        await player.waitFor(
          (m) => m.t === "server/render" && m.slice?.screenId === gatedA.screenId,
          `render on reconnect #${attempt + 1}`,
          5_000,
        );
        player.close();
        await player.closed;
      }
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// DEV-OPEN server (:8122) — nothing regressed for dev, and the binding still holds
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-54 dev-open /player (AUTH_ENABLED=false)", () => {
  test(
    "a tokenless hello is admitted — the paste-a-player-URL dev workflow survives",
    async () => {
      const player = await WsClient.connect(`${OPEN_WS}/player`);
      openClients.push(player);
      player.send(playerHello(openA.screenId));
      await player.waitFor(
        (m) => m.t === "server/render" && m.slice?.screenId === openA.screenId,
        "tokenless render on the open server",
        5_000,
      );
      player.close();
    },
    TEST_TIMEOUT,
  );

  test(
    "playerUrls still carry tokens with auth off — flipping auth on later needs no re-enrolment",
    () => {
      expect(tokenOf(openA.playerUrl)).toMatch(/^[0-9a-f]{64}$/);
      expect(tokenOf(openB.playerUrl)).toMatch(/^[0-9a-f]{64}$/);
    },
    TEST_TIMEOUT,
  );

  test(
    "a socket admitted for screen A cannot ack in screen B's name (spoof dropped, snapshot unmoved)",
    async () => {
      const player = await WsClient.connect(`${OPEN_WS}/player`);
      openClients.push(player);
      player.send(playerHello(openA.screenId));
      const render = await player.waitFor(
        (m) => m.t === "server/render" && m.slice?.screenId === openA.screenId,
        "render for the binding test",
        5_000,
      );
      const revision = render.revision as number;

      // Spoof: A's socket acks a whopping revision in B's name. The frame must be DROPPED.
      player.send({ t: "player/ack", screenId: openB.screenId, revision: revision + 1000 });
      // Legit: A acks its own revision on its own socket.
      player.send({ t: "player/ack", screenId: openA.screenId, revision });
      await sleep(300); // let the server process both frames + broadcast

      // A fresh admin snapshot (ungated here) reflects current per-screen observed revisions.
      const screens = await adminScreens();
      const a = screens.find((s) => s.id === openA.screenId);
      const b = screens.find((s) => s.id === openB.screenId);
      expect(a?.revision).toBe(revision); // the legit ack landed
      expect(b?.revision ?? 0).not.toBe(revision + 1000); // the spoof did not
      player.close();
    },
    TEST_TIMEOUT,
  );

  test(
    "re-hello as a DIFFERENT screen on the same socket → closed 4400 (one socket, one screen)",
    async () => {
      const player = await WsClient.connect(`${OPEN_WS}/player`);
      openClients.push(player);
      player.send(playerHello(openA.screenId));
      await player.waitFor(
        (m) => m.t === "server/render" && m.slice?.screenId === openA.screenId,
        "render before the rebind attempt",
        5_000,
      );
      player.send(playerHello(openB.screenId));
      expect(await player.closed).toBe(4400);
    },
    TEST_TIMEOUT,
  );

  test(
    "an ack BEFORE any hello is dropped, not honoured",
    async () => {
      const stranger = await WsClient.connect(`${OPEN_WS}/player`);
      openClients.push(stranger);
      stranger.send({ t: "player/ack", screenId: openB.screenId, revision: 999_999 });
      await sleep(300);

      const screens = await adminScreens();
      const b = screens.find((s) => s.id === openB.screenId);
      expect(b?.revision ?? 0).not.toBe(999_999);
      stranger.close();
    },
    TEST_TIMEOUT,
  );
});
