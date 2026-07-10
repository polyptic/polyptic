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

import { ActivateImageBody, ImageUpdateInfo, RebuildImageBody, UpdateImageSettingsBody } from "@polyptic/protocol";

import { ActivityLog } from "./activity";
import { AdminBroadcaster, AdminHub, Presence } from "./admin";
import { AuthService, authConfigFromEnv } from "./auth-local";
import { registerAuthRoutes } from "./auth-routes";
import { CaptureCoordinator, ThumbnailStore } from "./capture";
import { Enrollment } from "./enroll";
import { AgentHub, PlayerHub } from "./hub";
import { MediaStore, registerMediaServeRoute } from "./media";
import { DEFAULT_RETAIN_BUILDS, ImageUpdates } from "./image-updates";
import { registerOpsRoutes } from "./ops";
import { computeBaseUrl, provisionBootSummary, provisionConfigFromEnv, registerProvisionRoutes } from "./provision";
import { registerRestRoutes } from "./rest";
import { registerSpaHosting, spaConfigFromEnv } from "./spa";
import { ControlPlane } from "./state";
import { createStore } from "./store";
import { TokenService } from "./tokens";
import { attachWebSockets } from "./ws";

import { ServerToPlayerRender } from "@polyptic/protocol";

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
  // shim's UEFI HTTP Boot fetch requests its second stage as <dir>//grubx64.efi (double slash, D47).
  ignoreDuplicateSlashes: true,
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
  // Collapse duplicate slashes the SAME way find-my-way does under ignoreDuplicateSlashes (above),
  // or the gate desyncs from the router: `//api/v1/x` would route to the real handler while this
  // raw-url check saw a leading `//`, failed startsWith, and skipped requireAuth entirely (bypass).
  const path = (request.url.split("?")[0] ?? request.url).replace(/\/{2,}/g, "/");
  if (!path.startsWith("/api/v1/")) return;
  if (AUTH_PUBLIC_PATHS.has(path)) return;
  await auth.requireAuth(request, reply);
});

registerAuthRoutes(fastify, auth, enrollment);
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
  },
  tokens,
  activity,
  presence,
);
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
// TOP-LEVEL, UNGATED provisioning routes (the netboot depot + GET /dist/agent/:arch) — NOT /api/v1,
// so a machine with no operator session can boot and enrol entirely from the server.
const provisionConfig = provisionConfigFromEnv();

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
);
imageUpdates.start();

// Pass the live enrollment singleton so GET /boot/grub.cfg (POL-33/D47) bakes the CURRENT token, the
// same one the agent WS accepts, so a regenerate re-keys the netboot flow on the next boot with no drift.
// The last argument lands a box's bootloader-install verdict (POL-58) in the Live Activity feed: the
// operator finds out whether the install took from the console, not by rebooting the box to see.
registerProvisionRoutes(fastify, provisionConfig, enrollment, imageUpdates, (severity, text) => {
  activity.push(severity, text);
  broadcaster.broadcast();
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
  tokens.stop();
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
