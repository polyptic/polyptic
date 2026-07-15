<script setup lang="ts">
/**
 * Polyptic player — the headless page shown fullscreen on one wall screen.
 *
 * Identity is the single `?screen=<id>` URL param. We dial the player WS, send `player/hello`, and
 * render whatever `server/render` pushes — applying every change by DOM diff, never a reload. That
 * "instant" property (DECISIONS D5) is the whole point of the player, so it is load-bearing here:
 *
 *   - Surfaces are rendered by a KEYED `v-for` (`:key="surface.id"`). When a new slice arrives we
 *     replace the array; Vue reconciles BY key, so a surface that kept its id keeps its DOM node.
 *   - The iframe/img/video `:src` is bound reactively. When only a surface's url changes, Vue
 *     patches that one attribute on the EXISTING element — the iframe is never remounted, so the
 *     page navigates in place with no white flash / reload.
 *
 * POL-86 — proven-before-painted: a surface's element is only given a `src` once the SurfaceProber
 * has PROVEN that URL reachable (a `no-cors` fetch that rejects on network failure). Until then the
 * region shows a calm placeholder — an unattended wall must never show Chrome's sad face or a
 * broken-image icon, and on a cold boot the content URL routinely becomes reachable a beat AFTER
 * the player itself is up (Wi-Fi association, DNS settling — the exact boot that shipped broken).
 * The prober re-proves on browser network hints, on media error events, and shortly after each
 * paint; `painted` maps surface id → the proven URL the element may show. Every step is written
 * through `diag()` (console + localStorage + the server's own log), so the next failed boot
 * EXPLAINS ITSELF instead of needing a human with DevTools.
 *
 * Phase 3b — video-wall spans: a surface may carry `span` {contentW,contentH,offsetX,offsetY}.
 * Such a surface shows only this screen's slice of a larger spanning content: we size the content
 * to contentW×contentH px and translate it by -(offsetX,offsetY) px inside the region (which is
 * `overflow:hidden`), so each member screen paints its window onto the same content. A surface
 * WITHOUT span fills its region exactly as before. The span numbers are computed server-side from
 * the union bounding box of the members' placements; player and server must agree — so we consume
 * them verbatim.
 *
 * POL-57 — page zoom: a framed surface (web/dashboard) may carry `zoom`. We do what a browser's zoom
 * control does: render the iframe at 1/zoom of the space it must fill, then `scale(zoom)` it back up.
 * The embedded page therefore sees a proportionally SMALLER CSS viewport and lays itself out bigger —
 * media queries, `vw` units and `rem` sizing all respond as they would at that browser zoom, which a
 * naive `transform: scale()` on a full-size frame would not achieve. Zoom composes with span (the
 * scale is applied before the span's translate), so a video wall zooms as one continuous page. It is
 * a pure restyle of the SAME keyed element: the iframe rescales without navigating or reloading (D5).
 *
 * POL-32 — cached media: images and videos are downloaded once into an IndexedDB blob cache and the
 * elements are pointed at `blob:` object URLs, so a network outage cannot stall a looping video or
 * break an image; the last-good slice is persisted to localStorage and restored on startup, so a
 * player that boots or reloads while the control plane is unreachable shows the wall's last-known
 * content (from the blob cache) instead of an idle splash. The blob swap rides the POL-86 prober:
 * `mediaSrc()` prefers the blob, so the probe target changes network→blob, the (local, offline-safe)
 * blob probe passes, and the element repaints from the cache — the same proven-before-painted path
 * as everything else. Sites (iframes) are already as safe as a client can make them — a WS drop
 * never blanks or reloads a frame — but what a live page does when ITS network calls fail is the
 * page's own business. See media-cache.ts for the full story.
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import type { CSSProperties } from "vue";
import type { Geometry, ServerToPlayerMessage, Surface } from "@polyptic/protocol";
import { PlayerSocket } from "./ws";
import type { ConnState } from "./ws";
import { SurfaceProber } from "./surface-prober";
import { bindDiagSender, diag, flushDiag, initDiag, redactUrl } from "./diag";
import { resolveMediaSrc, serverAuthority } from "./media-url";
import { contentStyle as spanContentStyle, isAgentPlacedWindow } from "./surface-style";
import { PageCanvas } from "@polyptic/elements";
import PlaylistRotator from "./PlaylistRotator.vue";
import { MediaCache } from "./media-cache";
import type { WantedMedia } from "./media-cache";
import { openIdbMediaStore } from "./media-cache-idb";
import { loadLastSlice, saveLastSlice } from "./last-slice";
import { applyAudio, ensurePlaying, surfaceAudio } from "./audio";
import { initShellWorker, shellFromCache, shellServerContact } from "./sw-register";
import IdleSplash from "./IdleSplash.vue";

// Injected by Vite (see vite.config.ts) from package.json — the build version shown on the idle splash.
const APP_VERSION = __APP_VERSION__;

// Reach the control plane at the host THIS page was loaded from — so a remote wall box works, not just
// localhost. `serverAuthority` maps the dev player port 5173→8080 (prod serves both same-origin); we
// use the SAME authority for the /player WS and for re-homing media URLs, so the two never disagree.
const SERVER_AUTHORITY = serverAuthority(window.location);
// https → wss.
const SERVER_WS_URL = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${SERVER_AUTHORITY}/player`;
// HTTP base for the same origin — where uploaded media (`/media/<id>`) is served (see `mediaSrc`).
const SERVER_HTTP_BASE = `${window.location.protocol}//${SERVER_AUTHORITY}`;
const DEFAULT_CANVAS: Geometry = { x: 0, y: 0, w: 1920, h: 1080 };

/** Read `?screen=<id>` from the URL — the one piece of identity this page is launched with. */
function readScreenId(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get("screen") ?? "").trim();
}

/** POL-54 — read `?token=<bearer>` from the URL: the screen's player token, minted by the server
 *  into the playerUrl the agent launched us with. Echoed in every `player/hello`; a gated server
 *  (auth enabled) rejects hellos without it. Empty on dev stacks with auth off — that's fine. */
function readPlayerToken(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const token = (params.get("token") ?? "").trim();
  return token.length > 0 ? token : undefined;
}

/** POL-46 — `?pending=<machineId>`: the board a machine shows on every output while it waits for an
 *  operator to approve it. It has no screen (and so no player WS) yet; this page is purely a sign. */
function readPendingMachineId(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get("pending") ?? "").trim();
}

const pendingMachineId = readPendingMachineId();

/** POL-117 — `&ident=1` alongside `?pending=`: the operator asked this still-pending box to flash so
 *  they know which physical panel they're approving. The server re-points the holding board at this
 *  variant over the AGENT channel (a pending box has no player WS), so "ident on" is simply this
 *  page with the overlay up, and "ident off" is the plain board again. */
const pendingIdent =
  pendingMachineId !== "" && new URLSearchParams(window.location.search).get("ident") === "1";

const screenId = readScreenId();
const playerToken = readPlayerToken();

// Diagnostics first (POL-86 priority A): from here on, every load-bearing step writes a line —
// console + localStorage ring + (once the WS opens) the server's pod log. `initDiag` also replays
// the tail of a PREVIOUS page-life, so a boot someone refreshed away still tells its story.
initDiag();
diag(`player booted — screen=${screenId || "(none)"} v${APP_VERSION} online=${navigator.onLine}`);

// The screen's friendly name (as named in the console). The server stamps it onto every render, so
// this relabels live when an operator renames the screen — no reload (POL-29). Until the first render
// lands we fall back to the raw id, so a just-launched player still shows *something* sensible.
const screenName = ref(screenId);

// Reactive render state. `surfaces` is replaced wholesale on each render; the keyed v-for diffs it.
const canvas = ref<Geometry>({ ...DEFAULT_CANVAS });
const surfaces = ref<Surface[]>([]);
const connState = ref<ConnState>("connecting");
const revision = ref(-1);
const ident = ref<{ friendlyName: string; color: string } | null>(null);

// POL-6 — corner status-badge visibility is a fleet-wide setting the server pushes over the player WS
// (`server/settings`), no longer the build-time `import.meta.env.DEV` flag. We seed it from DEV so a dev
// build shows the badge instantly on load (and prod hides it) until the authoritative value lands right
// after the first render; an operator's console toggle then flips it live on every screen.
const showBadges = ref<boolean>(import.meta.env.DEV);
// POL-119 — this screen accepts casting (AirPlay receiver armed). Stamped on every render like
// `friendlyName`; shown as a glyph in the status badge so someone at the glass can tell.
const castEnabled = ref<boolean>(false);

// POL-136 — the AirPlay pairing PIN to show fullscreen RIGHT NOW (null = no pairing). Server-pushed
// (`server/cast-pin`) and server-cleared; the local timeout is a backstop so a lost clear frame or a
// dead server can never strand a four-digit code on the wall. Matches the agent-side TTL.
const castPin = ref<string | null>(null);
const CAST_PIN_BACKSTOP_MS = 150_000;
let castPinTimer: ReturnType<typeof setTimeout> | undefined;

function setCastPin(pin: string | null): void {
  if (castPinTimer !== undefined) {
    clearTimeout(castPinTimer);
    castPinTimer = undefined;
  }
  castPin.value = pin;
  if (pin !== null) {
    castPinTimer = setTimeout(() => {
      castPin.value = null;
      castPinTimer = undefined;
      diag("cast PIN overlay cleared by local backstop timeout");
    }, CAST_PIN_BACKSTOP_MS);
  }
}

// Pre-first-render the revision is -1; show an em-dash until the first slice lands.
const revLabel = computed(() => (revision.value < 0 ? "—" : String(revision.value)));

// POL-34 — a playlist whose every referenced source was deleted still occupies a surface slot but has
// nothing to paint; treat a slice of only such husks as "no content" so the idle splash (POL-27)
// shows instead of a silent black panel.
const hasRenderable = computed(() =>
  surfaces.value.some((s) => s.type !== "playlist" || s.items.length > 0),
);

let socket: PlayerSocket | undefined;

// ── POL-32: media blob cache ─────────────────────────────────────────────────
// Resolved network URL → live `blob:` object URL. `mediaSrc` prefers the blob, so once a media file
// is cached the element renders entirely from the box and a network outage cannot touch it. The map
// is REPLACED (not mutated) on change so Vue tracks it as one reactive value.
const blobSrcs = ref<ReadonlyMap<string, string>>(new Map());
let mediaCache: MediaCache | undefined;

/** The media URLs the current surfaces want, resolved to what the box actually fetches. Uploaded
 *  control-plane media (`/media/<id>`) is immutable by construction (a re-upload mints a new id),
 *  so it caches forever; anything else revalidates in the background. */
function wantedMedia(): WantedMedia[] {
  const wanted: WantedMedia[] = [];
  for (const surface of surfaces.value) {
    if (surface.type !== "image" && surface.type !== "video") continue;
    const url = resolveMediaSrc(surface.src, SERVER_HTTP_BASE);
    wanted.push({ url, immutable: url.startsWith(`${SERVER_HTTP_BASE}/media/`) });
  }
  return wanted;
}

/**
 * A blob for `url` is ready (or was refreshed): repoint the rendered element at it. The swap rides
 * the prober (probe target changes network→blob; the old frame stays up until the blob proves), and
 * the keyed DOM node survives — only its src patches. A VIDEO reloads on a src change, so its
 * playback position is carried across the swap: captured now, restored on the element's next
 * `loadedmetadata` (attached up front — the repaint lands a prober round-trip later, not nextTick).
 */
function publishBlobSrc(url: string, objectUrl: string): void {
  const previous = blobSrcs.value.get(url);
  for (const el of surfaceEls.values()) {
    if (!(el instanceof HTMLVideoElement)) continue;
    const src = el.getAttribute("src");
    const onThisMedia =
      el.currentSrc === url ||
      src === url ||
      (previous !== undefined && (el.currentSrc === previous || src === previous));
    if (!onThisMedia) continue;
    const time = el.currentTime;
    el.addEventListener(
      "loadedmetadata",
      () => {
        try {
          el.currentTime = time;
        } catch {
          // A refreshed (shorter) file may reject the old position — playing from 0 is fine.
        }
        el.play().catch(() => {});
      },
      { once: true },
    );
  }
  blobSrcs.value = new Map(blobSrcs.value).set(url, objectUrl);
  diag(`media cached: ${redactUrl(url)} now serves from the box`);
}

/** Persist the current slice so a boot/reload during an outage can restore it (POL-32). */
function persistSlice(): void {
  saveLastSlice(localStorage, screenId, {
    canvas: canvas.value,
    surfaces: surfaces.value,
    revision: Math.max(revision.value, 0),
    friendlyName: screenName.value,
    showBadges: showBadges.value,
    castEnabled: castEnabled.value,
    savedAt: Date.now(),
  });
}

function handleMessage(msg: ServerToPlayerMessage): void {
  if (msg.t === "server/render") {
    // Replace canvas + surfaces; Vue's keyed reconcile reuses DOM nodes for surfaces that kept
    // their id, patching only changed attributes (e.g. a web surface's url) — no reload.
    canvas.value = msg.slice.canvas;
    surfaces.value = msg.slice.surfaces;
    revision.value = msg.revision;
    // The name rides on every render, so a console rename relabels the idle splash / badge instantly.
    screenName.value = msg.friendlyName;
    // POL-119 — the cast toggle rides the same way (a toggle re-pushes the same-revision render).
    castEnabled.value = msg.castEnabled === true;
    diag(
      `render rev ${msg.revision}: ${
        msg.slice.surfaces.length === 0
          ? "no surfaces (idle splash)"
          : msg.slice.surfaces.map((s) => `${s.id}=${s.type}`).join(" ")
      }`,
    );
    // POL-32 — start caching what this render shows, and remember it for an outage boot.
    mediaCache?.sync(wantedMedia());
    persistSlice();
    // Close the reconcile loop so the control plane knows this screen is at this revision.
    socket?.send({ t: "player/ack", screenId, revision: msg.revision });
  } else if (msg.t === "server/settings") {
    // POL-6 — fleet-wide display settings: show/hide the corner status badge on this screen live.
    showBadges.value = msg.settings.showBadges;
    persistSlice();
  } else if (msg.t === "server/cast-pin") {
    // POL-136 — someone is standing at this panel with a phone that is asking for this code: the
    // receiver prints its pairing PIN to stdout only (it draws no window until mirroring starts),
    // so THIS overlay is the only thing that puts the number on the glass. Ephemeral like ident —
    // never persisted — with a local timeout backstop so a lost clear frame can't strand a code.
    setCastPin(msg.pin);
    diag(msg.pin === null ? "cast PIN overlay cleared" : "cast PIN overlay shown");
  } else {
    // server/ident-pulse → flash the friendly name so an operator can map physical panels.
    ident.value = msg.on ? { friendlyName: msg.friendlyName, color: msg.color } : null;
  }
}

// ── Proven-before-painted (POL-86) ─────────────────────────────────────────────
//
// `painted` holds, per surface id, the URL its element is allowed to show — set only after the
// prober's reachability probe passes. Until then the region renders the placeholder. Clearing an
// entry unmounts the element (used when media reports a failed load: a broken-image icon must not
// stay on the wall). See ./surface-prober.ts for the full reasoning and life cycle.

const painted = reactive<Record<string, string>>({});

/** surface id → its live element, so a heal can re-fetch it IN PLACE (the keyed node survives, D5). */
const surfaceEls = new Map<string, HTMLIFrameElement | HTMLImageElement | HTMLVideoElement>();

function bindEl(id: string, el: unknown): void {
  if (
    el instanceof HTMLIFrameElement ||
    el instanceof HTMLImageElement ||
    el instanceof HTMLVideoElement
  ) {
    surfaceEls.set(id, el);
  } else {
    surfaceEls.delete(id);
  }
}

/** POL-94 — surface id → the library source it is rendering (stamped by the server at send time).
 *  A report about an ad-hoc URL carries no sourceId; the server has nothing to attribute it to. */
const surfaceSourceIds = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const s of surfaces.value) if (s.sourceId) map[s.id] = s.sourceId;
  return map;
});

/**
 * POL-94 — tell the control plane what this box knows about its content. The prober fires only on a
 * CHANGE of verdict, so a healthy wall sends nothing and a dead dashboard sends one frame — the
 * console's library badge is live without anybody polling anything. The URL is redacted (origin +
 * path): the query is where the server stamps credentials at send time (POL-24), and a health report
 * must never carry one back off the box.
 */
function reportHealth(change: { id: string; url: string; state: "reachable" | "unreachable"; detail?: string }): void {
  if (!screenId) return;
  socket?.send({
    t: "player/surface-health",
    screenId,
    surfaceId: change.id,
    ...(surfaceSourceIds.value[change.id] ? { sourceId: surfaceSourceIds.value[change.id] } : {}),
    url: redactUrl(change.url),
    state: change.state,
    at: new Date().toISOString(),
    ...(change.detail ? { detail: change.detail } : {}),
  });
}

const prober = new SurfaceProber({
  paint: (id, url) => {
    painted[id] = url;
  },
  clear: (id) => {
    delete painted[id];
  },
  // Re-fetch WITHOUT rewriting the URL — a token the server stamped into the content URL at send
  // time (POL-24) survives, and the keyed element that makes flips instant (D5) is never remounted.
  reload: (id) => {
    const el = surfaceEls.get(id);
    if (!el) return;
    if (el instanceof HTMLVideoElement) el.load();
    else el.src = el.src;
  },
  onHealth: reportHealth,
  log: (msg) => diag(msg),
});

/** What each on-screen surface will actually fetch — the exact URLs the prober must prove.
 *  Playlist surfaces are EXCLUDED: a rotation has no single URL, and the rotator owns its own
 *  elements + timers (per-entry probing is a noted follow-up) — it renders ungated. Page surfaces
 *  (POL-42) are excluded for the same reason: a page renders locally (text/clock/shapes need no
 *  network) and its embeds carry send-time-resolved data with their own calm placeholders.
 *  Agent-placed WINDOW surfaces (POL-18) are excluded because the player fetches NOTHING for them —
 *  the content is a top-level window the agent places over the region; probing its URL would be
 *  probing on behalf of a load this page never makes. */
const probeTargets = computed(() =>
  surfaces.value
    .filter((s) => s.type !== "playlist" && s.type !== "page" && !isAgentPlacedWindow(s))
    .map((s) => ({ id: s.id, url: isFrame(s) ? s.url : mediaSrc(s) })),
);

watch(probeTargets, (targets) => prober.sync(targets), { immediate: true });

/** The element finished a real load. For media that is genuine health (no SOP wall); for an iframe
 *  it is merely "a page committed" — Chrome fires `load` for its own error page too. Logged either
 *  way: the load/abort timeline is exactly the evidence a broken boot used to destroy. */
function onContentLoad(id: string, kind: string): void {
  prober.elementLoaded(id);
  diag(`${id}: ${kind} fired load`);
}

/** Media told us outright that its fetch failed (e.g. aborted by ERR_NETWORK_CHANGED). This is the
 *  deterministic signal the first watchdog never listened for — the broken-image boot, seen. */
function onContentError(id: string, kind: string): void {
  diag(`${id}: ${kind} FAILED to load (element error event)`);
  // POL-32 — if what failed is a CACHED blob (torn write, corrupt download), re-proving it would
  // succeed forever (a local fetch can't fail) and re-paint the corpse. Drop the cache entry so the
  // prober's re-prove falls back to the network URL and a fresh download.
  const shown = painted[id];
  if (shown?.startsWith("blob:")) {
    for (const [url, objectUrl] of blobSrcs.value) {
      if (objectUrl !== shown) continue;
      const next = new Map(blobSrcs.value);
      next.delete(url);
      blobSrcs.value = next;
      void mediaCache?.discard(url);
      diag(`${id}: cached copy failed to decode — dropped ${redactUrl(url)} from the cache`);
      break;
    }
  }
  prober.elementError(id);
}

// Browser network hints — demoted from reload-triggers to probe-triggers. Any of them means
// in-flight loads may have been killed; the prober re-proves every surface and heals what it must.
function onOnline(): void {
  diag("browser reported online");
  prober.recheck("browser reported online");
}
function onOffline(): void {
  diag("browser reported OFFLINE"); // no recheck — probes would fail; `online` will follow
}
function onResourceError(event: Event): void {
  if (!(event.target instanceof HTMLElement)) return;
  // A CONTENT element's failure is handled by `onContentError` with its own backoff — it must NOT
  // also count as an "own page" hint, or every broken asset triggers a global recheck that bypasses
  // that backoff (a 1.5s hammer-loop, caught live by the diag trail on first verification).
  if (event.target.closest(".surface")) return;
  diag(`own-page resource failed: <${event.target.tagName.toLowerCase()}>`);
  prober.recheck("a page resource failed to load");
}

onMounted(() => {
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  window.addEventListener("error", onResourceError, true);

  // POL-132 — the player APP survives a page reload while the control plane is down: a service
  // worker serves the shell cache-first (prod builds only; ?sw=off is the kill switch). A newer
  // build swaps in only at a safe moment — when the player WS is open, i.e. the reload it costs
  // repaints instantly from the last-good slice and reconnects immediately.
  initShellWorker({
    log: diag,
    version: APP_VERSION,
    safeToSwap: () => connState.value === "open",
  });

  if (!screenId) {
    connState.value = "closed";
    return;
  }

  // POL-32 — restore the last-good slice BEFORE dialing: a normal boot paints last-known content
  // instantly, and a boot during an outage shows the wall instead of a splash. Display-only: the
  // restored revision is never ACKed; the first live render reconciles it (same keyed DOM diff).
  // Restoring `surfaces` fires the probeTargets watcher, so the prober starts proving immediately.
  const restored = loadLastSlice(localStorage, screenId);
  if (restored) {
    canvas.value = restored.canvas;
    surfaces.value = restored.surfaces;
    revision.value = restored.revision;
    screenName.value = restored.friendlyName;
    if (restored.showBadges !== undefined) showBadges.value = restored.showBadges;
    if (restored.castEnabled !== undefined) castEnabled.value = restored.castEnabled;
    // POL-132 acceptance line: a reload-from-cache must SAY it painted from cache in the trail.
    diag(
      shellFromCache()
        ? `shell from cache, restored slice rev ${restored.revision} (${restored.surfaces.length} surfaces)`
        : `restored last-good slice rev ${restored.revision} (${restored.surfaces.length} surfaces)`,
    );
  }

  // POL-32 — bring up the blob cache. If IndexedDB is unavailable the player runs uncached (media
  // straight off the network) — exactly the pre-POL-32 behaviour, never an error on the glass.
  void openIdbMediaStore().then((store) => {
    if (!store) {
      diag("media cache: IndexedDB unavailable — running uncached");
      return;
    }
    mediaCache = new MediaCache(store, {
      onReady: (url, objectUrl) => publishBlobSrc(url, objectUrl),
    });
    mediaCache.sync(wantedMedia());
    void mediaCache.prune();
  });

  let everOpen = false;
  socket = new PlayerSocket(
    SERVER_WS_URL,
    screenId,
    {
      onMessage: handleMessage,
      onState: (state) => {
        // Update the reactive state FIRST: everything below (and everything IT calls) must see the
        // socket's true state. shellServerContact()'s safe-swap gate once read a stale "connecting"
        // here and deferred a shell update at every contact, forever (caught in review) — the gate
        // no longer depends on this ordering (serverContact() IS the safe moment), but stale-state
        // callbacks are a bug class, not a one-off.
        connState.value = state;
        diag(`player socket ${state}`);
        if (state === "open") {
          // A RECONNECT (not the first connect) means the socket dropped — itself evidence the network
          // moved under us, and therefore that content loaded before the drop may be broken.
          if (everOpen) prober.recheck("player socket reconnected");
          everOpen = true;
          flushDiag();
          // POL-94 — the server forgets a screen's content health when it drops, so re-state what we
          // already know. Without this, a wall that reconnected while its dashboard was dead would
          // read "unknown" in the console until the URL changed state again — i.e. never.
          for (const change of prober.snapshot()) reportHealth(change);
          // POL-132 — server contact is the safe moment: revalidate the cached shell, and if a
          // newer build already finished installing, swap into it now (logged in the trail).
          shellServerContact();
        }
      },
    },
    playerToken,
  );
  bindDiagSender((line) => socket?.send({ t: "player/diag", screenId, ...line }) ?? false);
  socket.start();
});

onUnmounted(() => {
  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);
  window.removeEventListener("error", onResourceError, true);
  prober.stop();
  socket?.stop();
});

// ── Rendering helpers ────────────────────────────────────────────────────────

/** Map a surface's region (in canvas pixel space) onto the full viewport as percentages. */
function regionStyle(region: Geometry, c: Geometry): CSSProperties {
  const w = c.w || 1;
  const h = c.h || 1;
  return {
    left: `${((region.x - c.x) / w) * 100}%`,
    top: `${((region.y - c.y) / h) * 100}%`,
    width: `${(region.w / w) * 100}%`,
    height: `${(region.h / h) * 100}%`,
  };
}

/**
 * The size/transform of the CONTENT element (iframe/img/video) inside a surface. The span/zoom math
 * itself lives in surface-style.ts (shared with the playlist rotator, POL-34) — see there for the
 * full account of how span and zoom compose. In short:
 *
 * No span, no zoom → empty (CSS makes the element fill 100%×100% of the region, as before).
 *
 * With span → the content is sized to the FULL spanning content (contentW×contentH px) and shifted
 * by -(offsetX,offsetY) px, so the region (overflow:hidden) reveals only this screen's slice. In a
 * production deployment the player runs fullscreen at the screen's native resolution, so canvas px
 * == viewport px and these literal pixels line up exactly; the region→viewport mapping above places
 * the slice. transform-origin:top-left keeps the offset anchored to the region's top-left corner.
 *
 * With zoom (framed surfaces only, POL-57) → the element is laid out at 1/zoom of the box it must end
 * up filling and scaled back up, so the page inside sees a proportionally smaller CSS viewport. The
 * two compose: transforms apply right-to-left, so `translate(…) scale(…)` scales the frame FIRST and
 * then shifts the already-full-size result by the span offset — the translate stays in un-scaled
 * region pixels, exactly as the server's span math assumes.
 */
function contentStyle(surface: Surface, zoom = 1): CSSProperties {
  return spanContentStyle(surface.span, zoom);
}

/** Style for an image/video element: span sizing (if any) plus the image's object-fit. Media has no
 *  page to zoom — an image is already scaled to its region by `fit`. */
function mediaStyle(surface: Surface): CSSProperties {
  const style = contentStyle(surface);
  if (surface.type === "image") style.objectFit = surface.fit;
  return style;
}

/** Style for a web/dashboard iframe: span sizing plus the operator's page zoom (POL-57). */
function frameStyle(surface: Surface): CSSProperties {
  return contentStyle(surface, isFrame(surface) ? surface.zoom : 1);
}

/** The two surface kinds rendered in an iframe — the only ones that carry a url and a zoom. */
type FramedSurface = Extract<Surface, { type: "web" | "dashboard" }>;

function isFrame(surface: Surface): surface is FramedSurface {
  return surface.type === "web" || surface.type === "dashboard";
}
function mediaSrc(surface: Surface): string {
  const raw = surface.type === "image" || surface.type === "video" ? surface.src : "";
  // Re-home a loopback-baked media URL onto the origin this box reaches the server at (POL-5): a
  // remote wall can't fetch `http://localhost:8080/media/<id>`. External URLs pass through untouched.
  const resolved = resolveMediaSrc(raw, SERVER_HTTP_BASE);
  // POL-32 — prefer the cached blob. `probeTargets` computes through here, so when a blob lands the
  // surface's probe target flips network→blob and the prober repaints from the cache (offline-safe:
  // a local blob fetch proves even with the control plane dead).
  return blobSrcs.value.get(resolved) ?? resolved;
}
/** POL-42 — re-home URLs INSIDE a page's data bundle (resolved image sources etc.) the same way
 *  top-level media is re-homed (POL-5): a remote wall can't fetch `http://localhost:8080/...`. */
function rehomeMediaSrc(src: string): string {
  return resolveMediaSrc(src, SERVER_HTTP_BASE);
}

function isInteractive(surface: Surface): boolean {
  return surface.type === "web" ? surface.interactive : false;
}
/** POL-109 — the ingest poster frame for a video surface, re-homed like its src (POL-5). The <video>
 *  paints it while the file buffers: the black gap between "surface arrives" and "first frame decodes"
 *  is exactly the flash this ticket set out to remove. */
function videoPoster(surface: Surface): string | undefined {
  const raw = surface.type === "video" ? surface.poster : undefined;
  return raw ? resolveMediaSrc(raw, SERVER_HTTP_BASE) : undefined;
}
function videoLoop(surface: Surface): boolean {
  return surface.type === "video" ? surface.loop : true;
}
/**
 * POL-112 — the surface's audio intent, straight off the wire. The player no longer decides: the flag
 * the control plane sent is the flag the element gets (a surface that carries none is silent).
 */
function videoAudio(surface: Surface) {
  return surfaceAudio(surface);
}

/** Re-apply audio to the elements already on the wall whenever the intent changes. The elements are
 *  keyed by surface id and SURVIVE the push (D5), so unmuting a wall does not restart the clip — the
 *  volume simply comes up on the video that is already playing. */
watch(
  () => surfaces.value.map((s) => `${s.id}:${JSON.stringify(surfaceAudio(s))}`).join("|"),
  () => {
    for (const surface of surfaces.value) {
      const el = surfaceEls.get(surface.id);
      if (el instanceof HTMLVideoElement) void applyVideoAudio(surface, el);
    }
  },
);

/** Apply the intent, then make sure the element is actually PLAYING: an unmuted autoplay that the
 *  browser's policy refuses (surf/Xwayland, a dev browser, no `--autoplay-policy` flag) falls back to
 *  muted playback rather than freezing the wall on a dead frame. The fallback is logged, never fatal. */
async function applyVideoAudio(surface: Surface, el: HTMLVideoElement): Promise<void> {
  const intent = surfaceAudio(surface);
  applyAudio(el, intent);
  if (intent.muted) return; // a muted element autoplays everywhere; nothing to rescue
  const outcome = await ensurePlaying(el);
  if (outcome === "muted-fallback") {
    diag(`${surface.id}: unmuted autoplay was BLOCKED by the browser — playing muted instead`);
  } else if (outcome === "blocked") {
    diag(`${surface.id}: playback was blocked by the browser even muted`);
  }
}

/** The video element has data: it is safe to apply audio and (if unmuted) to force playback. */
function onVideoReady(surface: Surface, event: Event): void {
  onContentLoad(surface.id, "video");
  const el = event.target;
  if (el instanceof HTMLVideoElement) void applyVideoAudio(surface, el);
}

function connLabel(state: ConnState): string {
  switch (state) {
    case "open":
      return "live";
    case "connecting":
      return "connecting";
    case "closed":
      return "offline";
  }
}

</script>

<template>
  <!--
    POL-46 — awaiting approval. Same board as the idle splash so a waiting wall reads as intentional
    rather than dead, and tells the operator exactly what to do. No WS: a pending machine has no
    screen to subscribe to. The amber dot says "waiting", not "broken".
  -->
  <template v-if="pendingMachineId">
    <IdleSplash
      :name="pendingMachineId"
      conn-state="connecting"
      :version="APP_VERSION"
      sub="Pending Approval"
      caption="Approve this machine in Console ▸ Machines"
    />
    <!-- POL-117 — pre-approval ident: the same flash overlay approved screens get, labelled with the
         machine id (the one identity a pending box has), so the operator can match panel to card. -->
    <div v-if="pendingIdent" class="ident" style="background-color: #00c2ff">
      <span class="ident-name pending-ident-name">{{ pendingMachineId }}</span>
    </div>
  </template>

  <div v-else-if="!screenId" class="notice">
    <p>
      No screen specified. Append <code>?screen=screen-1</code> to the URL.
    </p>
  </div>

  <main v-else class="stage">
    <!--
      No surfaces assigned to this screen → show the idle splash instead of a bare black stage
      (POL-27). It sits below the ident overlay and dev badge (higher z-index), so both still work.
    -->
    <IdleSplash
      v-if="!hasRenderable"
      :name="screenName"
      :conn-state="connState"
      :version="APP_VERSION"
    />

    <!--
      Keyed by surface.id so the SAME DOM element survives content changes (the "instant" trick):
      a url change patches the existing element's src in place; no remount, no reload.

      POL-86: the element renders only once its URL is PROVEN reachable (`painted[surface.id]`);
      until then the region shows the calm placeholder. src is bound to the PROVEN url, not the
      raw surface url — a not-yet-proven change keeps the old content up while the new url proves.
    -->
    <div
      v-for="surface in surfaces"
      :key="surface.id"
      class="surface"
      :style="regionStyle(surface.region, canvas)"
    >
      <!-- POL-34: the rotator owns its own elements and timers, and renders ungated (a rotation
           has no single URL for the prober to prove; each entry swap is local). -->
      <PlaylistRotator
        v-if="surface.type === 'playlist'"
        :surface="surface"
        :server-http-base="SERVER_HTTP_BASE"
      />
      <!-- POL-42: a page renders locally through the shared elements package (the Studio previews
           with the SAME renderer). Ungated like the rotator — its embeds arrive with send-time
           resolved data and paint their own calm placeholders when it's absent. -->
      <div
        v-else-if="surface.type === 'page'"
        class="surface-page"
        :style="contentStyle(surface)"
      >
        <PageCanvas
          :definition="surface.definition"
          :data="surface.data"
          :resolve-src="rehomeMediaSrc"
          live
        />
      </div>
      <!-- POL-18: an agent-placed WINDOW surface is a hole — the real content is a top-level
           browser window the agent floats over this region. Render nothing (a transparent region,
           never a placeholder dot: the window above is the content, and a spinner peeking out from
           under it would read as a fault). NOTE, honestly: the player's badge/ident overlays CANNOT
           sit above an OS-level window — they win the page's z-order, not the compositor's. -->
      <div
        v-else-if="isAgentPlacedWindow(surface)"
        class="surface-window-hole"
        aria-hidden="true"
      />
      <template v-else-if="painted[surface.id]">
        <iframe
          v-if="isFrame(surface)"
          :ref="(el) => bindEl(surface.id, el)"
          class="surface-frame"
          :class="{ 'is-interactive': isInteractive(surface) }"
          :src="painted[surface.id]"
          :style="frameStyle(surface)"
          allow="autoplay; encrypted-media; fullscreen; clipboard-read; clipboard-write"
          @load="onContentLoad(surface.id, 'frame')"
        />
        <img
          v-else-if="surface.type === 'image'"
          :ref="(el) => bindEl(surface.id, el)"
          class="surface-media"
          :src="painted[surface.id]"
          :style="mediaStyle(surface)"
          alt=""
          @load="onContentLoad(surface.id, 'image')"
          @error="onContentError(surface.id, 'image')"
        />
        <video
          v-else-if="surface.type === 'video'"
          :ref="(el) => bindEl(surface.id, el)"
          class="surface-media"
          :src="painted[surface.id]"
          :poster="videoPoster(surface)"
          :style="mediaStyle(surface)"
          autoplay
          playsinline
          :loop="videoLoop(surface)"
          :muted="videoAudio(surface).muted"
          :volume="videoAudio(surface).volume"
          @loadeddata="onVideoReady(surface, $event)"
          @error="onContentError(surface.id, 'video')"
        />
      </template>
      <!-- URL not yet proven reachable: a calm placeholder, never a sad face / broken-image icon. -->
      <div v-else class="surface-loading" aria-hidden="true">
        <span class="surface-loading-dot" />
      </div>
    </div>

    <div v-if="ident" class="ident" :style="{ backgroundColor: ident.color }">
      <span class="ident-name">{{ ident.friendlyName }}</span>
    </div>

    <!-- POL-136 — the AirPlay pairing PIN, fullscreen and unmissable: at pairing time the receiver
         draws nothing (its window only appears once mirroring starts), so this overlay is the only
         way the person at the panel can read the code their phone is asking for. Static — no
         animation at all (wall-chrome motion rules, D66). Above ident: a pairing in progress
         outranks a mapping flash. -->
    <div v-if="castPin" class="cast-pin">
      <span class="cast-pin-title">Enter this code on your device</span>
      <span class="cast-pin-code">{{ castPin }}</span>
      <span class="cast-pin-hint">{{ screenName }} · Screen Mirroring</span>
    </div>

    <div v-if="showBadges" class="badge">
      <span class="badge-dot" :class="`badge-dot--${connState}`" />
      <span class="badge-text">{{ connLabel(connState) }}</span>
      <span class="badge-sep">·</span>
      <span class="badge-text">{{ screenName }}</span>
      <span class="badge-sep">·</span>
      <span class="badge-text">rev {{ revLabel }}</span>
      <!-- POL-119 — this screen accepts casting. Static inline SVG with literal currentColor
           (wall-UI rules: no fill="var()" attrs, no animated opacity/transform/filter). -->
      <template v-if="castEnabled">
        <span class="badge-sep">·</span>
        <svg
          class="badge-cast"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-label="casting enabled"
        >
          <path d="M5 17a9 9 0 0 1 14 0" opacity="0.45" />
          <path d="M12 15l4.5 6h-9z" fill="currentColor" stroke="none" />
        </svg>
      </template>
    </div>
  </main>
</template>
