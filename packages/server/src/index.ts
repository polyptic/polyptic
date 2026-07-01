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

import { ActivityLog } from "./activity";
import { AdminBroadcaster, AdminHub, Presence } from "./admin";
import { AuthService, authConfigFromEnv } from "./auth-local";
import { registerAuthRoutes } from "./auth-routes";
import { CaptureCoordinator, ThumbnailStore } from "./capture";
import { Enrollment } from "./enroll";
import { AgentHub, PlayerHub } from "./hub";
import { MediaStore, registerMediaServeRoute } from "./media";
import { registerOpsRoutes } from "./ops";
import { provisionBootSummary, provisionConfigFromEnv, registerProvisionRoutes } from "./provision";
import { registerRestRoutes } from "./rest";
import { registerSpaHosting, spaConfigFromEnv } from "./spa";
import { ControlPlane } from "./state";
import { createStore } from "./store";
import { attachWebSockets } from "./ws";

import type { PersistedBootstrap } from "./store";
import type { FastifyReply, FastifyRequest } from "fastify";

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
// Max thumbnails held in memory at once (LRU cap).
const THUMBNAIL_CAPACITY = Number(process.env.CAPTURE_THUMBNAIL_CAP ?? 300);
const CORS_ORIGIN = (
  process.env.CORS_ORIGIN ??
  // 5173 player, 5175 Vue console.
  "http://localhost:5173,http://localhost:5175"
)
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);
const PLAYER_BASE_URL = process.env.PLAYER_BASE_URL ?? "http://localhost:5173";

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

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});

// ── Durable store: select by STORE env, run migrations, load persisted state ──
const { store, kind: storeKind } = createStore();
await store.migrate();

// ── Live Activity feed (D25): one bounded in-memory ring, shared by the control plane (content /
// combine / split / rename / scene emits) and the ws presence layer (machine + screen connect/drop). ──
const activity = new ActivityLog();

const control = new ControlPlane(store, activity);
await control.init();

// ── Enrollment policy (Phase 2b/3f): seed the bootstrap from the store; on first boot derive it from
// POLYPTIC_BOOTSTRAP_TOKEN (set → gated, unset → open). The Settings "regenerate" mutates it later. ──
let bootstrap: PersistedBootstrap | undefined = await store.getBootstrap();
if (!bootstrap) {
  const envToken = process.env.POLYPTIC_BOOTSTRAP_TOKEN?.trim();
  bootstrap =
    envToken && envToken.length > 0
      ? { mode: "gated", token: envToken }
      : { mode: "open", token: null };
  await store.setBootstrap(bootstrap);
}
const enrollment = new Enrollment(bootstrap.token ?? undefined);

const hub = new PlayerHub();
const agentHub = new AgentHub();
const adminHub = new AdminHub();
const presence = new Presence();
const broadcaster = new AdminBroadcaster({ control, playerHub: hub, presence, adminHub, activity, log: fastify.log });

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

// ── Local operator auth (Phase 3f / D29): argon2id passwords, signed http-only session cookies. ──
const authConfig = authConfigFromEnv();
await fastify.register(cookie, { secret: authConfig.cookieSecret });
const auth = new AuthService({ store, fastify, config: authConfig, log: fastify.log });

// Sweep any sessions that expired while the server was down, then seed an admin if none exist.
await store.deleteExpiredSessions(new Date().toISOString());
await auth.seedAdmin();

// THE GATE: require a valid session on every /api/v1/** route except the public auth endpoints. The
// device channels (/agent, /player), health/metrics and the WS upgrades are NOT /api/v1 and untouched.
fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
  if (!auth.enabled) return;
  const path = request.url.split("?")[0] ?? request.url;
  if (!path.startsWith("/api/v1/")) return;
  if (AUTH_PUBLIC_PATHS.has(path)) return;
  await auth.requireAuth(request, reply);
});

registerAuthRoutes(fastify, auth, enrollment);
registerRestRoutes(fastify, control, hub, agentHub, broadcaster, capture, media, {
  publicBase: MEDIA_PUBLIC_BASE,
  maxBytes: Number.isFinite(MEDIA_MAX_BYTES) && MEDIA_MAX_BYTES > 0 ? MEDIA_MAX_BYTES : 200 * 1024 * 1024,
});
// TOP-LEVEL media serve route (GET /media/:id) — NOT /api/v1, so UNgated: players + the public wall
// load uploads without a session, exactly like any external content URL (ids are unguessable).
registerMediaServeRoute(fastify, media);
// TOP-LEVEL ops endpoints (/healthz, /metrics) — NOT /api/v1, so UNgated for scrapers/liveness.
registerOpsRoutes(fastify, {
  control,
  agentHub,
  playerHub: hub,
  thumbnails,
  storeKind,
  version: BUILD_VERSION,
  revision: BUILD_REVISION,
  startedAt: STARTED_AT,
});
// TOP-LEVEL, UNGATED zero-touch provisioning routes (GET /install, /dist/agent/:arch, /dist/deps/**) —
// NOT /api/v1, so an edge box with no operator session can bootstrap itself entirely from the server.
const provisionConfig = provisionConfigFromEnv();
// Pass the live enrollment singleton so GET /boot.ipxe (POL-33) bakes the CURRENT token, the same one
// the agent WS accepts, so a regenerate re-keys the netboot flow on the next boot with no drift.
registerProvisionRoutes(fastify, provisionConfig, enrollment);
attachWebSockets({
  server: fastify.server,
  control,
  enrollment,
  auth,
  hub,
  agentHub,
  adminHub,
  presence,
  broadcaster,
  activity,
  capture,
  log: fastify.log,
  allowedOrigins: CORS_ORIGIN,
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

// Provisioning boot banner: report which zero-touch artifacts are present on disk (install template,
// agent binaries per arch, deps bundle root, netboot image + boot medium) so a misconfigured
// AGENT_DIST_DIR/DEPS_DIST_DIR/IMAGE_DIST_DIR/IPXE_DIST_DIR is obvious.
const provisionSummary = await provisionBootSummary(provisionConfig);
fastify.log.info(
  {
    event: "provision.dist",
    installScriptPath: provisionConfig.installScriptPath,
    installTemplate: provisionSummary.installTemplate ? "file" : "built-in-fallback",
    agentDistDir: provisionConfig.agentDistDir,
    agentDistDirExists: provisionSummary.agentDistDir,
    agentArm64: provisionSummary.agentArm64,
    agentAmd64: provisionSummary.agentAmd64,
    depsDistDir: provisionConfig.depsDistDir,
    depsDistDirExists: provisionSummary.depsDistDir,
    imageDistDir: provisionConfig.imageDistDir,
    imageDistDirExists: provisionSummary.imageDistDir,
    imageAmd64: provisionSummary.imageAmd64,
    ipxeDistDir: provisionConfig.ipxeDistDir,
    bootMediumAmd64: provisionSummary.bootMediumAmd64,
  },
  `provisioning: install=${provisionSummary.installTemplate ? "template" : "fallback"} ` +
    `agent[arm64=${provisionSummary.agentArm64} amd64=${provisionSummary.agentAmd64}] ` +
    `deps-dir=${provisionSummary.depsDistDir} ` +
    `netboot[image-amd64=${provisionSummary.imageAmd64} medium-amd64=${provisionSummary.bootMediumAmd64}]`,
);

// Start the periodic live-preview capture sweep (no-op when CAPTURE_INTERVAL_MS=0).
capture.start();

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
  if (!authConfig.secureCookies) {
    fastify.log.warn(
      { event: "auth.cookie.insecure" },
      "session cookies are NOT marked `secure` (SECURE_COOKIES unset / NODE_ENV≠production) so they " +
        "work over http on localhost — PRODUCTION MUST BE SERVED OVER HTTPS with SECURE_COOKIES=true.",
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
      ws: ["/agent", "/player", "/admin"],
      corsOrigin: CORS_ORIGIN,
      playerBaseUrl: PLAYER_BASE_URL,
      store: storeKind,
      enrollment: enrollment.open ? "open" : "gated",
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
