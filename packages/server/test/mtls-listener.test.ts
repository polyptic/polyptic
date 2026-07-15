/**
 * POL-25 — the mTLS agent channel, driven END TO END over real sockets: the TLS handshake matrix
 * (the transport-layer rejection the ticket demands), cert issuance over the plain channel, admission
 * over the mTLS channel, and the require-mode downgrade.
 *
 * CAPABILITY GATE: Bun ≤ 1.2 implements `requestCert` as presence-only — it accepts a client cert
 * from ANY CA (measured on 1.2.2), which is exactly the failure `AgentMtls.selfTest` exists to catch.
 * On such a runtime the only meaningful assertion is that the self-test says UNSAFE (so the server
 * refuses to offer mTLS); the full matrix runs on runtimes that actually verify (Bun ≥ 1.3).
 */
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { FastifyBaseLogger } from "fastify";

import { ActivityLog } from "../src/activity";
import { AdminBroadcaster, AdminHub, Presence } from "../src/admin";
import { CaptureCoordinator, ThumbnailStore } from "../src/capture";
import { DevtoolsRelay } from "../src/devtools-relay";
import { Enrollment } from "../src/enroll";
import { AgentHub, PlayerHub } from "../src/hub";
import { AgentMtls } from "../src/mtls";
import { PanelPowerScheduler } from "../src/panel-power";
import { PlayerAuth } from "../src/player-auth";
import { SourceHealthTracker } from "../src/source-health";
import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";
import { attachWebSockets } from "../src/ws";
import type { AgentMtlsChannel } from "../src/ws";
import type { AuthService } from "../src/auth-local";

const x509 = await import("@peculiar/x509");
x509.cryptoProvider.set(globalThis.crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const TOKEN = "test-bootstrap-token";

const noopLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as FastifyBaseLogger;

async function pemKey(key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey("pkcs8", key);
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64.trim()}\n-----END PRIVATE KEY-----\n`;
}

/** A client cert signed by a CA the server has never seen (same shape as a genuine one). */
async function rogueClientCert(): Promise<{ keyPem: string; certPem: string }> {
  const caKeys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Rogue CA",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3600_000),
    signingAlgorithm: ALG,
    keys: caKeys,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
  });
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=machine-1",
    issuer: ca.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3600_000),
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey: caKeys.privateKey,
  });
  return { keyPem: await pemKey(keys.privateKey), certPem: cert.toString("pem") };
}

/** Generate an agent-style keypair + CSR. */
async function keyAndCsr(cn: string): Promise<{ keyPem: string; csrPem: string }> {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${cn}`,
    keys,
    signingAlgorithm: ALG,
  });
  return { keyPem: await pemKey(keys.privateKey), csrPem: csr.toString("pem") };
}

/**
 * Raw TLS dial — resolves true only when the server ANSWERS application data. Under TLS 1.3 the
 * client-side handshake completes before the server judges the cert (the rejection is a
 * post-handshake alert), so `secureConnect` alone proves nothing.
 */
function tlsHandshake(port: number, opts: { keyPem?: string; certPem?: string }): Promise<boolean> {
  return new Promise((resolve) => {
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
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 4_000);
    socket.on("data", () => finish(true));
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

/** One hello → collected replies. Resolves when the socket closes or `until` frames arrive. */
function driveAgentHello(
  url: string,
  hello: Record<string, unknown>,
  opts?: { tls?: { key: string; cert: string; ca: string }; until?: number },
): Promise<{ frames: any[]; closedByServer: boolean; error?: string }> {
  return new Promise((resolve) => {
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
      resolve({ frames, closedByServer, error });
    };
    const timer = setTimeout(() => finish(false), 5_000);
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
    protocol: 1,
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
    hostname: "test-box",
    ...extra,
  };
}

/** The whole control-plane + two agent channels, small enough to build per describe block. */
interface Stack {
  plainUrl: string;
  mtlsUrl: string;
  mtlsPort: number;
  mtls: AgentMtls;
  control: ControlPlane;
  enrollment: Enrollment;
  activity: ActivityLog;
  /** POL-134 — flip the require posture mid-suite (what the auto-promotion does at runtime). */
  setRequire(value: boolean): void;
  close(): Promise<void>;
}

async function buildStack(require_: boolean): Promise<Stack> {
  const store = new MemoryStore();
  const activity = new ActivityLog();
  const control = new ControlPlane(store, activity);
  await control.init();
  const enrollment = new Enrollment(TOKEN);
  const hub = new PlayerHub();
  const agentHub = new AgentHub();
  const adminHub = new AdminHub();
  const presence = new Presence();
  const broadcaster = new AdminBroadcaster({ control, playerHub: hub, presence, adminHub, activity, log: noopLog });
  const capture = new CaptureCoordinator({
    control,
    agentHub,
    thumbnails: new ThumbnailStore(10),
    log: noopLog,
    intervalMs: 0,
  });
  // The agent channel never consults auth; a disabled stub keeps the test store-only.
  const auth = { enabled: false } as unknown as AuthService;

  const plainServer: HttpServer = createHttpServer();
  await new Promise<void>((r) => plainServer.listen(0, "127.0.0.1", () => r()));
  const plainPort = (plainServer.address() as { port: number }).port;

  const mtls = await AgentMtls.init(store, { port: 0 });
  const mtlsServer: HttpsServer = mtls.createListener();
  await new Promise<void>((r) => mtlsServer.listen(0, "127.0.0.1", () => r()));
  const mtlsPort = (mtlsServer.address() as { port: number }).port;

  // POL-134 — `required` became a live read (the posture self-promotes at runtime); the test drives
  // it through a mutable holder so a suite can flip the posture mid-flow.
  const requireState = { value: require_ };
  const agentMtls: AgentMtlsChannel = {
    server: mtlsServer,
    caPem: mtls.caPem,
    signCsr: (csrPem, machineId) => mtls.signCsr(csrPem, machineId),
    advertise: { port: mtlsPort },
    required: () => requireState.value,
    noteCertIssued: (machineId) => {
      void control.noteMachineCertIssued(machineId);
    },
    noteMtlsHello: (machineId) => {
      void (async () => {
        const first = await control.noteMachineMtlsSeen(machineId);
        if (first) {
          const label = control.getMachine(machineId)?.label ?? machineId;
          activity.push("good", `${label} now on mTLS`);
        }
      })();
    },
  };

  const devtoolsRelay = new DevtoolsRelay(agentHub, control, presence, activity, noopLog);
  const playerAuth = await PlayerAuth.init(store, false, noopLog);
  const health = new SourceHealthTracker();
  const panelPower = new PanelPowerScheduler({ control, agentHub, presence, activity, broadcaster, log: noopLog });

  attachWebSockets({
    server: plainServer,
    control,
    enrollment,
    auth,
    playerAuth,
    hub,
    agentHub,
    adminHub,
    presence,
    broadcaster,
    activity,
    capture,
    health,
    devtoolsRelay,
    panelPower,
    log: noopLog,
    allowedOrigins: [],
    agentMtls,
  });

  return {
    plainUrl: `ws://127.0.0.1:${plainPort}/agent`,
    mtlsUrl: `wss://localhost:${mtlsPort}/agent`,
    mtlsPort,
    mtls,
    control,
    enrollment,
    activity,
    setRequire: (value: boolean) => {
      requireState.value = value;
    },
    close: async () => {
      plainServer.close();
      mtlsServer.close();
    },
  };
}

// ── The capability gate: does THIS runtime verify client certs at all? ──────────────────────────
const gateStore = new MemoryStore();
const gateMtls = await AgentMtls.init(gateStore, { port: 0 });
const gateServer = gateMtls.createListener();
await new Promise<void>((r) => gateServer.listen(0, "127.0.0.1", () => r()));
const gatePort = (gateServer.address() as { port: number }).port;
const gateVerdict = await gateMtls.selfTest(gatePort);
gateServer.close();
const runtimeVerifies = gateVerdict.safe;

describe("mTLS self-test (every runtime)", () => {
  test(
    runtimeVerifies
      ? "this runtime verifies client certs — self-test passes"
      : "this runtime does NOT verify client certs — self-test must say so (the server then refuses to start mTLS)",
    () => {
      if (!runtimeVerifies) {
        // The load-bearing property on an unsafe runtime: the reason names the broken verification,
        // so the boot path exits instead of serving a fake gate.
        expect(gateVerdict.reason ?? "").toMatch(/does not (verify|enforce)/);
      } else {
        expect(gateVerdict.reason).toBeUndefined();
      }
    },
  );
});

describe.skipIf(!runtimeVerifies)("mTLS transport gate (handshake matrix)", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await buildStack(false);
  });
  afterAll(async () => {
    await stack.close();
  });

  test("a CA-signed client cert completes the handshake", async () => {
    const { keyPem, csrPem } = await keyAndCsr("machine-hs");
    const certPem = await stack.mtls.signCsr(csrPem, "machine-hs");
    expect(await tlsHandshake(stack.mtlsPort, { keyPem, certPem })).toBe(true);
  });

  test("NO client cert is rejected at the handshake — before any app code", async () => {
    expect(await tlsHandshake(stack.mtlsPort, {})).toBe(false);
  });

  test("a rogue-CA client cert is rejected at the handshake", async () => {
    const rogue = await rogueClientCert();
    expect(await tlsHandshake(stack.mtlsPort, { keyPem: rogue.keyPem, certPem: rogue.certPem })).toBe(false);
  });
});

describe.skipIf(!runtimeVerifies)("mTLS enrolment flow (roll-out mode)", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await buildStack(false);
  });
  afterAll(async () => {
    await stack.close();
  });

  test("token + CSR on the plain channel → enrolled carries credential AND cert bundle; approved machine then admits over mTLS", async () => {
    const { keyPem, csrPem } = await keyAndCsr("machine-1");

    // First contact: bootstrap token + CSR over the plain channel.
    const first = await driveAgentHello(stack.plainUrl, agentHello("machine-1", { bootstrapToken: TOKEN, csrPem }), {
      until: 2,
    });
    const enrolled = first.frames.find((f) => f.t === "server/enrolled");
    expect(enrolled).toBeDefined();
    expect(enrolled.status).toBe("pending");
    expect(typeof enrolled.credential).toBe("string");
    expect(enrolled.mtls?.certPem).toContain("BEGIN CERTIFICATE");
    expect(enrolled.mtls?.caPem).toBe(stack.mtls.caPem);
    expect(enrolled.mtls?.port).toBe(stack.mtlsPort);
    expect(first.frames.some((f) => f.t === "server/pending")).toBe(true);

    // Operator approves.
    await stack.control.approveMachine("machine-1");

    // Reconnect over the mTLS listener with the issued cert + durable credential → admitted.
    const second = await driveAgentHello(
      stack.mtlsUrl,
      agentHello("machine-1", { credential: enrolled.credential }),
      { tls: { key: keyPem, cert: enrolled.mtls.certPem, ca: stack.mtls.caPem }, until: 1 },
    );
    expect(second.error).toBeUndefined();
    const apply = second.frames.find((f) => f.t === "server/apply");
    expect(apply).toBeDefined();
    expect(apply.machineId).toBe("machine-1");
  });

  test("a fleet cert alone (no credential) does NOT admit — the app-level identity still gates", async () => {
    const { keyPem, csrPem } = await keyAndCsr("machine-2");
    const certPem = await stack.mtls.signCsr(csrPem, "machine-2");
    // machine-2 was never enrolled: valid transport cert, no token, no credential → rejected.
    const res = await driveAgentHello(stack.mtlsUrl, agentHello("machine-2"), {
      tls: { key: keyPem, cert: certPem, ca: stack.mtls.caPem },
      until: 1,
    });
    const rejected = res.frames.find((f) => f.t === "server/rejected");
    expect(rejected).toBeDefined();
  });
});

describe.skipIf(!runtimeVerifies)("POL-134 — migration is recorded + narrated, and require closes the certless door", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await buildStack(false);
  });
  afterAll(async () => {
    await stack.close();
  });

  test("a machine's first mTLS hello records mtlsSeenAt and narrates 'now on mTLS' in the feed", async () => {
    const { keyPem, csrPem } = await keyAndCsr("machine-mig");
    const first = await driveAgentHello(stack.plainUrl, agentHello("machine-mig", { bootstrapToken: TOKEN, csrPem }), {
      until: 2,
    });
    const enrolled = first.frames.find((f) => f.t === "server/enrolled");
    expect(enrolled?.mtls?.certPem).toContain("BEGIN CERTIFICATE");
    await stack.control.approveMachine("machine-mig");

    // Cert issuance was persisted onto the machine row (the Settings card's "cert issued" state).
    expect(stack.control.getMachine("machine-mig")?.mtlsCertIssuedAt).toBeDefined();
    expect(stack.control.getMachine("machine-mig")?.mtlsSeenAt).toBeUndefined();

    // The box comes back over the mTLS listener — the migration edge.
    const second = await driveAgentHello(
      stack.mtlsUrl,
      agentHello("machine-mig", { credential: enrolled.credential }),
      { tls: { key: keyPem, cert: enrolled.mtls.certPem, ca: stack.mtls.caPem }, until: 1 },
    );
    expect(second.frames.some((f) => f.t === "server/apply")).toBe(true);

    // noteMtlsHello runs async off the hello — poll briefly for the persisted edge.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !stack.control.getMachine("machine-mig")?.mtlsSeenAt) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stack.control.getMachine("machine-mig")?.mtlsSeenAt).toBeDefined();
    const feed = stack.activity.recent().map((e) => e.text);
    expect(feed.some((t) => t.includes("now on mTLS"))).toBe(true);
  });

  test("once required, a certless-but-credentialed machine gets NO session on the plain channel (and no cert without a CSR)", async () => {
    // The graduation: what MtlsPosture does once every known machine has been seen on mTLS.
    stack.setRequire(true);

    // Enrol a second machine the old-fashioned way (no CSR at all — an agent that cannot mTLS).
    const first = await driveAgentHello(stack.plainUrl, agentHello("machine-old", { bootstrapToken: TOKEN }));
    const enrolled = first.frames.find((f) => f.t === "server/enrolled");
    expect(enrolled?.mtls).toBeUndefined();
    expect(first.closedByServer).toBe(true);
    await stack.control.approveMachine("machine-old");

    // Approved + valid credential, still certless: answered, never admitted, closed.
    const retry = await driveAgentHello(stack.plainUrl, agentHello("machine-old", { credential: enrolled.credential }));
    expect(retry.frames.some((f) => f.t === "server/apply")).toBe(false);
    expect(retry.closedByServer).toBe(true);

    // And the mTLS listener without a cert is a handshake failure — no app frame ever flows.
    expect(await tlsHandshake(stack.mtlsPort, {})).toBe(false);

    // The first-contact door STAYS open under require: the same certless machine presenting a CSR
    // is handed a bundle (issue-only), which is exactly how it migrates itself out of the hole.
    const { csrPem } = await keyAndCsr("machine-old");
    const heal = await driveAgentHello(stack.plainUrl, agentHello("machine-old", { credential: enrolled.credential, csrPem }));
    const reissued = heal.frames.find((f) => f.t === "server/enrolled");
    expect(reissued?.mtls?.certPem).toContain("BEGIN CERTIFICATE");
    expect(heal.frames.some((f) => f.t === "server/apply")).toBe(false);
  });
});

describe.skipIf(!runtimeVerifies)("mTLS require mode (plain channel only enrols + issues)", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await buildStack(true);
  });
  afterAll(async () => {
    await stack.close();
  });

  test("an admissible machine on the PLAIN channel gets its bundle but NO apply, and the server closes the socket", async () => {
    const { keyPem, csrPem } = await keyAndCsr("machine-3");

    // Enrol + approve first (plain first contact parks pending, then closes in require mode).
    const first = await driveAgentHello(stack.plainUrl, agentHello("machine-3", { bootstrapToken: TOKEN, csrPem }));
    const enrolled = first.frames.find((f) => f.t === "server/enrolled");
    expect(enrolled).toBeDefined();
    expect(first.closedByServer).toBe(true);
    await stack.control.approveMachine("machine-3");

    // An approved machine dialling PLAIN with a valid credential: answered, not admitted, closed.
    const plainRetry = await driveAgentHello(
      stack.plainUrl,
      agentHello("machine-3", { credential: enrolled.credential, csrPem: (await keyAndCsr("machine-3")).csrPem }),
    );
    expect(plainRetry.frames.some((f) => f.t === "server/apply")).toBe(false);
    expect(plainRetry.closedByServer).toBe(true);
    const reissued = plainRetry.frames.find((f) => f.t === "server/enrolled");
    expect(reissued?.mtls?.certPem).toContain("BEGIN CERTIFICATE");

    // The same machine over the mTLS channel: admitted.
    const viaMtls = await driveAgentHello(
      stack.mtlsUrl,
      agentHello("machine-3", { credential: enrolled.credential }),
      { tls: { key: keyPem, cert: enrolled.mtls.certPem, ca: stack.mtls.caPem }, until: 1 },
    );
    expect(viaMtls.frames.some((f) => f.t === "server/apply")).toBe(true);
  });
});
