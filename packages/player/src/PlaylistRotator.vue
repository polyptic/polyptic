<script setup lang="ts">
/**
 * PlaylistRotator (POL-34) — plays one playlist surface's carousel on this screen.
 *
 * The server ships the WHOLE resolved rotation in one surface and the player advances it locally
 * (see playlist.ts for the two modes and why). Rendering follows the same instant-swap discipline as
 * the main surface renderer: consecutive entries of the same element type PATCH the existing element
 * (an iframe navigates in place rather than remounting), and the NEXT entry's iframe/image is
 * pre-warmed invisibly behind the current one so a rotation never flashes a blank region.
 *
 * The rotation's identity is its structural signature (see rotationSignature): a send-time token
 * re-stamp keeps the current position, while any authored change — or a re-assignment's fresh
 * `startedAt` — restarts it.
 *
 * POL-112 — audio. This component used to hardcode `muted` on its video element, which made the
 * playlist surface's flag (which the protocol has always carried) a lie. It now applies the
 * surface's audio intent: one setting for the whole rotation, applied to whichever video entry is on
 * air. An unmuted autoplay the browser refuses degrades to MUTED playback (see ./audio.ts) — the wall
 * keeps its picture even where it cannot have sound.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { CSSProperties } from "vue";
import type { PlaylistEntry, Surface } from "@polyptic/protocol";
import { allTimed, entryHoldMs, rotationSignature, timedPosition } from "./playlist";
import { contentStyle } from "./surface-style";
import { resolveMediaSrc } from "./media-url";
import { applyAudio, ensurePlaying, surfaceAudio } from "./audio";
import { diag } from "./diag";

type PlaylistSurfaceT = Extract<Surface, { type: "playlist" }>;

const props = defineProps<{
  surface: PlaylistSurfaceT;
  /** The HTTP base the player reaches the server at — re-homes loopback-baked media URLs (POL-5). */
  serverHttpBase: string;
}>();

const index = ref(0);
let timer: ReturnType<typeof setTimeout> | undefined;

const items = computed<PlaylistEntry[]>(() => props.surface.items);
const current = computed<PlaylistEntry | undefined>(() =>
  items.value.length > 0 ? items.value[index.value % items.value.length] : undefined,
);
/** The entry after the current one — pre-warmed so the swap doesn't flash. Only meaningful with ≥2. */
const nextUp = computed<PlaylistEntry | undefined>(() =>
  items.value.length > 1 ? items.value[(index.value + 1) % items.value.length] : undefined,
);

/** Span sizing of the playlist surface applies to every entry element; a FRAMED entry additionally
 *  composes its own per-step zoom (POL-133) — the same 1/zoom-layout-then-scale a directly-assigned
 *  page gets (POL-57), so a dashboard reads the same whether it plays direct or in a rotation. */
const entryStyle = computed<CSSProperties>(() =>
  contentStyle(props.surface.span, current.value && isFrame(current.value) ? (current.value.zoom ?? 1) : 1),
);

function isFrame(entry: PlaylistEntry): boolean {
  return entry.kind === "web" || entry.kind === "dashboard";
}
function mediaSrc(entry: PlaylistEntry): string {
  return resolveMediaSrc(entry.url, props.serverHttpBase);
}

/** The rotation's audio intent (POL-112): the flag the server sent, never a hardcode. It is applied
 *  to the video element that is on air; the image/frame entries have nothing to sound. */
const audio = computed(() => surfaceAudio(props.surface));

/** Apply the intent to the entry's video element, then make sure it is actually PLAYING — an unmuted
 *  autoplay a browser refuses falls back to muted rather than stalling the rotation on a dead frame. */
async function onVideoReady(event: Event): Promise<void> {
  const el = event.target;
  if (!(el instanceof HTMLVideoElement)) return;
  const intent = audio.value;
  applyAudio(el, intent);
  if (intent.muted) return;
  const outcome = await ensurePlaying(el);
  if (outcome === "muted-fallback") {
    diag(`${props.surface.id}: playlist unmuted autoplay was BLOCKED — playing muted instead`);
  } else if (outcome === "blocked") {
    diag(`${props.surface.id}: playlist playback was blocked by the browser even muted`);
  }
}

/** Loop policy for a video entry: a TIMED video replays until its slot ends; an untimed video that is
 *  the whole playlist just loops forever; an untimed video in a longer rotation must actually END to
 *  yield the screen. */
function videoLoop(entry: PlaylistEntry): boolean {
  if (entry.durationSeconds !== undefined) return true;
  return items.value.length === 1;
}

function clearTimer(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
}

/** Sequential mode only: yield to the next entry and schedule its hold. */
function advance(): void {
  if (items.value.length === 0) return;
  index.value = (index.value + 1) % items.value.length;
  schedule();
}

/**
 * (Re)arm the rotation from the current state. Fully-timed lists re-DERIVE the position from the
 * clock at every boundary (drift cannot accumulate; wall members stay in phase); sequential lists arm
 * a hold timer for a timed entry and wait on `ended` for an untimed video.
 */
function schedule(): void {
  clearTimer();
  const list = items.value;
  if (list.length <= 1) return; // nothing to rotate; a lone untimed video loops via its attribute
  if (allTimed(list)) {
    const startedAtMs = Date.parse(props.surface.startedAt);
    const pos = timedPosition(list, Number.isFinite(startedAtMs) ? startedAtMs : Date.now(), Date.now());
    index.value = pos.index;
    // The floor keeps a boundary-instant fire from busy-looping; visually sub-250 ms is one frame.
    timer = setTimeout(schedule, Math.max(pos.remainingMs, 250));
    return;
  }
  const entry = current.value;
  if (!entry) return;
  const hold = entryHoldMs(entry);
  if (hold !== undefined) timer = setTimeout(advance, hold);
  // untimed video: onEnded advances
}

/** An untimed video finished — its cue to yield. Timed videos loop until their timer fires. */
function onEnded(): void {
  const entry = current.value;
  if (entry && entry.kind === "video" && entry.durationSeconds === undefined && items.value.length > 1) {
    advance();
  }
}

// Restart only when the rotation's IDENTITY changes; a token re-stamp or friendly-name re-push keeps
// the current position (the bound :src patches the live element in place instead).
watch(
  () => rotationSignature(items.value, props.surface.startedAt),
  () => {
    index.value = 0;
    schedule();
  },
);
onMounted(schedule);
onUnmounted(clearTimer);
</script>

<template>
  <template v-if="current">
    <iframe
      v-if="isFrame(current)"
      class="surface-frame"
      :src="current.url"
      :style="entryStyle"
      allow="autoplay; encrypted-media; fullscreen; clipboard-read; clipboard-write"
    />
    <img
      v-else-if="current.kind === 'image'"
      class="surface-media"
      :src="mediaSrc(current)"
      :style="entryStyle"
      alt=""
    />
    <video
      v-else
      :key="`video-${index}`"
      class="surface-media"
      :src="mediaSrc(current)"
      :style="entryStyle"
      autoplay
      playsinline
      :muted="audio.muted"
      :volume="audio.volume"
      :loop="videoLoop(current)"
      @loadeddata="onVideoReady"
      @ended="onEnded"
    />
  </template>

  <!-- Pre-warm the NEXT entry invisibly behind the current one (frames navigate + images decode
       before they're revealed). Videos are left alone: preloading them would race two decoders on
       kiosk-class GPUs for a swap the poster-less dark background already covers. -->
  <iframe
    v-if="nextUp && isFrame(nextUp) && !(current && isFrame(current))"
    class="playlist-preload"
    :src="nextUp.url"
    :style="contentStyle(surface.span, nextUp.zoom ?? 1)"
    aria-hidden="true"
    tabindex="-1"
  />
  <img
    v-else-if="nextUp && nextUp.kind === 'image'"
    class="playlist-preload"
    :src="mediaSrc(nextUp)"
    alt=""
    aria-hidden="true"
  />
</template>
