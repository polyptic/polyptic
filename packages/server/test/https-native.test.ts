/**
 * POL-70/D89 — native TLS on the MAIN listener, driven over real sockets.
 *
 * The primary production path is a TLS-terminating ingress in front of plain :8080; native TLS
 * (TLS_CERT_FILE/TLS_KEY_FILE → Fastify's `https` option) is the cheap alternative for a bare host.
 * This suite pins the two seams that make it real under Bun:
 *
 *   1. Fastify boots with `https` and serves routes over TLS (node:https under Bun — the POL-25
 *      mTLS agent listener already relies on the same runtime surface).
 *   2. The WS upgrade path (`attachWebSockets` hangs off the raw server's `upgrade` event) works
 *      identically on the TLS listener — an agent completes a full hello→enrolled round trip over
 *      `wss://`. If Bun's https server ever stopped emitting `upgrade`, every channel would go
 *      dark under native TLS; this is the test that would catch it.
 *
 * The cert is a throwaway self-signed one minted in-process (@peculiar/x509, the POL-25 pattern);
 * clients dial with rejectUnauthorized:false — trust distribution is deployment business, the seam
 * under test is the transport.
 */
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import { WebSocket } from "ws";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { ActivityLog } from "../src/activity";
import { AdminBroadcaster, AdminHub, Presence } from "../src/admin";
import { CaptureCoordinator, ThumbnailStore } from "../src/capture";
import { DevtoolsRelay } from "../src/devtools-relay";
import { Enrollment } from "../src/enroll";
import { AgentHub, PlayerHub } from "../src/hub";
import { PanelPowerScheduler } from "../src/panel-power";
import { PlayerAuth } from "../src/player-auth";
import { SourceHealthTracker } from "../src/source-health";
import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";
import { attachWebSockets } from "../src/ws";
import type { AuthService } from "../src/auth-local";

const x509 = await import("@peculiar/x509");
x509.cryptoProvider.set(globalThis.crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

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

/** A self-signed SERVER cert for 127.0.0.1/localhost — what an operator's real cert stands in for. */
async function selfSignedServerCert(): Promise<{ keyPem: string; certPem: string }> {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=localhost",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3600_000),
    signingAlgorithm: ALG,
    keys,
    extensions: [
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([
        { type: "dns", value: "localhost" },
        { type: "ip", value: "127.0.0.1" },
      ]),
    ],
  });
  return { keyPem: await pemKey(keys.privateKey), certPem: cert.toString("pem") };
}

describe("native TLS on the main listener (POL-70/D89)", () => {
  let fastify: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    const { keyPem, certPem } = await selfSignedServerCert();
    // The same shape index.ts builds from TLS_CERT_FILE/TLS_KEY_FILE.
    fastify = Fastify({ https: { key: keyPem, cert: certPem } } as never) as unknown as FastifyInstance;
    fastify.get("/healthz", async () => ({ ok: true }));

    const store = new MemoryStore();
    const activity = new ActivityLog();
    const control = new ControlPlane(store, activity);
    await control.init();
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
    attachWebSockets({
      server: fastify.server,
      control,
      enrollment: new Enrollment(undefined), // open mode: hello → auto-approved, no token needed
      auth: { enabled: false } as unknown as AuthService,
      playerAuth: await PlayerAuth.init(store, false, noopLog),
      hub,
      agentHub,
      adminHub,
      presence,
      broadcaster,
      activity,
      capture,
      health: new SourceHealthTracker(),
      devtoolsRelay: new DevtoolsRelay(agentHub, control, presence, activity, noopLog),
      panelPower: new PanelPowerScheduler({ control, agentHub, presence, activity, broadcaster, log: noopLog }),
      log: noopLog,
      allowedOrigins: [],
    });

    await fastify.listen({ port: 0, host: "127.0.0.1" });
    const addr = fastify.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await fastify.close();
  });

  test("REST answers over https (Fastify's https option works under Bun)", async () => {
    const res = await fetch(`https://127.0.0.1:${port}/healthz`, {
      // Bun's fetch TLS escape hatch — the cert is a throwaway self-signed one.
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("the agent WS upgrade rides the SAME TLS listener — hello→enrolled over wss://", async () => {
    const frames = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const collected: Array<Record<string, unknown>> = [];
      // Bun's ws shim reads TLS options from a `tls` key; node's ws reads them top-level. Set both
      // (the POL-25 mtls-listener test established the pattern).
      const wsOpts = { rejectUnauthorized: false, tls: { rejectUnauthorized: false } } as never;
      const ws = new WebSocket(`wss://127.0.0.1:${port}/agent`, wsOpts);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timed out; frames so far: ${JSON.stringify(collected)}`));
      }, 5_000);
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            t: "agent/hello",
            protocol: 1,
            machineId: "tls-box",
            agentVersion: "test",
            backend: "wayland-sway",
            outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
            hostname: "tls-box",
          }),
        ),
      );
      ws.on("message", (raw) => {
        collected.push(JSON.parse(raw.toString()));
        clearTimeout(timer);
        ws.close();
        resolve(collected);
      });
      ws.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(frames.length).toBeGreaterThan(0);
    // Open mode auto-approves: the first frame is the server speaking the agent protocol back.
    expect(String(frames[0]?.t ?? "")).toStartWith("server/");
  });
});
