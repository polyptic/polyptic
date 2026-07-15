/**
 * Polyptic player shell service worker (POL-132) — the player APP survives a page reload while the
 * control plane is down.
 *
 * POL-32/D83 made the CONTENT outage-proof (last-good slice in localStorage, media in an IndexedDB
 * blob cache) — but the player shell itself was still fetched from the control plane on every load,
 * so a reload mid-outage rendered the browser's "no available server" page and the wall stayed dark
 * until the server came back. The healing layer never ran, because the thing that would run it
 * couldn't load. This worker closes that hole: the shell (index.html + hashed JS/CSS/fonts) is
 * precached at install and served CACHE-FIRST forever after — a stale player that paints beats a
 * fresh 502.
 *
 * SCOPE DISCIPLINE — this worker handles the shell and NOTHING else:
 *   - Registered under the /player scope, so /api, /admin, /agent, /media and the console can never
 *     even reach it. WebSocket upgrades are not `fetch` events at all.
 *   - Within scope it still only answers (a) navigations to the player page and (b) requests whose
 *     path is on the build's precache list. Everything else — including credential-stamped dashboard
 *     URLs and any request carrying a Range header (media byte-ranges are D83's cache's business) —
 *     falls through to the network untouched.
 *
 * VERSION DISCIPLINE (D107 made version honesty matter) — the cache is keyed by build (version +
 * a fingerprint of the precache list), so a new build installs into its OWN cache alongside the old
 * one. This worker never decides when to take over: it waits until the PAGE posts
 * `polyptic/skip-waiting` — which the page only does at a safe moment (server contact), logging the
 * swap in the player.diag trail. Old caches are deleted on activate. A wall can therefore serve a
 * stale shell only while the control plane is unreachable; the next successful contact revalidates.
 *
 * This file is a TEMPLATE: build-sw.ts prepends `self.__POLYPTIC_SW__ = {…}` (shell URL, precache
 * list, version, cache name) at build time — the worker itself stays static and reviewable.
 */

/* global self, caches, fetch, URL, Request */

const CONFIG = self.__POLYPTIC_SW__;
const CACHE_NAME = CONFIG.cacheName;
const VERSION = CONFIG.version;
/** The player page URL ("/player/" in the single-image deploy) — the navigation cache key. */
const SHELL_URL = CONFIG.shellUrl;
/** Every path this build may serve from cache: the shell plus its hashed assets. */
const PRECACHE = CONFIG.precache;

const SHELL_PATH = new URL(SHELL_URL, self.location.href).pathname;
/** "/player/" → "/player": the bare no-trailing-slash navigation is the same page. */
const SHELL_PATH_BARE = SHELL_PATH.endsWith("/") ? SHELL_PATH.slice(0, -1) : SHELL_PATH;

self.addEventListener("install", (event) => {
  // `cache: "reload"` bypasses the HTTP cache — the precache must hold what the server has NOW,
  // not what some intermediary remembered. A failed install (e.g. registered mid-outage) simply
  // leaves the previous worker in charge; the browser retries on the next update check.
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })))),
  );
  // NO skipWaiting() here — swap timing belongs to the page (safe moment = server contact).
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // A new build's activation retires every older build's cache — the SW must never pin a wall
      // to an old shell past the moment a newer one has fully installed.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("polyptic-player-shell-") && n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      );
      // Claim pages already open, so the very first visit is protected without a reload.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.t === "polyptic/skip-waiting") {
    // The page decided this is the safe moment to swap builds (and logged it to player.diag).
    self.skipWaiting();
    return;
  }
  if (data.t === "polyptic/version" && event.ports && event.ports[0]) {
    // The page asks a waiting worker which build it carries, so the diag line can say
    // "shell from cache (vX) → updating to vY" honestly.
    event.ports[0].postMessage({ t: "polyptic/version", version: VERSION });
  }
});

/** A top-level navigation to the player page (any /player/<route> history path included). */
function isShellNavigation(request, url) {
  if (request.mode !== "navigate") return false;
  return url.pathname === SHELL_PATH_BARE || url.pathname.startsWith(SHELL_PATH);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Shell assets only — every guard here is a "return" WITHOUT respondWith, i.e. the browser
  // talks to the network exactly as if this worker did not exist.
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return; // media byte-ranges belong to D83's cache, never ours
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // dashboards/external content: not ours

  const navigation = isShellNavigation(request, url);
  const precached = PRECACHE.indexOf(url.pathname) !== -1;
  if (!navigation && !precached) return; // anything else in scope: pass through untouched

  event.respondWith(serveShell(event, navigation ? SHELL_URL : url.pathname, request, navigation));
});

/**
 * Cache-first with background revalidation: answer from this build's cache immediately; on a
 * navigation ALSO kick a registration update check, so a newer build (if one shipped) installs in
 * the background and the page swaps at its next safe moment. A cache miss (a request racing the
 * very first install) falls back to the network — exactly the pre-SW behaviour.
 */
async function serveShell(event, cacheKey, request, navigation) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(cacheKey);
  if (hit) {
    if (navigation && self.registration && typeof self.registration.update === "function") {
      event.waitUntil(self.registration.update().catch(() => {}));
    }
    return hit;
  }
  return fetch(request);
}
