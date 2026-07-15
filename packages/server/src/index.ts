/**
 * @polyptic/server — the control plane.
 *
 * Fastify (REST + CORS) on :8080, with three WebSocket channels (/agent, /player, /admin)
 * multiplexed onto the same HTTP server. The desired-state + registry live in a durable Store
 * (Postgres by default; in-memory test double via STORE=memory): loaded on boot, written through on
 * every mutation. A REST mutation bumps the revision and pushes a `server/render` straight to the
 * screen's player socket — the "instant" path — and broadcasts `admin/state` to admin clients.
 *
 * Dev runtime: Bun (ESM). Run with `bun run dev` from the repo root.
 */
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";

import {
  ActivateImageBody,
  ImageUpdateInfo,
  PromoteImageRingBody,
  RebuildImageBody,
  SetImageRingsBody,
  UpdateImageSettingsBody,
} from "@polyptic/protocol";

import { ActivityLog } from "./activity";
import { AdminBroadcaster, AdminHub, Presence } from "./admin";
import { AuthService, authConfigFromEnv } from "./auth-local";
import { PlayerAuth } from "./player-auth";
import { registerAuthRoutes } from "./auth-routes";
import { CaptureCoordinator, ThumbnailStore } from "./capture";
import { Enrollment } from "./enroll";
import { AgentMtls, MtlsPosture, mtlsStartupFailureIsFatal, registerAgentSecurityRoutes, resolveAgentMtlsEnv } from "./mtls";
import { AgentHub, PlayerHub } from "./hub";
import { MediaStore, registerMediaServeRoute } from "./media";
import { createMediaProber } from "./media-probe";
import { DEFAULT_RETAIN_BUILDS, ImageUpdates } from "./image-updates";
import { CounterRegistry } from "./metrics";
import { registerOpsRoutes } from "./ops";
import { computeBaseUrl, provisionBootSummary, provisionConfigFromEnv, registerProvisionRoutes } from "./provision";
import { initSelfSignedTls, registerHttpsRoutes, requiredSans, resolveTlsEnv } from "./server-tls";
import type { ServerTlsRuntime, TlsEnvConfig } from "./server-tls";
import { PageDataService } from "./page-data";
import { registerRestRoutes } from "./rest";
import { registerScheduleRoutes } from "./schedule-routes";
import { DEFAULT_TICK_MS, SceneScheduler } from "./scheduler";
import { DevtoolsRelay } from "./devtools-relay";
import { PanelPowerScheduler } from "./panel-power";
import { registerDevtoolsRoutes } from "./devtools-routes";
import { registerSpaHosting, spaConfigFromEnv } from "./spa";
import { ControlPlane } from "./state";
import { createStore } from "./store";
import { TokenService } from "./tokens";
import { attachWebSockets } from "./ws";

import { ServerToPlayerRender } from "@polyptic/protocol";

import type { PersistedBootstrap } from "./store";
import type { FastifyHttpOptions, FastifyReply, FastifyRequest } from "fastify";
import type { Server as HttpServer } from "node:http";

/** API paths that authenticate themselves (or report their own 401) — excluded from the global gate. */
const AUTH_PUBLIC_PATHS = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/logout",
  "/api/v1/auth/me",
]);

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const STARTED_AT = Date.now();
// Build identity surfaced on /healthz + /metrics. Wired by the deploy (image tag + git sha).
const BUILD_VERSION = process.env.POLYPTIC_VERSION?.trim() || "0.0.0";
const BUILD_REVISION = process.env.POLYPTIC_REVISION?.trim() || process.env.GIT_SHA?.trim() || "dev";
// Live-preview capture sweep cadence (ms). 0 disables the periodic sweep (on-demand still works).
const CAPTURE_INTERVAL_MS = Number(process.env.CAPTURE_INTERVAL_MS ?? 4000);
// POL-59 — auto-disarm a remote shell left armed-and-idle this long (default 60 min). 0 disables the
// sweep (arming stays sticky until a manual disarm). Guards against a forgotten armed box.
const SHELL_ARM_TTL_MS = Number(process.env.SHELL_ARM_TTL_MS ?? 60 * 60 * 1000);
// Max thumbnails held in memory at once (LRU cap).
const THUMBNAIL_CAPACITY = Number(process.env.CAPTURE_THUMBNAIL_CAP ?? 300);
// POL-89 — how often the scene scheduler re-resolves "what should be on the wall right now". A
// scheduled scene therefore lands within this of its window boundary (default 10s).
const SCHEDULER_TICK_MS = Number(process.env.SCHEDULER_TICK_MS ?? DEFAULT_TICK_MS);
// POL-89 — a TEST SEAM, and nothing else: shifts the scheduler's clock so a suite can stand a few
// seconds before a window boundary and watch it fire, instead of sleeping through a real one. Unset
// (0) in every real deployment; the ticker then reads the plain wall clock.
const SCHEDULER_CLOCK_OFFSET_MS = Number(process.env.SCHEDULER_CLOCK_OFFSET_MS ?? 0);
const CORS_ORIGIN = (
  process.env.CORS_ORIGIN ??
  // 5173 player, 5175 Vue console.
  "http://localhost:5173,http://localhost:5175"
)
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);
const PLAYER_BASE_URL = process.env.PLAYER_BASE_URL ?? "http://localhost:5173";

// ── mTLS agent identity (POL-25, ON BY DEFAULT since POL-134). ──
// The dedicated TLS listener for the /agent channel comes up with ZERO configuration (port 8443):
// enrolment issues per-machine client certs (CN = machine id, signed by the deployment's own
// persisted CA) and agents reconnect over wss://, where a wrong/absent cert fails the TLS
// HANDSHAKE — rejected before any app code. The posture then GRADUATES to require-mTLS by itself
// once every known machine has been seen on the listener (see MtlsPosture). Escape hatches:
// `AGENT_MTLS=off` (or AGENT_MTLS_PORT=0) disables the listener; AGENT_MTLS_REQUIRE=1/0 pins the
// require posture in either direction (no auto-promotion).
// An unparseable AGENT_MTLS_PORT is explicit configuration with a typo — refuse to boot rather
// than silently treat it as "off" (same posture as resolveTlsEnv's half-configured pair).
let agentMtlsEnv: ReturnType<typeof resolveAgentMtlsEnv>;
try {
  agentMtlsEnv = resolveAgentMtlsEnv(process.env);
} catch (err) {
  console.error(`FATAL: ${(err as Error).message}`);
  process.exit(1);
}
// Full wss:// URL override for deployments where the mTLS endpoint is not same-host:port from the
// agent's point of view (e.g. a separate LoadBalancer in Kubernetes). Advertised verbatim.
const AGENT_MTLS_PUBLIC_URL = agentMtlsEnv.publicUrl;

// ── Media (Phase 7): uploads land on a disk VOLUME (MEDIA_DIR) and are served over plain HTTP. ──
// MEDIA_DIR defaults to ./media in dev (a mounted volume / /var/lib/polyptic/media in prod). The serve
// URL baked into each upload's ContentSource is `${MEDIA_PUBLIC_BASE}/media/<id>`, so a player on
// ANOTHER host can fetch it — it must be the server's externally reachable base, not localhost in prod.
const MEDIA_DIR = process.env.MEDIA_DIR?.trim() || "./media";
const MEDIA_MAX_BYTES = Number(process.env.MEDIA_MAX_BYTES ?? 200 * 1024 * 1024);
const MEDIA_PUBLIC_BASE = (
  process.env.MEDIA_PUBLIC_BASE?.trim() ||
  process.env.PUBLIC_BASE_URL?.trim() ||
  "http://localhost:8080"
).replace(/\/+$/, "");

// ── Durable store: select by STORE env, run migrations. Created BEFORE the Fastify instance since
// POL-70: the self-signed TLS material persists in it, and Fastify needs the cert at construction. ──
const { store, kind: storeKind } = createStore();
await store.migrate();

// ── Native TLS (POL-70/D89): three modes, resolved by server-tls.ts. ──
//   provided     TLS_CERT_FILE + TLS_KEY_FILE (both, or refuse) — the operator's own certificate.
//   self-signed  TLS_MODE=self-signed — the server mints + PERSISTS its own CA + leaf (no cert
//                infrastructure needed; operators trust the CA once via Console ▸ Settings ▸ HTTPS).
//   off          neither — plain HTTP; a TLS-terminating ingress is the primary production path.
// Native TLS makes EVERY route https, including the netboot depot, which GRUB (no TLS stack, D47)
// can then no longer fetch — a netbooting fleet needs the depot on plain HTTP; the boot banner says so.
let tlsEnv: TlsEnvConfig;
try {
  tlsEnv = resolveTlsEnv();
} catch (err) {
  console.error(`FATAL: ${(err as Error).message}`);
  process.exit(1);
}
let serverTls: ServerTlsRuntime = { mode: "off", sans: [] };
let selfSignedChange: "none" | "minted-ca" | "reminted-leaf" = "none";
if (tlsEnv.mode === "provided") {
  serverTls = {
    mode: "provided",
    material: { cert: await Bun.file(tlsEnv.certFile).text(), key: await Bun.file(tlsEnv.keyFile).text() },
    sans: [],
  };
} else if (tlsEnv.mode === "self-signed") {
  const init = await initSelfSignedTls(store, requiredSans());
  selfSignedChange = init.changed;
  serverTls = init;
}
const nativeTls = serverTls.material;

const fastifyOptions = {
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  // shim's UEFI HTTP Boot fetch requests its second stage as <dir>//grubx64.efi (double slash, D47).
  ignoreDuplicateSlashes: true,
  // `https` switches the underlying node server to TLS. Typed via the plain-HTTP overload (the
  // https generic would ripple https.Server through every FastifyInstance signature in the repo
  // for what is a runtime-only difference); the raw-server seams (WS upgrades, address()) are
  // identical on both. The mTLS agent listener (POL-25) already proves node:https under Bun.
  ...(nativeTls ? { https: nativeTls } : {}),
};
const fastify = Fastify(fastifyOptions as unknown as FastifyHttpOptions<HttpServer>);

// ── Live Activity feed (D25): one bounded in-memory ring, shared by the control plane (content /
// combine / split / rename / scene emits) and the ws presence layer (machine + screen connect/drop). ──
const activity = new ActivityLog();

const control = new ControlPlane(store, activity);
await control.init();

// ── Enrollment policy (Phase 2b/3f, POL-104): seed the bootstrap from the store; on first boot derive
// it from POLYPTIC_BOOTSTRAP_TOKEN (set → gated, unset → open). ──
let bootstrap: PersistedBootstrap | undefined = await store.getBootstrap();
if (!bootstrap) {
  const envToken = process.env.POLYPTIC_BOOTSTRAP_TOKEN?.trim();
  bootstrap =
    envToken && envToken.length > 0
      ? { mode: "gated", token: envToken }
      : { mode: "open", token: null };
  await store.setBootstrap(bootstrap);
}

// POL-104 — the token SET. Every write goes through the store; `bootstrap` is kept mirroring whichever
// token is currently baked, so the pre-POL-104 read path (and a downgrade) still finds a live token.
const enrollment = new Enrollment(undefined, {
  persist: async (token) => {
    await store.upsertEnrollmentToken(token);
    if (token.bake) await store.setBootstrap({ mode: "gated", token: token.secret });
  },
  forget: async (id) => store.deleteEnrollmentToken(id),
});

const persistedTokens = await store.listEnrollmentTokens();
if (persistedTokens.length > 0) {
  enrollment.load(
    persistedTokens.map((t) => ({
      id: t.id,
      name: t.name,
      secret: t.secret,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt ?? null,
      maxEnrollments: t.maxEnrollments ?? null,
      uses: t.uses,
      revokedAt: t.revokedAt ?? null,
      lastUsedAt: t.lastUsedAt ?? null,
      bake: t.bake,
      legacy: t.legacy,
    })),
  );
} else if (bootstrap.token) {
  // THE MIGRATION. A deployment upgrading into POL-104 has exactly one secret — the flat bootstrap
  // token — and it is BAKED INTO EVERY BOOT MEDIUM ALREADY IN THE FIELD (`/boot/grub.cfg` writes it
  // into the kernel cmdline; `build-boot-medium.sh` lifts it back out of that menu at bake time). Lift
  // it into the token table verbatim: same secret, no expiry, no cap, still the token new media bake.
  // Every stick that enrolled a box yesterday enrols one today; nothing changes until an operator
  // deliberately rotates or revokes it. A token model change that bricks the sticks already flashed is
  // not shippable, and this is the line that makes sure it doesn't.
  enrollment.setToken(bootstrap.token);
  const legacy = enrollment.list()[0];
  if (legacy) await store.upsertEnrollmentToken(legacy);
  fastify.log.info(
    { event: "enrollment.legacy_lifted", tokenId: legacy?.id },
    "POL-104: lifted the existing bootstrap token into the enrolment-token table (no expiry, no cap, " +
      "still the token baked into new media) — every boot medium already flashed keeps enrolling",
  );
}

const hub = new PlayerHub();
const agentHub = new AgentHub();
const adminHub = new AdminHub();
const presence = new Presence();
const broadcaster = new AdminBroadcaster({ control, playerHub: hub, presence, adminHub, activity, log: fastify.log, enrollment });

// ── Content auth (POL-24): the OAuth client-credentials token cache. Seeded from the persisted
// profiles; refreshes in the background at ~75% of each token's lifetime. When a profile's token
// becomes usable again (first fetch / recovery), re-push renders to the screens showing content it
// authenticates — a screen stuck on a login page heals itself. Routine refreshes push nothing (a URL
// rewrite would reload a live iframe; the running page is carried by the target app's own session). ──
const tokens = new TokenService({
  log: fastify.log,
  onStatusChange: () => broadcaster.broadcast(),
  onTokenUsable: (profileId) => {
    for (const screenId of control.screenIdsUsingProfile(profileId)) {
      const slice = control.getSlice(screenId);
      if (!slice) continue;
      const message = ServerToPlayerRender.parse({
        t: "server/render",
        revision: control.state.revision,
        friendlyName: control.getScreen(screenId)?.friendlyName ?? screenId,
        slice: control.decorateSliceForSend(slice),
      });
      const delivered = hub.send(screenId, message);
      fastify.log.info(
        { event: "render.push.token", screenId, profileId, delivered },
        "re-pushed render after credential token became usable",
      );
    }
  },
});
control.setTokenProvider(tokens);
tokens.setProfiles(control.getCredentialProfilesInternal());

// ── Page data (POL-42): server-side feed/weather poller for authored pages. Polls only the pages
// assigned to ≥1 screen; when a poll actually changes something, re-push the slices showing those
// pages so a fresh headline or temperature reaches the wall with no reload (D5). decorate stamps the
// data (plus resolved, credential-stamped embeds) into the page surface at send time. ──
const pageData = new PageDataService({
  control,
  log: fastify.log,
  onChange: (sourceIds) => {
    for (const slice of control.slicesShowingSources(sourceIds)) {
      const message = ServerToPlayerRender.parse({
        t: "server/render",
        revision: control.state.revision,
        friendlyName: control.getScreen(slice.screenId)?.friendlyName ?? slice.screenId,
        slice: control.decorateSliceForSend(slice),
      });
      const delivered = hub.send(slice.screenId, message);
      fastify.log.info(
        { event: "render.push.page-data", screenId: slice.screenId, delivered },
        "re-pushed render after page feed/weather data changed",
      );
    }
  },
});
control.setPageDataProvider(pageData);
pageData.start();

// ── Live preview (Phase 5): bounded thumbnail store + capture coordinator. ──
const thumbnails = new ThumbnailStore(
  Number.isFinite(THUMBNAIL_CAPACITY) && THUMBNAIL_CAPACITY > 0 ? THUMBNAIL_CAPACITY : 300,
);
const capture = new CaptureCoordinator({
  control,
  agentHub,
  thumbnails,
  log: fastify.log,
  intervalMs: Number.isFinite(CAPTURE_INTERVAL_MS) ? CAPTURE_INTERVAL_MS : 4000,
});

await fastify.register(cors, {
  origin: CORS_ORIGIN,
  // PUT/DELETE (3a placement/murals), PATCH (3c content-sources + 3d scenes edits).
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // Required for the browser to send/receive the session cookie cross-origin (console on :5175).
  credentials: true,
});

// ── Media uploads (Phase 7): multipart parser (streamed to disk) + the disk-backed catalogue. ──
// `fileSize` makes busboy abort an over-cap upload mid-stream; the upload route maps that to a 413.
await fastify.register(multipart, {
  limits: { fileSize: Number.isFinite(MEDIA_MAX_BYTES) && MEDIA_MAX_BYTES > 0 ? MEDIA_MAX_BYTES : 200 * 1024 * 1024 },
});
const media = new MediaStore(MEDIA_DIR);
await media.init();

// ── Media ingest (POL-109 / D129): probe → validate → poster, behind the `MediaProber` seam. The
// external toolchain is optional BY DESIGN: with none installed the prober reports itself unavailable,
// uploads are still accepted (with a warning on the source) and the wall behaves as it always did.
const mediaProber = createMediaProber();
control.setMediaProvider(media);
void mediaProber.available().then((ok) => {
  fastify.log.info(
    { event: "media.prober", prober: mediaProber.name, available: ok },
    ok
      ? "media ingest: probing enabled (metadata, poster frames, codec validation)"
      : "media ingest: no media toolchain found — uploads are accepted UNPROBED (no metadata, no posters, no codec check)",
  );
});

// ── Local operator auth (Phase 3f / D29): argon2id passwords, signed http-only session cookies. ──
const authConfig = authConfigFromEnv();
await fastify.register(cookie, { secret: authConfig.cookieSecret });
const auth = new AuthService({ store, fastify, config: authConfig, log: fastify.log });

// Sweep any sessions that expired while the server was down, then seed an admin if none exist.
await store.deleteExpiredSessions(new Date().toISOString());
await auth.seedAdmin();

// ── Player-channel auth (POL-54): a per-deployment secret (persisted, like the mTLS CA) derives a
// bearer token per screen; the token is minted into every playerUrl handed to an agent and verified
// on `player/hello`. Enforcement rides AUTH_ENABLED — the same switch as REST + the /admin WS — so a
// dev stack stays open, while a secured deployment stops broadcasting slices (and their POL-24
// credential-stamped URLs) to anyone who can reach the port. Minting is unconditional: URLs handed
// out with auth off remain valid if auth is later switched on. ──
const playerAuth = await PlayerAuth.init(store, auth.enabled, fastify.log);
control.setPlayerTokenMinter((screenId) => playerAuth.tokenFor(screenId));
fastify.log.info(
  { event: "player.auth", required: playerAuth.required },
  playerAuth.required
    ? "player channel gated — player/hello requires the screen's token"
    : "player channel OPEN (AUTH_ENABLED=false) — hellos are not token-checked",
);

// THE GATE: require a valid session on every /api/v1/** route except the public auth endpoints, AND
// (POL-107) a role that satisfies that route's policy — deny by default, so an unlisted route is
// admin-only. The device channels (/agent, /player), health/metrics and the WS upgrades are NOT
// /api/v1 and untouched (the /admin + DevTools upgrades run their own role check in ws.ts).
fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
  if (!auth.enabled) return;
  // Collapse duplicate slashes the SAME way find-my-way does under ignoreDuplicateSlashes (above),
  // or the gate desyncs from the router: `//api/v1/x` would route to the real handler while this
  // raw-url check saw a leading `//`, failed startsWith, and skipped requireAuth entirely (bypass).
  // The SAME collapsed path is what the role policy matches against, for the same reason.
  const path = (request.url.split("?")[0] ?? request.url).replace(/\/{2,}/g, "/");
  if (!path.startsWith("/api/v1/")) return;
  if (AUTH_PUBLIC_PATHS.has(path)) return;
  await auth.requireAuth(request, reply, path);
});

registerAuthRoutes(fastify, auth, enrollment);
// The remote-DevTools relay (POL-67) bridges an operator's DevTools frontend to a wall's Chrome over
// the agent WS — the POL-59 shell pattern. Built before the WS channels (agent frames route into it)
// and handed to REST so disarming a screen closes its live sessions instantly.
const devtoolsRelay = new DevtoolsRelay(agentHub, control, presence, activity, fastify.log);

// POL-101 — panel power. The scheduler owns the daily on/off windows and is the only thing in the
// server that can darken a wall; the WS layer reconciles a box's panels to their window when it says
// hello (a box that reboots at 3am comes back LIT and must be re-slept), and REST drives the manual
// wake/sleep. In hours, the only command it ever sends is WAKE: a screen that should be showing
// content is never blanked.
const panelPower = new PanelPowerScheduler({
  control,
  agentHub,
  presence,
  activity,
  broadcaster,
  log: fastify.log,
});
panelPower.start();

// ── mTLS agent channel (POL-25/POL-134): CA + dedicated TLS listener + the boot self-test. ──
// The self-test is load-bearing, not paranoia: Bun ≤ 1.2 implemented `requestCert` as PRESENCE-only
// (any cert from any CA passed the handshake, measured on 1.2.2). A server that cannot actually
// verify client certs must refuse to offer mTLS rather than serve a fake gate — so we dial our own
// listener with a rogue-CA cert and with no cert and demand both handshakes FAIL before going up.
//
// POL-134 default-on nuance: when the operator EXPLICITLY configured mTLS, any failure here is
// FATAL, exactly as before. Under the zero-config default, a listener that cannot come up (port
// taken, or a runtime that cannot verify client certs) degrades LOUDLY to off instead — the
// alternative is a shipped default that bricks every dev laptop with something on :8443.
let agentMtlsChannel: import("./ws").AgentMtlsChannel | undefined;
let agentMtlsPosture: MtlsPosture | undefined;
let agentMtlsOffDetail: string | undefined = agentMtlsEnv.enabled ? undefined : "disabled (AGENT_MTLS=off)";
if (agentMtlsEnv.enabled) {
  // Consult the PERSISTED posture BEFORE deciding how a startup failure is handled: a zero-config
  // deployment that already graduated to require-mTLS must never quietly re-open plaintext
  // sessions because one boot couldn't bind :8443 — agents self-heal onto the plain channel after
  // a few failed dials, so the regression would be invisible except for one log line. Required
  // (persisted or pinned) ⇒ startup failure is FATAL; a crash loop is loud, a plaintext fleet
  // is not. AGENT_MTLS_REQUIRE=0 is the explicit consent that makes the degrade acceptable again.
  const persistedPosture = await store.getAgentMtlsPosture();
  const mtlsFailed = (reason: string): void => {
    if (mtlsStartupFailureIsFatal(agentMtlsEnv, persistedPosture)) {
      const why = agentMtlsEnv.explicit
        ? "the explicitly configured mTLS agent channel could not start"
        : "this deployment REQUIRES mTLS (graduated posture) and the mTLS agent channel could not start";
      fastify.log.error(
        {
          event: "mtls.start.failed",
          reason,
          explicit: agentMtlsEnv.explicit,
          required: agentMtlsEnv.requirePin ?? persistedPosture?.required ?? false,
        },
        `FATAL: ${why} — ${reason}. Refusing to admit plaintext agent sessions instead of serving a ` +
          "channel that LOOKS mutually authenticated but is not. Fix the cause, or pin AGENT_MTLS_REQUIRE=0 " +
          "/ set AGENT_MTLS=off to explicitly accept plain admission.",
      );
      process.exit(1);
    }
    agentMtlsOffDetail = reason;
    fastify.log.error(
      { event: "mtls.default.unavailable", reason },
      `agent mTLS is ON by default but could not start (${reason}) — continuing WITHOUT it. ` +
        "The agent channel is running unauthenticated at the transport; fix the cause or set AGENT_MTLS=off to silence this.",
    );
  };

  const sanHosts = [...agentMtlsEnv.sans];
  for (const url of [AGENT_MTLS_PUBLIC_URL, process.env.PUBLIC_BASE_URL?.trim()]) {
    if (!url) continue;
    try {
      sanHosts.push(new URL(url).hostname);
    } catch {
      // Not a parseable URL — the SANs env is the explicit escape hatch.
    }
  }
  const mtls = await AgentMtls.init(
    store,
    { port: agentMtlsEnv.port, publicUrl: AGENT_MTLS_PUBLIC_URL, sanHosts },
    fastify.log,
  );
  const listener = mtls.createListener();
  const listening = await new Promise<string | null>((resolve) => {
    listener.once("error", (err) => resolve(String((err as NodeJS.ErrnoException).code ?? err)));
    listener.listen(agentMtlsEnv.port, HOST, () => resolve(null));
  });
  if (listening !== null) {
    mtlsFailed(`could not bind :${agentMtlsEnv.port} (${listening})`);
  } else {
    const selfTestHost = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
    const verdict = await mtls.selfTest(agentMtlsEnv.port, selfTestHost);
    if (!verdict.safe) {
      listener.close();
      mtlsFailed(`client-cert verification self-test failed: ${verdict.reason}`);
    } else {
      // The require posture: pinned by AGENT_MTLS_REQUIRE, else persisted + self-promoting (POL-134).
      const posture = await MtlsPosture.load(store, agentMtlsEnv.requirePin);
      agentMtlsPosture = posture;
      // Evaluate once at boot: a fleet whose last certless machine was removed while the server was
      // down graduates here rather than waiting for the next agent event.
      await posture.evaluate(control, activity, fastify.log);
      agentMtlsChannel = {
        server: listener,
        caPem: mtls.caPem,
        signCsr: (csrPem, machineId) => mtls.signCsr(csrPem, machineId),
        advertise: { port: agentMtlsEnv.port, ...(AGENT_MTLS_PUBLIC_URL ? { url: AGENT_MTLS_PUBLIC_URL } : {}) },
        required: () => posture.required,
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
            await posture.evaluate(control, activity, fastify.log);
          })();
        },
      };
      fastify.log.info(
        { event: "mtls.listening", port: agentMtlsEnv.port, require: posture.required, publicUrl: AGENT_MTLS_PUBLIC_URL },
        `mTLS agent channel up on :${agentMtlsEnv.port} (self-test passed: no-cert and rogue-CA handshakes rejected)` +
          (posture.required
            ? " — REQUIRED: the plain /agent channel only enrols + issues certs"
            : " — migrating: the plain /agent channel still admits while the fleet picks up certs"),
      );
    }
  }
}

// The WS channels attach first so the remote-shell relay (POL-59) exists before REST — the
// arm/disarm endpoint closes a box's live sessions the instant it is disarmed.
const shellRelay = attachWebSockets({
  server: fastify.server,
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
  devtoolsRelay,
  panelPower,
  log: fastify.log,
  allowedOrigins: CORS_ORIGIN,
  agentMtls: agentMtlsChannel,
});
shellRelay.startArmingSweep(SHELL_ARM_TTL_MS);
registerRestRoutes(
  fastify,
  control,
  hub,
  agentHub,
  broadcaster,
  capture,
  media,
  {
    publicBase: MEDIA_PUBLIC_BASE,
    maxBytes: Number.isFinite(MEDIA_MAX_BYTES) && MEDIA_MAX_BYTES > 0 ? MEDIA_MAX_BYTES : 200 * 1024 * 1024,
    prober: mediaProber,
  },
  tokens,
  activity,
  presence,
  shellRelay,
  devtoolsRelay,
  panelPower,
);
// The DevTools HTTP proxy (POL-67): the entry redirect + the frontend-file proxy, GATED under /api/v1.
registerDevtoolsRoutes(fastify, devtoolsRelay);

// ── The scene scheduler (POL-89/D93): dayparts + priorities, resolved on a ticker. ──
// It applies scenes through the EXISTING applyScene path — the same code the operator's Apply button
// runs — so a scheduled switch fans out over the ordinary `server/render` push, in the ordinary
// <150ms, with no reload, and neither the agent nor the player knows a scheduler exists.
const scheduler = new SceneScheduler({
  control,
  log: fastify.log,
  activity,
  tickMs: Number.isFinite(SCHEDULER_TICK_MS) && SCHEDULER_TICK_MS > 0 ? SCHEDULER_TICK_MS : DEFAULT_TICK_MS,
  now: () => Date.now() + (Number.isFinite(SCHEDULER_CLOCK_OFFSET_MS) ? SCHEDULER_CLOCK_OFFSET_MS : 0),
  apply: async (sceneId) => {
    const result = await control.applyScene(sceneId);
    if (!result) return false;
    for (const slice of result.slices) {
      const message = ServerToPlayerRender.parse({
        t: "server/render",
        revision: control.state.revision,
        friendlyName: control.getScreen(slice.screenId)?.friendlyName ?? slice.screenId,
        slice: control.decorateSliceForSend(slice),
      });
      const delivered = hub.send(slice.screenId, message);
      fastify.log.info(
        { event: "render.push.schedule", screenId: slice.screenId, sceneId, revision: control.state.revision, delivered },
        "pushed render for a scheduled scene",
      );
    }
    broadcaster.broadcast();
    return true;
  },
});
registerScheduleRoutes(fastify, control, scheduler, broadcaster);
scheduler.start();
// The HTTPS settings surface (POL-70/D89), GATED under /api/v1: the TLS posture + (in self-signed
// mode) the CA download the console's trust instructions hang off.
registerHttpsRoutes(fastify, serverTls);
// The agent-security settings surface (POL-134), GATED under /api/v1: the mTLS posture in operator
// words + each machine's cert state, for the Settings card.
registerAgentSecurityRoutes(fastify, {
  control,
  presence,
  activity,
  runtime: {
    ...(agentMtlsPosture && agentMtlsChannel ? { posture: agentMtlsPosture, port: agentMtlsEnv.port } : {}),
    ...(agentMtlsOffDetail ? { offDetail: agentMtlsOffDetail } : {}),
  },
});
// TOP-LEVEL media serve route (GET /media/:id) — NOT /api/v1, so UNgated: players + the public wall
// load uploads without a session, exactly like any external content URL (ids are unguessable).
registerMediaServeRoute(fastify, media);
// TOP-LEVEL, UNGATED provisioning routes (the netboot depot + GET /dist/agent/:arch) — NOT /api/v1,
// so a machine with no operator session can boot and enrol entirely from the server.
const provisionConfig = provisionConfigFromEnv();

// POL-92 — cumulative counters for /metrics (depot artifact fetches). Held here, incremented by the
// routes that serve the artifacts, rendered by the ops exporter.
const counters = new CounterRegistry();

// ── Image updates (POL-41): the scheduled rebuild hooks + the published manifest + urgency. The
// daily refresh comes from IMAGE_REBUILD_CMD (e.g. `deploy/rebuild-image-docker.sh arm64`); the
// weekly FULL rebuild — the cycle that rolls kernel CVEs (POL-43) — from IMAGE_FULL_REBUILD_CMD
// (e.g. `deploy/full-rebuild-image-docker.sh arm64`, or a k8s Job trigger in-cluster). Without a
// hook the schedule and "rebuild now" log a warning instead of building (a laptop server can still
// SERVE). ──
const imageUpdates = new ImageUpdates(
  store,
  provisionConfig.imageDistDir,
  process.env.IMAGE_REBUILD_CMD?.trim() || undefined,
  fastify.log,
  process.env.IMAGE_FULL_REBUILD_CMD?.trim() || undefined,
  // Builds retained per arch (POL-45). Each retained build costs ~1.5GB of ISO on the depot volume,
  // so the chart exposes this as imageUpdates.retainBuilds and sizes the PVC from it.
  Math.max(1, Number(process.env.IMAGE_RETAIN_BUILDS?.trim() || DEFAULT_RETAIN_BUILDS)),
  // The first-image build (POL-121) narrates itself into the Live Activity feed: on a fresh install
  // nothing in the fleet can netboot until it lands, so the operator hears it from the console rather
  // than from a Job log.
  (severity, text) => {
    activity.push(severity, text);
    broadcaster.broadcast();
  },
);
// Starts the schedule ticker AND, on a depot with no image at all, the one-shot first-image build.
imageUpdates.start();

// Pass the live enrollment singleton so GET /boot/grub.cfg (POL-33/D47) bakes the CURRENT token, the
// same one the agent WS accepts, so a regenerate re-keys the netboot flow on the next boot with no drift.
// The last argument lands a box's bootloader-install verdict (POL-58) in the Live Activity feed: the
// operator finds out whether the install took from the console, not by rebooting the box to see.
registerProvisionRoutes(
  fastify,
  provisionConfig,
  enrollment,
  imageUpdates,
  (severity, text) => {
    activity.push(severity, text);
    broadcaster.broadcast();
  },
  // POL-92 — every depot artifact a booting box pulls. `rate()` over this is what tells an operator
  // a roll-out is actually reaching the fleet (and what a stampede looks like when it isn't).
  (arch, file) =>
    counters.inc(
      "polyptic_depot_fetches_total",
      "Netboot depot artifacts served (kernel, initrd, root image, …).",
      { arch, file },
    ),
  // POL-105 — the depot's manifest route resolves PER MACHINE: a box appends `?machineId=…`, and its
  // tags decide which roll-out ring (if any) it matches. The registry is the only place tags live.
  (machineId) => control.machineTags(machineId),
);

// TOP-LEVEL ops endpoints (/healthz, /metrics) — NOT /api/v1, so UNgated for scrapers/liveness.
// Registered here (after the depot) because the fleet metrics read the depot's manifests and the
// counters the provisioning routes increment (POL-92).
registerOpsRoutes(fastify, {
  control,
  agentHub,
  playerHub: hub,
  thumbnails,
  presence,
  counters,
  images: imageUpdates,
  storeKind,
  version: BUILD_VERSION,
  revision: BUILD_REVISION,
  startedAt: STARTED_AT,
});

// ── Image-updates operator surface (POL-41), GATED under /api/v1. ──
const imageUpdateInfo = async (request: FastifyRequest) => {
  const st = await imageUpdates.state();
  // The live ISO's URL is per-request (proxy-aware), same as everything else the console downloads.
  const base = computeBaseUrl(request, provisionConfig.publicBaseUrl);
  return ImageUpdateInfo.parse({
    scheduleEnabled: st.scheduleEnabled,
    scheduleTime: st.scheduleTime,
    fullScheduleEnabled: st.fullScheduleEnabled,
    fullScheduleDay: st.fullScheduleDay,
    fullScheduleTime: st.fullScheduleTime,
    urgent: st.urgent,
    rebuildConfigured: imageUpdates.rebuildConfigured,
    fullRebuildConfigured: imageUpdates.fullRebuildConfigured,
    lastBuild: st.lastBuildStartedAt
      ? {
          startedAt: st.lastBuildStartedAt,
          finishedAt: st.lastBuildFinishedAt,
          status: st.lastBuildStatus ?? "failure",
          kind: st.lastBuildKind,
          logTail: st.lastBuildLog ?? "",
        }
      : null,
    images: (await imageUpdates.manifests()).map((m) => ({ ...m, urgent: st.urgent })),
    builds: (await imageUpdates.allBuilds()).map((b) => ({
      arch: b.arch,
      imageId: b.imageId,
      builtAt: b.builtAt,
      sha256: b.sha256,
      active: b.active,
      liveIsoUrl: b.hasLiveIso ? `${base}/dist/image/${b.arch}/builds/${b.imageId}/polyptic-live.iso` : null,
    })),
    retainBuilds: imageUpdates.retainBuilds,
    rings: st.rings ?? [],
  });
};
fastify.get("/api/v1/settings/image", async (request) => imageUpdateInfo(request));
fastify.put("/api/v1/settings/image", async (request) => {
  const body = UpdateImageSettingsBody.parse(request.body ?? {});
  await imageUpdates.updateSettings(body);
  return imageUpdateInfo(request);
});
fastify.post("/api/v1/settings/image/rebuild", async (request) => {
  const { kind } = RebuildImageBody.parse(request.body ?? {});
  await imageUpdates.trigger("manual", kind);
  return imageUpdateInfo(request);
});
// Serve a retained build (POL-45). Fleet-wide: boxes on another image reboot into this one per the
// roll-out policy, so activating an older build is the rollback path. 404 when the build is gone.
fastify.post("/api/v1/settings/image/activate", async (request, reply) => {
  const { arch, imageId } = ActivateImageBody.parse(request.body ?? {});
  try {
    await imageUpdates.activate(arch, imageId);
  } catch (err) {
    return reply.code(404).send({ error: (err as Error).message });
  }
  return imageUpdateInfo(request);
});

// ── Staged roll-outs (POL-105) ──
// The rings are the WHOLE list, replaced in one call (like a machine's tag set): add, remove and
// reorder are the same mutation, so the console never reconciles two half-applied writes. A ring
// whose selector does not parse, or whose build the depot no longer retains, is a 400 — you cannot
// point a box at a boot it cannot make.
fastify.put("/api/v1/settings/image/rings", async (request, reply) => {
  const { rings } = SetImageRingsBody.parse(request.body ?? {});
  try {
    await imageUpdates.setRings(rings);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
  return imageUpdateInfo(request);
});

// Promote a ring's build to the whole fleet: activate it for that arch AND drop the ring, so the
// canary boxes and everyone else converge on one id. One action, one activity line (the DoD).
fastify.post("/api/v1/settings/image/promote", async (request, reply) => {
  const { arch, selector, urgent } = PromoteImageRingBody.parse(request.body ?? {});
  try {
    await imageUpdates.promote(arch, selector, urgent);
  } catch (err) {
    return reply.code(404).send({ error: (err as Error).message });
  }
  broadcaster.broadcast();
  return imageUpdateInfo(request);
});

// ── Phase 8 — SPA HOSTING (opt-in): when CONSOLE_DIR / PLAYER_DIR point at built dists, serve them as
// static assets straight from disk, same-origin, so the image is the whole product. When NEITHER is set
// (dev), this is a no-op: the Vite dev servers serve the SPAs and the control plane stays API/WS-only —
// which is exactly the configuration the e2e suite drives. Registered LAST so every API/ops/media route
// (and the WS upgrades on the raw server) win; only genuinely-unmatched paths reach the SPA fallback.
const spaServed = await registerSpaHosting(fastify, spaConfigFromEnv(), fastify.log);
if (spaServed.length > 0) {
  fastify.log.info(
    { event: "spa.serving", served: spaServed },
    `serving built SPA(s) from disk, same-origin: ${spaServed.join(", ")}`,
  );
} else {
  fastify.log.info(
    { event: "spa.disabled" },
    "no CONSOLE_DIR/PLAYER_DIR set — API/WS only (the SPAs are served by their Vite dev servers in dev).",
  );
}

// Provisioning boot banner: report which zero-touch artifacts are present on disk (agent binaries per
// arch, netboot image + boot medium + signed loaders) so a misconfigured
// AGENT_DIST_DIR/IMAGE_DIST_DIR/BOOT_DIST_DIR is obvious.
const provisionSummary = await provisionBootSummary(provisionConfig);
fastify.log.info(
  {
    event: "provision.dist",
    agentDistDir: provisionConfig.agentDistDir,
    agentDistDirExists: provisionSummary.agentDistDir,
    agentArm64: provisionSummary.agentArm64,
    agentAmd64: provisionSummary.agentAmd64,
    imageDistDir: provisionConfig.imageDistDir,
    imageDistDirExists: provisionSummary.imageDistDir,
    imageAmd64: provisionSummary.imageAmd64,
    bootDistDir: provisionConfig.bootDistDir,
    bootMedium: provisionSummary.bootMedium,
    signedLoaders: provisionSummary.signedLoaders,
  },
  `provisioning: agent[arm64=${provisionSummary.agentArm64} amd64=${provisionSummary.agentAmd64}] ` +
    `netboot[iso-amd64=${provisionSummary.imageAmd64} medium=${provisionSummary.bootMedium} ` +
    `signed-loaders=${provisionSummary.signedLoaders}] (Secure Boot: supported)`,
);
if (provisionSummary.bootMedium === "lean") {
  // POL-122: a lean medium is a WIRED-ONLY dongle wearing the universal medium's filename. It boots
  // no Wi-Fi screen, and nothing downstream can tell the difference by looking at the file. Say so.
  fastify.log.warn(
    { event: "provision.boot-medium.lean", bootDistDir: provisionConfig.bootDistDir },
    "the published boot medium is LEAN (wired netboot only — no local payload, no Wi-Fi): " +
      "Wi-Fi-only screens cannot boot from it. Re-bake it from a live image (Console ▸ Settings ▸ " +
      "Image updates ▸ Full rebuild, then re-run the boot-medium Job / helm upgrade).",
  );
}

// Start the periodic live-preview capture sweep (no-op when CAPTURE_INTERVAL_MS=0).
capture.start();

// Native-TLS banner (POL-70/D89) — before the auth banners so the transport story reads first.
if (nativeTls) {
  fastify.log.info(
    { event: "tls.native", mode: serverTls.mode },
    `serving NATIVE TLS (${serverTls.mode === "self-signed" ? "TLS_MODE=self-signed" : "TLS_CERT_FILE/TLS_KEY_FILE"}): ` +
      "every route on this listener is https — including the netboot depot, which GRUB (no TLS stack) " +
      "can NOT fetch. A netbooting fleet needs the boot paths on plain http (ingress split by host, or " +
      "a plain-HTTP depot deployment).",
  );
  if (serverTls.mode === "self-signed" && serverTls.ca) {
    fastify.log.info(
      {
        event: "tls.selfsigned",
        change: selfSignedChange,
        sans: serverTls.sans,
        caFingerprintSha256: serverTls.ca.fingerprintSha256,
      },
      (selfSignedChange === "minted-ca"
        ? "self-signed TLS: minted the deployment CA + server certificate (persisted — reused on every future boot). "
        : selfSignedChange === "reminted-leaf"
          ? "self-signed TLS: re-minted the server certificate from the persisted CA (new SANs / nearing expiry — trusted browsers stay green). "
          : "self-signed TLS: reusing the persisted CA + server certificate. ") +
        "Browsers warn until the CA is trusted once per device: download it from Console ▸ Settings ▸ HTTPS " +
        `(fingerprint ${serverTls.ca.fingerprintSha256.slice(0, 23)}…).`,
    );
  }
}

// Auth boot banner: secure by default; make the dev shortcuts loud.
if (!authConfig.enabled) {
  fastify.log.warn(
    { event: "auth.disabled" },
    "⚠️  AUTH IS DISABLED (AUTH_ENABLED=false): every /api/v1 route and the /admin WS are UNPROTECTED. " +
      "This is for tests/dev ONLY — never run a real deployment with auth disabled.",
  );
} else {
  if (authConfig.usingDevCookieSecret) {
    fastify.log.warn(
      { event: "auth.cookie.devsecret" },
      "⚠️  COOKIE_SECRET is unset — using a WELL-KNOWN DEV SECRET to sign session cookies. Set " +
        "COOKIE_SECRET to a long random value in any non-throwaway deployment.",
    );
  }
  // ── POL-70/D89: HTTPS is the default posture; plain HTTP degrades LOUDLY, never refuses. ──
  // Zero-click boot (non-negotiable #4) must keep working on a trusted plain-HTTP homelab, but the
  // POL-59/POL-67 audits both carry the caveat "the tunnel is as trustworthy as the network" —
  // HTTPS is the prerequisite for hostile networks, so serving auth over plain HTTP gets a banner.
  if (!authConfig.secureCookies) {
    fastify.log.warn(
      { event: "auth.cookie.insecure" },
      "⚠️  AUTH OVER PLAIN HTTP: session cookies are NOT marked `secure` " +
        (authConfig.publicScheme === "http"
          ? "(PUBLIC_BASE_URL is http://)"
          : "(SECURE_COOKIES unset / NODE_ENV≠production / no https PUBLIC_BASE_URL)") +
        " — operator passwords and sessions ride the wire in CLEARTEXT, and the remote shell/DevTools " +
        "tunnels are only as trustworthy as the network (POL-59/POL-67 audits). Fine for localhost or " +
        "a trusted lab LAN; ANY OTHER DEPLOYMENT MUST BE SERVED OVER HTTPS (ingress TLS or " +
        "TLS_CERT_FILE/TLS_KEY_FILE) — Secure cookies then follow automatically from an https " +
        "PUBLIC_BASE_URL (POL-70/D89).",
    );
  } else if (authConfig.publicScheme === "https") {
    fastify.log.info(
      { event: "auth.cookie.secure" },
      "session cookies are Secure (https PUBLIC_BASE_URL) — the operator surface is HTTPS end to end.",
    );
  }
}

// Prominent boot banner: OPEN MODE auto-approves every agent (dev default) — make it loud.
if (enrollment.open) {
  fastify.log.warn(
    { event: "enrollment.open" },
    "⚠️  ENROLLMENT IS OPEN: POLYPTIC_BOOTSTRAP_TOKEN is unset — every agent that connects is " +
      "auto-registered AND auto-approved (Phase 2a behaviour). Set POLYPTIC_BOOTSTRAP_TOKEN to " +
      "require a bootstrap token + operator approval (gated enrollment).",
  );
} else {
  fastify.log.info(
    { event: "enrollment.gated" },
    "enrollment GATED: agents must present the bootstrap token (first contact) or a durable " +
      "credential; new machines appear pending and await operator approval.",
  );
}

async function shutdown(signal: string): Promise<void> {
  fastify.log.info({ event: "server.shutdown", signal }, "shutting down");
  capture.stop();
  tokens.stop();
  pageData.stop();
  scheduler.stop();
  agentMtlsChannel?.server.close();
  try {
    await fastify.close();
  } catch (err) {
    fastify.log.warn({ event: "server.shutdown.error", err: String(err) }, "error closing fastify");
  }
  try {
    await store.close();
  } catch (err) {
    fastify.log.warn({ event: "store.close.error", err: String(err) }, "error closing store");
  }
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(
    {
      event: "server.listening",
      port: PORT,
      host: HOST,
      scheme: nativeTls ? "https (native TLS)" : "http",
      ws: ["/agent", "/player", "/admin"],
      corsOrigin: CORS_ORIGIN,
      playerBaseUrl: PLAYER_BASE_URL,
      store: storeKind,
      enrollment: enrollment.open ? "open" : "gated",
      // POL-134 — the boot log answers the operator's question in one word: required, migrating,
      // or off (and when off under the default-on posture, WHY).
      agentMtls: agentMtlsChannel
        ? `:${agentMtlsEnv.port} (${agentMtlsPosture?.required ? "required" : "migrating"})`
        : `off${agentMtlsOffDetail ? ` — ${agentMtlsOffDetail}` : ""}`,
      revision: control.state.revision,
      screens: control.getScreens().length,
      machines: control.getMachines().length,
    },
    "polyptic control plane up",
  );
} catch (err) {
  fastify.log.error(err, "failed to start");
  process.exit(1);
}
