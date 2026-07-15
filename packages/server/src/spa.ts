/**
 * Phase 8 — SPA HOSTING. Lets the control plane SERVE the built Console (and Player) SPAs straight
 * from disk so the Docker image is the WHOLE product: one artifact, same-origin. Same-origin is the
 * real simplification — the session cookie "just works", no cross-origin CORS dance.
 *
 * Two env knobs, both OPT-IN (when neither is set the behaviour is EXACTLY as before: API/WS only, the
 * Vite dev servers serve the SPAs in dev — so the 86 existing e2e are untouched):
 *
 *   - CONSOLE_DIR — a built Console dist (index.html + assets/…). Served at `/`:
 *       · GET /                 → the Console index.html
 *       · GET /assets/<file>    → the static asset, byte-for-byte
 *       · GET /<spa-route>      → index.html (history/SPA fallback; the client router takes over)
 *   - PLAYER_DIR — a built Player dist. Served under `/player` (its own SPA root):
 *       · GET /player, /player/ → the Player index.html
 *       · GET /player/<route>   → the Player index.html (its own history fallback)
 *
 * THE CRUCIAL INVARIANT: the SPA history fallback must NEVER shadow the API / device / ops / media
 * surfaces. Those routes are registered as real Fastify routes and WIN by route specificity; only
 * genuinely UNMATCHED requests reach the not-found handler here. Within it we still refuse to answer
 * the reserved prefixes (`/api`, `/admin`, `/agent`, `/healthz`, `/metrics`, `/media`, `/assets`) with
 * an SPA shell — an unmatched API route stays a real JSON 404 (so a typo doesn't look like a page).
 *
 * IMPLEMENTATION: @fastify/static is registered with `wildcard:false`, so it globs the built dist at
 * boot and registers a concrete route per file (no catch-all `/*`). That means a request for a file
 * that does NOT exist falls through to Fastify's single not-found handler, where we do the SPA
 * fallback ourselves — excluding the reserved prefixes and non-navigation (asset-looking) requests.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FastifyBaseLogger } from "fastify";

export interface SpaHostingConfig {
  /** Built Console dist (index.html + assets/…). When set, served at `/`. */
  consoleDir?: string;
  /** Built Player dist. When set, served under `/player`. */
  playerDir?: string;
}

/** Read the two SPA env knobs; empty/whitespace → undefined (the DEV default: nothing served). */
export function spaConfigFromEnv(): SpaHostingConfig {
  const consoleDir = process.env.CONSOLE_DIR?.trim();
  const playerDir = process.env.PLAYER_DIR?.trim();
  return {
    consoleDir: consoleDir && consoleDir.length > 0 ? consoleDir : undefined,
    playerDir: playerDir && playerDir.length > 0 ? playerDir : undefined,
  };
}

/**
 * Reserved request prefixes that the SPA fallback must NEVER answer with an index.html shell. These are
 * the API / device / ops / media / built-asset surfaces; an unmatched path under any of them stays a
 * real (JSON) 404 instead of masquerading as a working SPA route.
 */
function isReservedPath(path: string): boolean {
  if (path.startsWith("/api/") || path === "/api") return true;
  if (path.startsWith("/media/") || path === "/media") return true;
  if (path.startsWith("/assets/")) return true;
  if (path === "/healthz" || path === "/metrics") return true;
  if (path === "/admin" || path.startsWith("/admin/")) return true;
  if (path === "/agent" || path.startsWith("/agent/")) return true;
  return false;
}

/**
 * Decide whether an unmatched GET/HEAD looks like a NAVIGATION (deserves the SPA shell) versus an asset
 * fetch for a file that doesn't exist (deserves a 404). Heuristic: a navigation either accepts text/html
 * or has no file extension on its last path segment. A missing `/foo.js` (has an extension, not an html
 * accept) correctly 404s instead of returning HTML that the browser would try to execute as a script.
 */
function looksLikeNavigation(request: FastifyRequest, path: string): boolean {
  const accept = (request.headers.accept ?? "").toLowerCase();
  if (accept.includes("text/html")) return true;
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  return !lastSegment.includes(".");
}

/**
 * Register static hosting for whichever SPAs are configured, plus the single SPA history fallback.
 * No-op (and returns the empty list) when neither dir is set — preserving the API-only DEV behaviour.
 * Returns the human-readable list of what is being served, for the boot banner.
 */
export async function registerSpaHosting(
  fastify: FastifyInstance,
  config: SpaHostingConfig,
  log: FastifyBaseLogger,
): Promise<string[]> {
  const served: string[] = [];

  // Resolve + validate the configured dirs up front. A dir set but missing its index.html is almost
  // certainly a misconfiguration (forgot to `vite build`, wrong path) — warn loudly and skip it rather
  // than booting a half-served product.
  let consoleDir: string | undefined;
  if (config.consoleDir) {
    const abs = resolve(config.consoleDir);
    if (existsSync(resolve(abs, "index.html"))) {
      consoleDir = abs;
    } else {
      log.warn(
        { event: "spa.console.missing", dir: abs },
        "CONSOLE_DIR is set but has no index.html — NOT serving the Console SPA. Did the build run?",
      );
    }
  }

  let playerDir: string | undefined;
  if (config.playerDir) {
    const abs = resolve(config.playerDir);
    if (existsSync(resolve(abs, "index.html"))) {
      playerDir = abs;
    } else {
      log.warn(
        { event: "spa.player.missing", dir: abs },
        "PLAYER_DIR is set but has no index.html — NOT serving the Player SPA. Did the build run?",
      );
    }
  }

  if (!consoleDir && !playerDir) return served;

  // Per-file cache headers: hashed build assets are immutable and cache hard; index.html (the shell)
  // must stay revalidated so a redeploy's new asset hashes are actually picked up.
  const setHeaders = (res: { setHeader(name: string, value: string): void }, filePath: string): void => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache");
    } else if (playerDir && /[\\/]sw\.js$/.test(filePath) && filePath.startsWith(playerDir)) {
      // POL-132 — the PLAYER's shell service worker, matched against the player dist specifically:
      // a future console sw.js must not silently inherit a "/player" scope grant. `no-cache` so
      // the browser's update check always sees the deployed copy (a heuristically-cached sw.js
      // would pin walls to an old build), and `Service-Worker-Allowed: /player` so it may claim
      // the no-trailing-slash "/player" scope — wider than its /player/ directory, covering a
      // bare `/player?screen=…` navigation too.
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Service-Worker-Allowed", "/player");
    } else if (/[\\/]assets[\\/]/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  };

  // Console at the root. `wildcard:false` → a concrete route per built file, so a missing path falls
  // through to the not-found handler (our SPA fallback) instead of a static 404.
  if (consoleDir) {
    await fastify.register(fastifyStatic, {
      root: consoleDir,
      prefix: "/",
      wildcard: false,
      index: ["index.html"],
      cacheControl: false,
      setHeaders,
    });
    served.push(`console → / (${consoleDir})`);
  }

  // Player under /player. When the Console is ALSO served, this second @fastify/static registration must
  // NOT re-decorate `reply.sendFile` (the first one already did) — `decorateReply:false` avoids the clash.
  if (playerDir) {
    await fastify.register(fastifyStatic, {
      root: playerDir,
      prefix: "/player/",
      wildcard: false,
      index: ["index.html"],
      decorateReply: !consoleDir,
      cacheControl: false,
      setHeaders,
    });
    served.push(`player → /player (${playerDir})`);
  }

  // THE SINGLE NOT-FOUND HANDLER: SPA history fallback for genuinely-unmatched requests only. Real
  // routes (API/WS/ops/media + the static files above) never reach here. We send a JSON 404 for
  // reserved prefixes and non-navigation requests; otherwise the matching SPA shell.
  fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const path = (request.url.split("?")[0] ?? request.url) || "/";
    const method = request.method.toUpperCase();

    const realNotFound = (): FastifyReply =>
      reply.code(404).type("application/json; charset=utf-8").send({ error: "not found", path });

    // Only GET/HEAD navigations get the shell; everything else is a genuine 404.
    if (method !== "GET" && method !== "HEAD") return realNotFound();
    if (isReservedPath(path)) return realNotFound();

    // Player sub-tree: its own SPA root + history fallback (when PLAYER_DIR is served).
    if (playerDir && (path === "/player" || path.startsWith("/player/"))) {
      if (!looksLikeNavigation(request, path)) return realNotFound();
      return reply.type("text/html; charset=utf-8").sendFile("index.html", playerDir);
    }

    // Console history fallback (when CONSOLE_DIR is served).
    if (consoleDir) {
      if (!looksLikeNavigation(request, path)) return realNotFound();
      return reply.type("text/html; charset=utf-8").sendFile("index.html", consoleDir);
    }

    return realNotFound();
  });

  return served;
}
