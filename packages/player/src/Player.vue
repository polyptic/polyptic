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
 * Phase 3b — video-wall spans: a surface may carry `span` {contentW,contentH,offsetX,offsetY}.
 * Such a surface shows only this screen's slice of a larger spanning content: we size the content
 * to contentW×contentH px and translate it by -(offsetX,offsetY) px inside the region (which is
 * `overflow:hidden`), so each member screen paints its window onto the same content. A surface
 * WITHOUT span fills its region exactly as before. The span numbers are computed server-side from
 * the union bounding box of the members' placements; player and server must agree — so we consume
 * them verbatim.
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { CSSProperties } from "vue";
import type { Geometry, ServerToPlayerMessage, Surface } from "@polyptic/protocol";
import { PlayerSocket } from "./ws";
import type { ConnState } from "./ws";
import { resolveMediaSrc, serverAuthority } from "./media-url";
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

const screenId = readScreenId();

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

// Pre-first-render the revision is -1; show an em-dash until the first slice lands.
const revLabel = computed(() => (revision.value < 0 ? "—" : String(revision.value)));

let socket: PlayerSocket | undefined;

function handleMessage(msg: ServerToPlayerMessage): void {
  if (msg.t === "server/render") {
    // Replace canvas + surfaces; Vue's keyed reconcile reuses DOM nodes for surfaces that kept
    // their id, patching only changed attributes (e.g. a web surface's url) — no reload.
    canvas.value = msg.slice.canvas;
    surfaces.value = msg.slice.surfaces;
    revision.value = msg.revision;
    // Close the reconcile loop so the control plane knows this screen is at this revision.
    socket?.send({ t: "player/ack", screenId, revision: msg.revision });
  } else if (msg.t === "server/settings") {
    // POL-6 — fleet-wide display settings: show/hide the corner status badge on this screen live.
    showBadges.value = msg.settings.showBadges;
  } else {
    // server/ident-pulse → flash the friendly name so an operator can map physical panels.
    ident.value = msg.on ? { friendlyName: msg.friendlyName, color: msg.color } : null;
  }
}

onMounted(() => {
  if (!screenId) {
    connState.value = "closed";
    return;
  }
  socket = new PlayerSocket(SERVER_WS_URL, screenId, {
    onMessage: handleMessage,
    onState: (state) => {
      connState.value = state;
    },
  });
  socket.start();
});

onUnmounted(() => socket?.stop());

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
 * The size/transform of the CONTENT element (iframe/img/video) inside a surface.
 *
 * No span → empty (CSS makes the element fill 100%×100% of the region, as before).
 * With span → the content is sized to the FULL spanning content (contentW×contentH px) and shifted
 * by -(offsetX,offsetY) px, so the region (overflow:hidden) reveals only this screen's slice. In a
 * production deployment the player runs fullscreen at the screen's native resolution, so canvas px
 * == viewport px and these literal pixels line up exactly; the region→viewport mapping above places
 * the slice. transform-origin:top-left keeps the offset anchored to the region's top-left corner.
 */
function spanStyle(surface: Surface): CSSProperties {
  const span = surface.span;
  if (!span) return {};
  return {
    width: `${span.contentW}px`,
    height: `${span.contentH}px`,
    maxWidth: "none",
    maxHeight: "none",
    transform: `translate(${-span.offsetX}px, ${-span.offsetY}px)`,
    transformOrigin: "top left",
  };
}

/** Style for an image/video element: span sizing (if any) plus the image's object-fit. */
function mediaStyle(surface: Surface): CSSProperties {
  const style = spanStyle(surface);
  if (surface.type === "image") style.objectFit = surface.fit;
  return style;
}

function isFrame(surface: Surface): boolean {
  return surface.type === "web" || surface.type === "dashboard";
}
function frameUrl(surface: Surface): string {
  return surface.type === "web" || surface.type === "dashboard" ? surface.url : "";
}
function mediaSrc(surface: Surface): string {
  const raw = surface.type === "image" || surface.type === "video" ? surface.src : "";
  // Re-home a loopback-baked media URL onto the origin this box reaches the server at (POL-5): a
  // remote wall can't fetch `http://localhost:8080/media/<id>`. External URLs pass through untouched.
  return resolveMediaSrc(raw, SERVER_HTTP_BASE);
}
function isInteractive(surface: Surface): boolean {
  return surface.type === "web" ? surface.interactive : false;
}
function videoLoop(surface: Surface): boolean {
  return surface.type === "video" ? surface.loop : true;
}
function videoMuted(surface: Surface): boolean {
  return surface.type === "video" ? surface.muted : true;
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
  <div v-if="!screenId" class="notice">
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
      v-if="surfaces.length === 0"
      :screen-id="screenId"
      :conn-state="connState"
      :version="APP_VERSION"
    />

    <!--
      Keyed by surface.id so the SAME DOM element survives content changes (the "instant" trick):
      a url change patches the existing iframe's src in place; no remount, no reload.
    -->
    <div
      v-for="surface in surfaces"
      :key="surface.id"
      class="surface"
      :style="regionStyle(surface.region, canvas)"
    >
      <iframe
        v-if="isFrame(surface)"
        class="surface-frame"
        :class="{ 'is-interactive': isInteractive(surface) }"
        :src="frameUrl(surface)"
        :style="spanStyle(surface)"
        allow="autoplay; encrypted-media; fullscreen; clipboard-read; clipboard-write"
      />
      <img
        v-else-if="surface.type === 'image'"
        class="surface-media"
        :src="mediaSrc(surface)"
        :style="mediaStyle(surface)"
        alt=""
      />
      <video
        v-else-if="surface.type === 'video'"
        class="surface-media"
        :src="mediaSrc(surface)"
        :style="mediaStyle(surface)"
        autoplay
        playsinline
        :loop="videoLoop(surface)"
        :muted="videoMuted(surface)"
      />
    </div>

    <div v-if="ident" class="ident" :style="{ backgroundColor: ident.color }">
      <span class="ident-name">{{ ident.friendlyName }}</span>
    </div>

    <div v-if="showBadges" class="badge">
      <span class="badge-dot" :class="`badge-dot--${connState}`" />
      <span class="badge-text">{{ connLabel(connState) }}</span>
      <span class="badge-sep">·</span>
      <span class="badge-text">{{ screenId }}</span>
      <span class="badge-sep">·</span>
      <span class="badge-text">rev {{ revLabel }}</span>
    </div>
  </main>
</template>
