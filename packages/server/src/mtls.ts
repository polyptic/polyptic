/**
 * mTLS agent identity (POL-25) — the deployment's own certificate authority + the dedicated
 * agent TLS listener.
 *
 * Phase 2b gave every machine a durable app-level credential; this module adds the deferred
 * transport layer (D12): a private, per-deployment CA whose client certificates gate a second,
 * TLS-terminating listener that serves ONLY the /agent WebSocket channel. The TLS handshake itself
 * (`requestCert` + `rejectUnauthorized` against our CA) is what rejects a wrong/absent/expired cert —
 * before any app-layer code runs. The app-level credential stays the per-machine identity; the cert
 * is the fleet-membership transport gate. Together they are strictly stronger than 2b alone.
 *
 * Issuance rides the 2b seam: any `agent/hello` that authenticates (bootstrap token or credential)
 * and carries a CSR gets it signed with CN forced to the machine id — the agent's private key never
 * crosses the wire. See `ws.ts` for the channel policy and `@polyptic/protocol`'s `MtlsBundle`.
 *
 * TRUST IS VERIFIED, NOT ASSUMED: `selfTest()` dials the live listener with no cert and with a
 * rogue-CA cert and demands the handshake FAIL both times (and pass with a genuine cert). This is
 * load-bearing — Bun ≤ 1.2 implemented `requestCert` as presence-only (ANY cert was accepted,
 * measured on 1.2.2), which would have made the whole feature security theater. A server whose
 * runtime cannot verify client certs must refuse to offer mTLS at all.
 *
 * Crypto: ECDSA P-256 via WebCrypto + `@peculiar/x509` (pure TS — no openssl shellouts). The
 * `reflect-metadata` import must land before `@peculiar/x509` is evaluated, and Bun mis-orders the
 * static-import case (measured on 1.2.2 and 1.3.14) — hence the dynamic import below.
 */
import "reflect-metadata";
import { createServer } from "node:https";
import { connect } from "node:tls";
import { isIP } from "node:net";
import { hostname } from "node:os";

import { AgentSecurityInfo } from "@polyptic/protocol";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Server } from "node:https";
import type { ActivityLog } from "./activity";
import type { Presence } from "./admin";
import type { PersistedMtlsCa, Store } from "./store";
import type { ControlPlane } from "./state";

const x509 = await import("@peculiar/x509");
x509.cryptoProvider.set(globalThis.crypto);

/** ECDSA P-256 / SHA-256 everywhere — small keys, fast handshakes, universally supported. */
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

const YEAR_MS = 365 * 24 * 3600 * 1000;
/** CA lifetime. Rotating the CA re-keys the whole fleet (agents heal via the credential seam). */
const CA_VALIDITY_MS = 20 * YEAR_MS;
/** Server leaf lifetime. Regenerated on EVERY boot, so this only needs to outlive one uptime. */
const SERVER_CERT_VALIDITY_MS = 2 * YEAR_MS;
/** Client cert lifetime — the "durable" in POL-25. Agents renew via CSR inside the last 30 days. */
const CLIENT_CERT_VALIDITY_MS = 10 * YEAR_MS;

/** A random, positive X.509 serial (16 bytes hex, top bit cleared so DER stays positive). */
function randomSerial(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Export a WebCrypto private key as PKCS#8 PEM (what node:tls expects). */
async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey("pkcs8", key);
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64.trim()}\n-----END PRIVATE KEY-----\n`;
}

/** Import a PKCS#8 PEM back into a WebCrypto signing key. */
async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = Buffer.from(b64, "base64");
  return crypto.subtle.importKey("pkcs8", der, ALG, true, ["sign"]);
}

/** The hosts baked into the server leaf's SANs — every name/IP an agent might dial. */
export interface ServerCertHosts {
  /** Extra hostnames/IPs (comma-split from `AGENT_MTLS_SANS` and the public URL envs). */
  extra: string[];
}

export interface AgentMtlsOptions {
  /** The port the dedicated agent TLS listener binds. */
  port: number;
  /** When set, `server/enrolled.mtls.url` carries this verbatim (`AGENT_MTLS_PUBLIC_URL`). */
  publicUrl?: string;
  /** Extra SAN hosts for the server leaf (`AGENT_MTLS_SANS` + hosts of the public URL envs). */
  sanHosts?: string[];
}

/**
 * The live mTLS state: the persisted CA + this boot's server leaf. Construct via `AgentMtls.init`.
 */
export class AgentMtls {
  private constructor(
    private readonly caKey: CryptoKey,
    private readonly caCert: InstanceType<typeof x509.X509Certificate>,
    /** PEM of the CA cert — the trust root agents pin and the listener's client-cert `ca`. */
    readonly caPem: string,
    /** This boot's server leaf (PEM), signed by the CA, SANs covering every dialable host. */
    readonly serverCertPem: string,
    readonly serverKeyPem: string,
    readonly options: AgentMtlsOptions,
  ) {}

  /**
   * Load the persisted CA (or mint one on the first mTLS boot) and issue this boot's server leaf.
   * The CA is written back exactly once; every subsequent boot reuses it so the fleet's client
   * certs stay valid across server restarts and re-deploys.
   */
  static async init(store: Store, options: AgentMtlsOptions, log?: FastifyBaseLogger): Promise<AgentMtls> {
    let persisted: PersistedMtlsCa | undefined = await store.getMtlsCa();
    if (!persisted) {
      const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
      const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: randomSerial(),
        name: "CN=Polyptic Agent CA",
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + CA_VALIDITY_MS),
        signingAlgorithm: ALG,
        keys,
        extensions: [
          new x509.BasicConstraintsExtension(true, 0, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        ],
      });
      persisted = {
        certPem: cert.toString("pem"),
        keyPem: await exportPrivateKeyPem(keys.privateKey),
        createdAt: new Date().toISOString(),
      };
      await store.setMtlsCa(persisted);
      log?.info({ event: "mtls.ca.created" }, "mTLS: generated the deployment's agent CA (persisted to the store)");
    }

    const caCert = new x509.X509Certificate(persisted.certPem);
    const caKey = await importPrivateKeyPem(persisted.keyPem);

    // This boot's server leaf. SANs must cover every host an agent may dial — agents pin our CA but
    // still verify the hostname (measured: Bun's ws client enforces SAN matching).
    const sanNames = new Set<string>(["localhost", "127.0.0.1", "::1", hostname()]);
    for (const extra of options.sanHosts ?? []) {
      const trimmed = extra.trim();
      if (trimmed) sanNames.add(trimmed);
    }
    const serverKeys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const serverCert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: "CN=polyptic-agent-mtls",
      issuer: caCert.subject,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + SERVER_CERT_VALIDITY_MS),
      signingAlgorithm: ALG,
      publicKey: serverKeys.publicKey,
      signingKey: caKey,
      extensions: [
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension(
          [...sanNames].map((name) => (isIP(name) ? { type: "ip" as const, value: name } : { type: "dns" as const, value: name })),
        ),
      ],
    });

    return new AgentMtls(
      caKey,
      caCert,
      persisted.certPem,
      serverCert.toString("pem"),
      await exportPrivateKeyPem(serverKeys.privateKey),
      options,
    );
  }

  /**
   * Sign an agent's CSR into a durable client certificate. The CSR's self-signature is verified
   * (proof of key possession) and its public key is taken — but its SUBJECT is ignored: the CN is
   * forced to `machineId`, so a cert can never claim an identity its enrolment didn't authenticate.
   * Throws on a malformed/forged CSR; callers treat that as "no cert issued", never as fatal.
   */
  async signCsr(csrPem: string, machineId: string): Promise<string> {
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    if (!(await csr.verify())) throw new Error("CSR self-signature is invalid");
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: `CN=${machineId.replace(/[,+"\\<>;=]/g, "_")}`,
      issuer: this.caCert.subject,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + CLIENT_CERT_VALIDITY_MS),
      signingAlgorithm: ALG,
      publicKey: csr.publicKey,
      signingKey: this.caKey,
      extensions: [
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
      ],
    });
    return cert.toString("pem");
  }

  /**
   * The HTTPS server the /agent mTLS channel attaches to. `requestCert` + `rejectUnauthorized`
   * against OUR CA is the transport-layer gate: a client that cannot present a cert chaining to the
   * deployment's CA never completes the handshake, so no frame of its ever reaches the app layer.
   */
  createListener(): Server {
    return createServer(
      {
        key: this.serverKeyPem,
        cert: this.serverCertPem,
        ca: this.caPem,
        requestCert: true,
        rejectUnauthorized: true,
      },
      // Plain HTTP requests get a legible brush-off — this listener only speaks the /agent WS
      // upgrade. Answering ALSO matters to `selfTest`: under TLS 1.3 a client's handshake "completes"
      // before the server has judged its cert (the rejection arrives as a post-handshake alert), so
      // the only trustworthy accept-signal is an application-layer round-trip like this response.
      (req, res) => {
        res.statusCode = 426;
        res.setHeader("content-type", "text/plain");
        res.end("polyptic mTLS agent channel — connect via WebSocket upgrade on /agent\n");
      },
    );
  }

  /**
   * Prove, against the LIVE listener, that the runtime actually verifies client certificates:
   *   1. a genuine CA-signed cert must complete the handshake (else the listener is just broken and
   *      would strand the whole fleet),
   *   2. NO cert must fail it,
   *   3. a rogue-CA cert (same CN, different issuer) must fail it.
   * Returns `{ safe: false }` with the reason when any check fails. Bun ≤ 1.2's `requestCert` was
   * presence-only (measured), which fails check 3 — the caller must then refuse to serve mTLS.
   */
  async selfTest(port: number, host = "127.0.0.1"): Promise<{ safe: boolean; reason?: string }> {
    // A genuine client cert, signed by the real CA — the positive control.
    const goodKeys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const goodCert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: "CN=mtls-self-test",
      issuer: this.caCert.subject,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3600_000),
      signingAlgorithm: ALG,
      publicKey: goodKeys.publicKey,
      signingKey: this.caKey,
      extensions: [new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth])],
    });

    // A rogue cert: identical shape, but chained to a CA the server has never seen.
    const rogueCaKeys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const rogueCa = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomSerial(),
      name: "CN=Rogue CA",
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3600_000),
      signingAlgorithm: ALG,
      keys: rogueCaKeys,
      extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
    });
    const rogueKeys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const rogueCert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: "CN=mtls-self-test",
      issuer: rogueCa.subject,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3600_000),
      signingAlgorithm: ALG,
      publicKey: rogueKeys.publicKey,
      signingKey: rogueCaKeys.privateKey,
      extensions: [new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth])],
    });

    // "Accepted" means the server ANSWERS US, not that `secureConnect` fired: under TLS 1.3 the
    // client's handshake completes a flight before the server judges its cert (rejection arrives as
    // a post-handshake alert), so the only trustworthy accept-signal is application data coming back.
    const handshake = (client: { keyPem?: string; certPem?: string }): Promise<boolean> =>
      new Promise((resolve) => {
        let answered = false;
        const socket = connect(
          {
            host,
            port,
            // We are testing the SERVER's verification, so the probe client trusts anything.
            rejectUnauthorized: false,
            ...(client.keyPem ? { key: client.keyPem } : {}),
            ...(client.certPem ? { cert: client.certPem } : {}),
          },
          () => {
            socket.write(`GET /mtls-self-test HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
          },
        );
        const finish = (ok: boolean) => {
          if (answered) return;
          answered = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), 5_000);
        socket.on("data", () => finish(true));
        socket.on("error", () => finish(false));
        socket.on("close", () => finish(false));
      });

    const goodOk = await handshake({
      keyPem: await exportPrivateKeyPem(goodKeys.privateKey),
      certPem: goodCert.toString("pem"),
    });
    if (!goodOk) {
      return { safe: false, reason: "a genuine CA-signed client cert failed the handshake — the listener is broken" };
    }
    const noneOk = await handshake({});
    if (noneOk) {
      return { safe: false, reason: "a client with NO certificate completed the handshake — the runtime does not enforce requestCert" };
    }
    const rogueOk = await handshake({
      keyPem: await exportPrivateKeyPem(rogueKeys.privateKey),
      certPem: rogueCert.toString("pem"),
    });
    if (rogueOk) {
      return {
        safe: false,
        reason:
          "a client cert from an UNKNOWN CA completed the handshake — the runtime does not verify client certs " +
          "(Bun ≤ 1.2 behaves this way; run the server on Bun ≥ 1.3)",
      };
    }
    return { safe: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POL-134 — mTLS is ON BY DEFAULT: env resolution + the require-posture state machine.
// ─────────────────────────────────────────────────────────────────────────────

/** The default agent-mTLS listener port when nothing is configured (mirrors the chart). */
export const DEFAULT_AGENT_MTLS_PORT = 8443;

/**
 * The resolved agent-mTLS configuration. `explicit` distinguishes "the operator asked for this"
 * from "the shipped default": an explicitly-requested listener that cannot come up is FATAL (never
 * serve a fake gate the operator believes in), while the zero-config default degrades loudly to
 * off — a laptop dev run with port 8443 occupied, or a Bun ≤ 1.2 runtime that cannot verify client
 * certs, must not brick a server nobody configured.
 */
export interface AgentMtlsEnv {
  enabled: boolean;
  port: number;
  /** True when any AGENT_MTLS* env was set — failures are then fatal instead of degrading. */
  explicit: boolean;
  /**
   * The AGENT_MTLS_REQUIRE pin: `true`/`false` when the env is set (no auto-promotion either way),
   * `undefined` when unset — the posture then starts from the store and promotes itself.
   */
  requirePin?: boolean;
  publicUrl?: string;
  sans: string[];
}

/**
 * Resolve the agent-mTLS envs into one config (POL-134 flipped the default to ON):
 *   - `AGENT_MTLS=off` (or `0`/`false`/`no`) disables the listener entirely — the escape hatch.
 *   - `AGENT_MTLS_PORT` picks the port (0 also disables, the pre-POL-134 spelling of off);
 *     unset → 8443. An unparseable value THROWS: it is explicit configuration, and silently
 *     treating a typo as "off" would bypass the explicit-failures-are-fatal rule with a lie.
 *   - `AGENT_MTLS_REQUIRE` set pins the require posture (truthy → required now, falsy → never
 *     auto-promote); unset → the posture manages itself (see {@link MtlsPosture}).
 */
export function resolveAgentMtlsEnv(env: NodeJS.ProcessEnv = process.env): AgentMtlsEnv {
  const modeRaw = env.AGENT_MTLS?.trim();
  const portRaw = env.AGENT_MTLS_PORT?.trim();
  const requireRaw = env.AGENT_MTLS_REQUIRE?.trim();

  const explicit = modeRaw !== undefined || (portRaw !== undefined && portRaw !== "");
  const modeOff = modeRaw !== undefined && /^(off|0|false|no)$/i.test(modeRaw);
  const port = portRaw !== undefined && portRaw !== "" ? Number(portRaw) : DEFAULT_AGENT_MTLS_PORT;
  if (!Number.isFinite(port) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `AGENT_MTLS_PORT is not a valid port: ${JSON.stringify(env.AGENT_MTLS_PORT)} — ` +
        "set a port (1–65535), 0 to disable, or unset it for the default (8443)",
    );
  }

  const requirePin =
    requireRaw === undefined || requireRaw === ""
      ? undefined
      : /^(1|true|yes|on)$/i.test(requireRaw);

  return {
    enabled: !modeOff && port > 0,
    port,
    explicit,
    ...(requirePin !== undefined ? { requirePin } : {}),
    publicUrl: env.AGENT_MTLS_PUBLIC_URL?.trim() || undefined,
    sans: (env.AGENT_MTLS_SANS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}

/**
 * Whether an agent-mTLS STARTUP failure (bind error, self-test failure) must be FATAL rather than
 * degrade to off. Fatal when:
 *   - the operator configured mTLS explicitly (never serve a fake gate they asked for), or
 *   - the posture is pinned required (`AGENT_MTLS_REQUIRE=1`), or
 *   - the PERSISTED posture says the deployment already graduated to required and no pin overrides
 *     it — a zero-config deployment that promised its fleet "every session is mutually
 *     authenticated" must not quietly re-open plaintext sessions because :8443 was busy for one
 *     boot. Degrading here would be operationally invisible (agents self-heal onto the plain
 *     channel after a few failed dials); a crash-looping server is loud, a plaintext fleet is not.
 * `AGENT_MTLS_REQUIRE=0` is the operator's explicit "plain admission is acceptable" — with that
 * pin, the zero-config degrade stays available.
 */
export function mtlsStartupFailureIsFatal(
  env: AgentMtlsEnv,
  persisted: { required: boolean } | undefined,
): boolean {
  if (env.explicit) return true;
  if (env.requirePin !== undefined) return env.requirePin;
  return persisted?.required === true;
}

/**
 * The require-mTLS posture (POL-134): starts in MIGRATING (the plain channel still admits sessions
 * while agents pick up certs) and GRADUATES to REQUIRED by itself, with notice, once every known
 * machine has actually connected over the mTLS listener — proof the whole fleet presents working
 * certs, so requiring strands nobody. The promotion is:
 *
 *   - automatic, because an explicit click is exactly the ceremony POL-134 exists to delete, and a
 *     click every deployment must eventually click is a default in denial;
 *   - safe, because even under REQUIRE the plain channel still authenticates first contact and
 *     issues certs (it just never carries a session) — a new box, a re-imaged box, or a diskless
 *     netbooter all still walk in through the same door; the only strandable client would be an
 *     agent too old to send a CSR, and the promotion condition (every machine SEEN on mTLS) proves
 *     no such agent exists in this fleet;
 *   - one-way and persisted: a promotion survives restarts and never silently regresses. The only
 *     ways back are the explicit pins (`AGENT_MTLS_REQUIRE=0`) or disabling mTLS outright.
 *
 * An empty fleet does NOT promote (vacuous truth would flip brand-new deployments into require
 * before the operator's dev tooling — fake agents, smoke tests — ever connected once); the first
 * machine to complete the plain→cert→mTLS arc is what proves the path works, and promotes.
 */
export class MtlsPosture {
  private required_: boolean;
  private promotedAt?: string;

  private constructor(
    private readonly store: Store,
    private readonly pin: boolean | undefined,
    initial: { required: boolean; promotedAt?: string },
  ) {
    this.required_ = initial.required;
    this.promotedAt = initial.promotedAt;
  }

  /**
   * Load the persisted posture and apply the env pin (a pin always wins, both directions, for the
   * RUNTIME value). A `pin=true` also PERSISTS `required=true` — the pin is a promotion, and like
   * every promotion it is one-way: unpinning later must leave the fleet required, not regress it to
   * migrating on a fleet whose machines were never individually SEEN on the listener. A `pin=false`
   * deliberately writes NOTHING: it suppresses requirement for this runtime without erasing a
   * graduation the store already recorded.
   */
  static async load(store: Store, pin: boolean | undefined): Promise<MtlsPosture> {
    const persisted = await store.getAgentMtlsPosture();
    if (pin !== undefined) {
      const promotedAt = pin ? (persisted?.promotedAt ?? new Date().toISOString()) : undefined;
      if (pin && persisted?.required !== true) {
        await store.setAgentMtlsPosture({ required: true, promotedAt });
      }
      return new MtlsPosture(store, pin, { required: pin, promotedAt });
    }
    return new MtlsPosture(store, undefined, {
      required: persisted?.required ?? false,
      promotedAt: persisted?.promotedAt,
    });
  }

  get required(): boolean {
    return this.required_;
  }

  get pinned(): boolean {
    return this.pin !== undefined;
  }

  get requiredSince(): string | undefined {
    return this.required_ ? this.promotedAt : undefined;
  }

  /**
   * Evaluate the promotion condition against the live registry and promote when it holds:
   * at least one machine is known, and EVERY known machine has been seen on the mTLS listener.
   * Announces once in the activity feed; persists so the graduation survives restarts.
   */
  async evaluate(control: ControlPlane, activity: ActivityLog, log?: FastifyBaseLogger): Promise<void> {
    if (this.pin !== undefined || this.required_) return;
    const machines = control.getMachines();
    if (machines.length === 0) return;
    if (!machines.every((m) => Boolean(m.mtlsSeenAt))) return;

    this.required_ = true;
    this.promotedAt = new Date().toISOString();
    await this.store.setAgentMtlsPosture({ required: true, promotedAt: this.promotedAt });
    activity.push(
      "good",
      `Agent mTLS is now required — every machine holds a certificate. New machines still enrol over the plain channel and are handed one.`,
    );
    log?.info(
      { event: "mtls.require.promoted", machines: machines.length },
      "agent mTLS promoted to REQUIRED — every known machine has connected over the mTLS listener",
    );
  }
}

/** Everything the agent-security settings surface needs about the live mTLS runtime. */
export interface AgentSecurityRuntime {
  /** Present when the listener is up. */
  posture?: MtlsPosture;
  port?: number;
  /** Why the listener is off, when it is ("AGENT_MTLS=off", "port 8443 in use", …). */
  offDetail?: string;
}

/**
 * POL-134 — `GET /api/v1/settings/agent-security` (auth-gated like every settings surface): the
 * posture + per-machine cert state the Settings card renders. The GET also re-evaluates the
 * promotion lazily, so a fleet whose last certless machine was REMOVED graduates the next time an
 * operator looks — not only on the next agent hello.
 */
export function registerAgentSecurityRoutes(
  fastify: FastifyInstance,
  deps: { control: ControlPlane; presence: Presence; activity: ActivityLog; runtime: AgentSecurityRuntime },
): void {
  const { control, presence, activity, runtime } = deps;
  fastify.get("/api/v1/settings/agent-security", async () => {
    if (runtime.posture) await runtime.posture.evaluate(control, activity, fastify.log);
    const machines = control.getMachines().map((m) => ({
      id: m.id,
      label: m.label,
      online: presence.isMachineOnline(m.id),
      ...(presence.machineChannel(m.id) ? { agentChannel: presence.machineChannel(m.id) } : {}),
      ...(m.mtlsCertIssuedAt ? { mtlsCertIssuedAt: m.mtlsCertIssuedAt } : {}),
      ...(m.mtlsSeenAt ? { mtlsSeenAt: m.mtlsSeenAt } : {}),
    }));
    return AgentSecurityInfo.parse({
      mode: !runtime.posture ? "off" : runtime.posture.required ? "required" : "migrating",
      ...(runtime.port ? { port: runtime.port } : {}),
      ...(runtime.posture?.requiredSince ? { requiredSince: runtime.posture.requiredSince } : {}),
      pinned: runtime.posture?.pinned ?? false,
      ...(runtime.offDetail ? { detail: runtime.offDetail } : {}),
      machines,
    });
  });
}
