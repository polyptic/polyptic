/**
 * POL-134 — agent mTLS is ON BY DEFAULT: the whole zero-config arc against the REAL server.
 *
 * We spawn `packages/server/src/index.ts` with NO AGENT_MTLS* configuration at all — exactly what a
 * fresh install runs — and drive a fake netbooted box through the cold-boot arc the ticket pins:
 *
 *   1. the boot log says the mTLS channel is up (`:8443 (migrating)`) with nothing configured;
 *   2. first contact: bootstrap token + CSR over the PLAIN channel → `server/enrolled` carries the
 *      cert bundle (zero-click cold boot survives — no operator step issued that cert);
 *   3. the box reconnects over `wss://:8443` presenting the cert → admitted (`server/apply`);
 *   4. the migration is narrated ("… now on mTLS") and — the fleet now being fully certified — the
 *      posture GRADUATES to required, announced in the feed and visible on the settings surface;
 *   5. the negative: once required, a certless-but-credentialed agent gets NO session on the plain
 *      channel (answered + closed), and the mTLS listener rejects a certless dial in the handshake.
 *
 * CAPABILITY GATES (skipped cleanly, never failed):
 *   - Bun ≤ 1.2 cannot verify client certs — the default-on server then degrades to off by design,
 *     so this suite only runs where the runtime verifies (CI's Bun ≥ 1.3).
 *   - The default port 8443 must be free on this host (it is the whole point of "zero config", so
 *     we cannot move it; a dev box with something on 8443 skips).
 *
 * Ports: this suite owns 8140 (+ the default 8443 mTLS listener). 8090–8122 / 8271–8272 belong to
 * the other suites.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createNetServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { PROTOCOL_VERSION } from "@polyptic/protocol";
import { generateKeyAndCsr } from "../agent/src/mtls";
import { AgentMtls } from "../server/src/mtls";
import { MemoryStore } from "../server/src/store/memory";

const PORT = 8140;
const MTLS_PORT = 8443; // the shipped default — the suite exists to prove ZERO config works
const BASE = `http://localhost:${PORT}`;
const BOOTSTRAP_TOKEN = "e2e-mtls-default-token";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Capability gates ─────────────────────────────────────────────────────────

/** Does THIS runtime actually verify client certs? (Bun ≤ 1.2 does not — see D82.) */
async function runtimeVerifiesClientCerts(): Promise<boolean> {
  const store = new MemoryStore();
  const mtls = await AgentMtls.init(store, { port: 0 });
  const server = mtls.createListener();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const verdict = await mtls.selfTest(port);
  server.close();
  return verdict.safe;
}

/** Is the shipped default port free here? We cannot move it — zero config IS the test. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const probe = createNetServer();
    probe.once("error", () => resolveFree(false));
    probe.listen(port, "127.0.0.1", () => {
      probe.close(() => resolveFree(true));
    });
  });
}

const runnable = (await runtimeVerifiesClientCerts()) && (await portFree(MTLS_PORT));

// ── Small drivers ────────────────────────────────────────────────────────────

interface HelloResult {
  frames: any[];
  closedByServer: boolean;
  error?: string;
}

/** One agent hello → collected replies, resolving on close or after `until` frames. */
function driveAgentHello(
  url: string,
  hello: Record<string, unknown>,
  opts?: { tls?: { key: string; cert: string; ca: string }; until?: number },
): Promise<HelloResult> {
  return new Promise((resolveHello) => {
    const wsOpts = opts?.tls ? ({ ...opts.tls, tls: opts.tls } as any) : undefined;
    const ws = wsOpts ? new WebSocket(url, wsOpts) : new WebSocket(url);
    const frames: any[] = [];
    let done = false;
    const finish = (closedByServer: boolean, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolveHello({ frames, closedByServer, error });
    };
    const timer = setTimeout(() => finish(false), 8_000);
    ws.on("open", () => ws.send(JSON.stringify(hello)));
    ws.on("message", (raw) => {
      frames.push(JSON.parse(raw.toString()));
      if (opts?.until && frames.length >= opts.until) finish(false);
    });
    ws.on("close", () => finish(true));
    ws.on("error", (err: Error) => finish(false, err.message));
  });
}

function agentHello(machineId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e-mtls",
    backend: "wayland-sway",
    outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
    hostname: machineId,
    bootstrapToken: BOOTSTRAP_TOKEN,
    ...extra,
  };
}

/** Raw TLS dial to the mTLS listener — true only when the server answers application data. */
function tlsAnswers(port: number, opts: { keyPem?: string; certPem?: string }): Promise<boolean> {
  return new Promise((resolveDial) => {
    let answered = false;
    const socket = tlsConnect(
      {
        host: "127.0.0.1",
        port,
        rejectUnauthorized: false,
        ...(opts.keyPem ? { key: opts.keyPem } : {}),
        ...(opts.certPem ? { cert: opts.certPem } : {}),
      },
      () => {
        socket.write("GET /probe HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n\r\n");
      },
    );
    const finish = (ok: boolean) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      socket.destroy();
      resolveDial(ok);
    };
    const timer = setTimeout(() => finish(false), 4_000);
    socket.on("data", () => finish(true));
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

/** One fresh /admin snapshot (AUTH_ENABLED=false → ungated), for the activity feed. */
function adminSnapshot(): Promise<any> {
  return new Promise((resolveSnap, rejectSnap) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/admin`);
    const timer = setTimeout(() => {
      ws.close();
      rejectSnap(new Error("no admin/state within 5s"));
    }, 5_000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === "admin/state") {
        clearTimeout(timer);
        ws.close();
        resolveSnap(msg);
      }
    });
    ws.on("error", (err: Error) => {
      clearTimeout(timer);
      rejectSnap(err);
    });
  });
}

async function agentSecurity(): Promise<any> {
  const res = await fetch(`${BASE}/api/v1/settings/agent-security`);
  expect(res.ok).toBe(true);
  return res.json();
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;
let bootLog = "";

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

describe.skipIf(!runnable)("POL-134 — mTLS default-on, end to end over real sockets", () => {
  beforeAll(async () => {
    // The RUNTIME matters here: the gate above proved THIS bun verifies client certs, so the server
    // must run on the same binary — a bare "bun" from PATH may be an older one that degrades to off.
    proc = Bun.spawn([process.execPath, serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        STORE: "memory",
        PORT: String(PORT),
        POLYPTIC_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
        PLAYER_BASE_URL: "http://localhost:5173",
        LOG_LEVEL: "info",
        AUTH_ENABLED: "false",
        // THE POINT: no AGENT_MTLS, no AGENT_MTLS_PORT, no AGENT_MTLS_REQUIRE. Scrub any that
        // leaked in from the invoking shell so the spawn is a true fresh install.
        AGENT_MTLS: undefined as unknown as string,
        AGENT_MTLS_PORT: undefined as unknown as string,
        AGENT_MTLS_REQUIRE: undefined as unknown as string,
      },
      stdout: "pipe",
      stderr: "inherit",
    });
    // Drain stdout continuously into bootLog (the boot-summary assertion reads it).
    void (async () => {
      const reader = (proc!.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bootLog += decoder.decode(value);
      }
    })();
    await waitForServer();
  }, 30_000);

  afterAll(async () => {
    if (proc) {
      proc.kill();
      try {
        await proc.exited;
      } catch {
        /* already gone */
      }
    }
  }, 10_000);

  let credential = "";
  let keyPem = "";
  let certPem = "";
  let caPem = "";

  test("with NOTHING configured, the boot log says the mTLS channel is up and migrating", async () => {
    // The log line lands before readiness returns, but give the pipe a beat to drain.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !bootLog.includes("mTLS agent channel up")) await sleep(100);
    expect(bootLog).toContain(`mTLS agent channel up on :${MTLS_PORT}`);
    expect(bootLog).toContain("migrating");

    const info = await agentSecurity();
    expect(info.mode).toBe("migrating");
    expect(info.port).toBe(MTLS_PORT);
    expect(info.pinned).toBe(false);
  });

  test("cold boot, zero clicks: token + CSR over plain → cert bundle; approve; reconnect over mTLS → apply", async () => {
    const generated = await generateKeyAndCsr("box-1");
    keyPem = generated.keyPem;

    // First contact — exactly what a netbooted box does with its baked token.
    const first = await driveAgentHello(`ws://localhost:${PORT}/agent`, agentHello("box-1", { csrPem: generated.csrPem }), {
      until: 2,
    });
    const enrolled = first.frames.find((f) => f.t === "server/enrolled");
    expect(enrolled).toBeDefined();
    expect(enrolled.status).toBe("pending");
    expect(typeof enrolled.credential).toBe("string");
    // The cert bundle rode the SAME hello — no operator step, no second round-trip.
    expect(enrolled.mtls?.certPem).toContain("BEGIN CERTIFICATE");
    expect(enrolled.mtls?.caPem).toContain("BEGIN CERTIFICATE");
    expect(enrolled.mtls?.port).toBe(MTLS_PORT);
    credential = enrolled.credential;
    certPem = enrolled.mtls.certPem;
    caPem = enrolled.mtls.caPem;

    // Operator approves (the one human step gated enrolment always had — not an mTLS step).
    const approve = await fetch(`${BASE}/api/v1/machines/box-1/approve`, { method: "POST" });
    expect(approve.ok).toBe(true);

    // The box reconnects over the DEFAULT mTLS port, presenting its cert → live session.
    const second = await driveAgentHello(
      `wss://localhost:${MTLS_PORT}/agent`,
      agentHello("box-1", { credential }),
      { tls: { key: keyPem, cert: certPem, ca: caPem }, until: 1 },
    );
    expect(second.error).toBeUndefined();
    expect(second.frames.some((f) => f.t === "server/apply")).toBe(true);
  });

  test("the migration is narrated, and a fully-certified fleet GRADUATES to required (announced)", async () => {
    // Promotion runs async off the mTLS hello — poll the settings surface for the graduation.
    const deadline = Date.now() + 8_000;
    let info = await agentSecurity();
    while (Date.now() < deadline && info.mode !== "required") {
      await sleep(200);
      info = await agentSecurity();
    }
    expect(info.mode).toBe("required");
    expect(info.requiredSince).toBeDefined();
    const box = info.machines.find((m: any) => m.id === "box-1");
    expect(box?.mtlsCertIssuedAt).toBeDefined();
    expect(box?.mtlsSeenAt).toBeDefined();

    const snapshot = await adminSnapshot();
    const feed: string[] = (snapshot.activity ?? []).map((e: any) => e.text);
    expect(feed.some((t) => t.includes("now on mTLS"))).toBe(true);
    expect(feed.some((t) => t.includes("mTLS is now required"))).toBe(true);
  });

  test("once required, a certless agent cannot open a session — but the first-contact door still issues", async () => {
    // A brand-new certless box: token hello with a CSR → enrolled + bundle, then CLOSED (no session).
    const fresh = await generateKeyAndCsr("box-2");
    const first = await driveAgentHello(`ws://localhost:${PORT}/agent`, agentHello("box-2", { csrPem: fresh.csrPem }));
    const enrolled = first.frames.find((f) => f.t === "server/enrolled");
    expect(enrolled?.mtls?.certPem).toContain("BEGIN CERTIFICATE");
    expect(first.frames.some((f) => f.t === "server/apply")).toBe(false);
    expect(first.closedByServer).toBe(true);

    // An approved, credentialed machine WITHOUT a cert: answered on plain, never admitted, closed.
    const approve = await fetch(`${BASE}/api/v1/machines/box-2/approve`, { method: "POST" });
    expect(approve.ok).toBe(true);
    const certless = await driveAgentHello(
      `ws://localhost:${PORT}/agent`,
      agentHello("box-2", { credential: enrolled.credential }),
    );
    expect(certless.frames.some((f) => f.t === "server/apply")).toBe(false);
    expect(certless.closedByServer).toBe(true);

    // And the mTLS listener without a client cert never gets past the handshake.
    expect(await tlsAnswers(MTLS_PORT, {})).toBe(false);

    // box-1's session survives all of this: it can still open a live mTLS session.
    const alive = await driveAgentHello(
      `wss://localhost:${MTLS_PORT}/agent`,
      agentHello("box-1", { credential }),
      { tls: { key: keyPem, cert: certPem, ca: caPem }, until: 1 },
    );
    expect(alive.frames.some((f) => f.t === "server/apply")).toBe(true);
  });

  test("the graduation PERSISTED onto the posture surface (pinned=false — it promoted itself)", async () => {
    const info = await agentSecurity();
    expect(info.mode).toBe("required");
    expect(info.pinned).toBe(false);
  });
});

// ── Finding pin: a REQUIRED deployment whose listener cannot start must NOT admit plain sessions.
// A zero-config fleet that graduated to require-mTLS, restarting while something holds :8443, must
// refuse to boot (crash loops are loud) rather than silently re-open plaintext agent sessions that
// self-healing agents would drift onto. Driven with the REAL server process: we occupy :8443
// ourselves and assert the required boot dies while the merely-default boot degrades and lives.
// (The persisted-row variant of the same decision — no pin, `agent_mtls_posture.required=true` —
// is pinned at the seam by mtlsStartupFailureIsFatal's unit tests: a memory-store spawn cannot
// carry a pre-persisted row across the process boundary.)
describe.skipIf(!runnable)("POL-134 — required posture + failed listener refuses to serve plain sessions", () => {
  let blocker: ReturnType<typeof createNetServer> | null = null;

  beforeAll(async () => {
    blocker = createNetServer();
    await new Promise<void>((r, j) => {
      blocker!.once("error", j);
      blocker!.listen(MTLS_PORT, "0.0.0.0", () => r());
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => (blocker ? blocker.close(() => r()) : r()));
  });

  async function bootWithBlockedPort(extraEnv: Record<string, string>, port: number): Promise<{
    exitCode: number | null;
    log: string;
    reachable: boolean;
    kill(): void;
  }> {
    const child = Bun.spawn([process.execPath, serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        STORE: "memory",
        PORT: String(port),
        POLYPTIC_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
        LOG_LEVEL: "info",
        AUTH_ENABLED: "false",
        AGENT_MTLS: undefined as unknown as string,
        AGENT_MTLS_PORT: undefined as unknown as string,
        AGENT_MTLS_REQUIRE: undefined as unknown as string,
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let log = "";
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        log += decoder.decode(value);
      }
    };
    void drain(child.stdout as ReadableStream<Uint8Array>);
    void drain(child.stderr as ReadableStream<Uint8Array>);

    // Wait until the process exits OR the API answers — whichever proves the outcome.
    const deadline = Date.now() + 15_000;
    let reachable = false;
    let exitCode: number | null = null;
    for (;;) {
      if (Date.now() > deadline) break;
      const exited = await Promise.race([child.exited.then((c) => c), sleep(200).then(() => null)]);
      if (exited !== null) {
        exitCode = exited;
        break;
      }
      try {
        const res = await fetch(`http://localhost:${port}/api/v1/state`);
        if (res.ok) {
          await res.body?.cancel();
          reachable = true;
          break;
        }
      } catch {
        // not up yet (or never will be)
      }
    }
    return { exitCode, log, reachable, kill: () => child.kill() };
  }

  test("required (pinned) + occupied :8443 → the server EXITS; no plain channel ever comes up", async () => {
    const run = await bootWithBlockedPort({ AGENT_MTLS_REQUIRE: "1" }, 8142);
    try {
      expect(run.reachable).toBe(false);
      expect(run.exitCode).toBe(1);
      expect(run.log).toContain("REQUIRES mTLS");
      expect(run.log).toContain("could not bind");
    } finally {
      run.kill();
    }
  }, 20_000);

  test("the CONTRAST: merely-default (not required) + occupied :8443 → degrades loudly and serves", async () => {
    const run = await bootWithBlockedPort({}, 8143);
    try {
      expect(run.reachable).toBe(true);
      expect(run.exitCode).toBe(null);
      expect(run.log).toContain("mtls.default.unavailable");
    } finally {
      run.kill();
    }
  }, 20_000);
});

// On a runtime that cannot verify client certs, or a host with :8443 occupied, say WHY we skipped.
describe.skipIf(runnable)("POL-134 default-on e2e (skipped)", () => {
  test("skipped: runtime cannot verify client certs (Bun ≤ 1.2) or port 8443 is occupied", () => {
    expect(runnable).toBe(false);
  });
});
