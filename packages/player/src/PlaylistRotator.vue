<script setup lang="ts">
/**
 * PlaylistRotator (POL-34, hardened by POL-110) — plays one playlist surface's carousel on this screen.
 *
 * The server ships the WHOLE resolved rotation in one surface and the player advances it locally
 * (see playlist.ts for the two modes and why). Rendering follows the same instant-swap discipline as
 * the main surface renderer: consecutive entries of the same element type PATCH the existing element
 * (an iframe navigates in place rather than remounting), and the NEXT entry is pre-warmed invisibly
 * behind the current one so a rotation never flashes a blank region.
 *
 * POL-110 — the rotation now obeys the same four rules every other surface already did:
 *
 *   PROVEN BEFORE PAINTED. Each entry is its own probe target on a SurfaceProber (id `<surface>#<i>`),
 *     the same class Player.vue uses — not a fork of it. An entry paints only once its URL is proven
 *     reachable; a dead one is SKIPPED (its slot is filled by the next healthy entry) and keeps being
 *     re-probed with backoff, so it rejoins the rotation the moment it heals. A ten-item playlist with
 *     one dead URL shows nine items — never Chrome's sad face.
 *   PHASE PRESERVED. Skipping changes WHAT a slot shows, never WHEN slots turn over: the timeline is
 *     still derived from the full item list against the shared anchor, so wall members that disagree
 *     about one entry's health still agree about every boundary (playlist.ts spells this out).
 *   CACHED. Entry media rides the POL-32 blob cache through `resolveSrc` — a rotation survives an
 *     outage exactly like a plain media surface.
 *   TRANSITIONED, CAREFULLY. `cut` is the default and always works. `crossfade` is an opacity
 *     animation, which D66 forbids on a software-rendering box, so it runs ONLY where the player has
 *     proven the box is GPU-accelerated (gpu.ts); everywhere else it silently, safely hard-cuts.
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import type { CSSProperties } from "vue";
import type { PlaylistEntry, Surface } from "@polyptic/protocol";
import {
  allTimed,
  displayIndexFor,
  entryProbeId,
  entryProbeIndex,
  prewarmIndex,
  rotationSignature,
  slotHoldMs,
  timedPosition,
} from "./playlist";
import { SurfaceProber } from "./surface-prober";
import { contentStyle } from "./surface-style";
import { resolveMediaSrc } from "./media-url";
import { diag } from "./diag";

type PlaylistSurfaceT = Extract<Surface, { type: "playlist" }>;

const props = defineProps<{
  surface: PlaylistSurfaceT;
  /** The HTTP base the player reaches the server at — re-homes loopback-baked media URLs (POL-5). */
  serverHttpBase: string;
  /** POL-110/POL-32 — resolve a media entry's URL the way the host page does: re-homed AND preferring
   *  the cached blob. Injected so the rotator shares ONE cache with the rest of the player. */
  resolveSrc?: (rawUrl: string) => string;
  /** POL-110/D66 — may this box be animated on? Only a GPU-proven box ever crossfades. */
  gpuAccelerated?: boolean;
}>();

const emit = defineEmits<{ (e: "media-error", src: string): void }>();

/** The canonical slot: which entry the timeline says is on air, healthy or not. Never re-timed. */
const canonical = ref(0);
/** entry index → the URL the prober has PROVEN it may paint. Absent = not (yet) healthy. */
const painted = reactive<Record<number, string>>({});
/** Inside the prewarm lead window of the current slot. */
const prewarmArmed = ref(false);

let timer: ReturnType<typeof setTimeout> | undefined;
let prewarmTimer: ReturnType<typeof setTimeout> | undefined;
let fadeTimer: ReturnType<typeof setTimeout> | undefined;

const items = computed<PlaylistEntry[]>(() => props.surface.items);

function healthy(index: number): boolean {
  return painted[index] !== undefined;
}

/** What actually goes on the glass (the canonical entry, or the next healthy one standing in). */
const displayIndex = computed<number | undefined>(() =>
  displayIndexFor(items.value, canonical.value, healthy),
);
const displayEntry = computed<PlaylistEntry | undefined>(() =>
  displayIndex.value === undefined ? undefined : items.value[displayIndex.value],
);

/** Span sizing of the playlist surface applies to every entry element (zoom does not — a playlist is
 *  not one page, POL-57 stays per-page content). */
const entryStyle = computed<CSSProperties>(() => contentStyle(props.surface.span));

function isFrame(entry: PlaylistEntry): boolean {
  return entry.kind === "web" || entry.kind === "dashboard";
}

/** The URL this entry's element WOULD fetch — the exact string the prober must prove. Media goes
 *  through the host page's resolver (re-homed + blob-cached); a frame carries its own real URL. */
function entrySrc(entry: PlaylistEntry): string {
  if (isFrame(entry)) return entry.url;
  return props.resolveSrc
    ? props.resolveSrc(entry.url)
    : resolveMediaSrc(entry.url, props.serverHttpBase);
}

/** Loop policy for a video entry: a TIMED video replays until its slot ends; an untimed video that is
 *  the whole playlist just loops forever; an untimed video in a longer rotation must actually END to
 *  yield the screen. */
function videoLoop(entry: PlaylistEntry): boolean {
  if (entry.durationSeconds !== undefined) return true;
  return items.value.length === 1;
}

// ── Per-entry probing (POL-110 on POL-86) ───────────────────────────────────

const entryEls = new Map<number, HTMLIFrameElement | HTMLImageElement | HTMLVideoElement>();

function bindEl(index: number, el: unknown): void {
  if (
    el instanceof HTMLIFrameElement ||
    el instanceof HTMLImageElement ||
    el instanceof HTMLVideoElement
  ) {
    entryEls.set(index, el);
  } else {
    entryEls.delete(index);
  }
}

const prober = new SurfaceProber({
  paint: (id, url) => {
    const index = entryProbeIndex(props.surface.id, id);
    if (index !== undefined) painted[index] = url;
  },
  clear: (id) => {
    const index = entryProbeIndex(props.surface.id, id);
    if (index !== undefined) delete painted[index];
  },
  reload: (id) => {
    const index = entryProbeIndex(props.surface.id, id);
    if (index === undefined) return;
    const el = entryEls.get(index);
    if (!el) return; // not on the glass right now — its next turn re-fetches it anyway
    if (el instanceof HTMLVideoElement) el.load();
    else el.src = el.src;
  },
  log: (msg) => diag(`playlist ${msg}`),
});

/** Every entry is a probe target, whether or not it is currently on air — a dead one must be proven
 *  again in the background so it can REJOIN the rotation, not only when its slot next comes round. */
const probeTargets = computed(() =>
  items.value.map((entry, index) => ({
    id: entryProbeId(props.surface.id, index),
    url: entrySrc(entry),
  })),
);
watch(probeTargets, (targets) => prober.sync(targets), { immediate: true, deep: true });

function onEntryLoad(index: number): void {
  prober.elementLoaded(entryProbeId(props.surface.id, index));
}

function onEntryError(index: number): void {
  const src = painted[index];
  if (src) emit("media-error", src); // a corrupt CACHED blob must be dropped, not re-proven forever
  diag(`playlist ${props.surface.id}#${index}: entry element FAILED to load`);
  prober.elementError(entryProbeId(props.surface.id, index));
}

// ── Scheduling ──────────────────────────────────────────────────────────────

function clearTimers(): void {
  if (timer !== undefined) clearTimeout(timer);
  if (prewarmTimer !== undefined) clearTimeout(prewarmTimer);
  timer = undefined;
  prewarmTimer = undefined;
}

/** Sequential mode only: yield to the next canonical entry and schedule its hold. */
function advance(): void {
  if (items.value.length === 0) return;
  canonical.value = (canonical.value + 1) % items.value.length;
  schedule();
}

/** Arm the prewarm window: `hold` ms from now the slot turns over, so buffer the next video when we
 *  are within the lead. An unknowable end (a playing untimed video) arms immediately — still bounded
 *  to ONE hidden element that is never played. */
function armPrewarm(hold: number | undefined): void {
  prewarmArmed.value = false;
  if (!props.surface.prewarmVideo || items.value.length < 2) return;
  const lead = props.surface.prewarmLeadMs;
  if (hold === undefined || hold <= lead) {
    prewarmArmed.value = true;
    return;
  }
  prewarmTimer = setTimeout(() => {
    prewarmTimer = undefined;
    prewarmArmed.value = true;
  }, hold - lead);
}

/**
 * (Re)arm the rotation from the current state. Fully-timed lists re-DERIVE the canonical slot from the
 * clock at every boundary (drift cannot accumulate; wall members stay in phase — and a locally-dead
 * entry does NOT change that derivation); sequential lists arm a hold timer for the slot and wait on
 * `ended` for an untimed video that is actually playing.
 */
function schedule(): void {
  clearTimers();
  const list = items.value;
  if (list.length <= 1) return; // nothing to rotate; a lone untimed video loops via its attribute
  if (allTimed(list)) {
    const startedAtMs = Date.parse(props.surface.startedAt);
    const pos = timedPosition(list, Number.isFinite(startedAtMs) ? startedAtMs : Date.now(), Date.now());
    canonical.value = pos.index;
    // The floor keeps a boundary-instant fire from busy-looping; visually sub-250 ms is one frame.
    const hold = Math.max(pos.remainingMs, 250);
    timer = setTimeout(schedule, hold);
    armPrewarm(hold);
    return;
  }
  const hold = slotHoldMs(list, canonical.value, displayIndex.value);
  if (hold !== undefined) timer = setTimeout(advance, hold);
  // hold === undefined: an untimed video is PLAYING; onEnded advances.
  armPrewarm(hold);
}

/** An untimed video finished — its cue to yield, but only if the slot was actually waiting on it. */
function onEnded(): void {
  const list = items.value;
  if (list.length <= 1 || allTimed(list)) return;
  if (slotHoldMs(list, canonical.value, displayIndex.value) === undefined) advance();
}

// ── Layers (the hard cut, and the opt-in crossfade) ─────────────────────────

type Layer = { slot: "a" | "b"; index: number; fadeIn: boolean };
/** [0] is the live entry; a second element exists only DURING a crossfade (the outgoing one). */
const layers = ref<Layer[]>([]);

/** D66 — an opacity animation is only ever allowed on a box we have PROVEN is GPU-accelerated. */
const crossfadeOn = computed(
  () => props.surface.transition === "crossfade" && props.gpuAccelerated === true,
);

watch(
  displayIndex,
  (next) => {
    if (next === undefined) {
      layers.value = [];
      return;
    }
    const live = layers.value[0];
    if (!live) {
      layers.value = [{ slot: "a", index: next, fadeIn: false }];
      return;
    }
    if (live.index === next) return;
    if (!crossfadeOn.value) {
      // The hard cut: SAME layer key, so the element patches in place (an iframe navigates, D5).
      layers.value = [{ slot: live.slot, index: next, fadeIn: false }];
      return;
    }
    // Crossfade: the incoming entry mounts on the other layer, above, and fades 0→1 over the outgoing
    // one — one animated element, for transitionMs, on a GPU box only.
    const slot = live.slot === "a" ? "b" : "a";
    layers.value = [{ slot, index: next, fadeIn: true }, { ...live, fadeIn: false }];
    if (fadeTimer !== undefined) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      fadeTimer = undefined;
      layers.value = layers.value.slice(0, 1);
    }, props.surface.transitionMs + 50);
  },
  { immediate: true },
);

// A slot that was WAITING on a video's `ended` has nothing to wait for once that video dies (it was
// never playing) — re-arm from whatever now stands in, or the rotation stalls on the dead entry.
watch(displayIndex, (next) => {
  const list = items.value;
  if (list.length <= 1 || allTimed(list) || timer !== undefined) return;
  const hold = slotHoldMs(list, canonical.value, next);
  if (hold !== undefined) timer = setTimeout(advance, hold);
});

// ── Prewarm (bounded: one hidden element, never played) ─────────────────────

const prewarmVideoIndex = computed<number | undefined>(() =>
  prewarmIndex(items.value, canonical.value, displayIndex.value, healthy, {
    enabled: props.surface.prewarmVideo,
    remainingMs: prewarmArmed.value ? 0 : Number.POSITIVE_INFINITY,
    leadMs: props.surface.prewarmLeadMs,
  }),
);

/** The next slot's entry when it is a FRAME or IMAGE — pre-warmed as it always was (POL-34): a frame
 *  navigates and an image decodes behind the current one, so the swap never flashes. */
const prewarmQuietIndex = computed<number | undefined>(() => {
  const list = items.value;
  if (list.length < 2) return undefined;
  const next = displayIndexFor(list, (canonical.value + 1) % list.length, healthy);
  if (next === undefined || next === displayIndex.value) return undefined;
  const entry = list[next];
  if (!entry) return undefined;
  if (isFrame(entry) && displayEntry.value && isFrame(displayEntry.value)) return undefined;
  return isFrame(entry) || entry.kind === "image" ? next : undefined;
});

const prewarmQuietEntry = computed<PlaylistEntry | undefined>(() =>
  prewarmQuietIndex.value === undefined ? undefined : items.value[prewarmQuietIndex.value],
);

// Restart only when the rotation's IDENTITY changes; a token re-stamp or friendly-name re-push keeps
// the current position (the bound :src patches the live element in place instead). A restart also
// forgets every entry's proven URL — index `i` is a DIFFERENT entry now, and nothing paints unproven.
watch(
  () => rotationSignature(items.value, props.surface.startedAt),
  () => {
    for (const key of Object.keys(painted)) delete painted[Number(key)];
    canonical.value = 0;
    schedule();
  },
);
onMounted(schedule);
onUnmounted(() => {
  clearTimers();
  if (fadeTimer !== undefined) clearTimeout(fadeTimer);
  prober.stop();
});
</script>

<template>
  <div
    v-for="(layer, depth) in layers"
    :key="layer.slot"
    class="playlist-layer"
    :class="{ 'playlist-layer--in': layer.fadeIn && depth === 0 }"
    :style="{ animationDuration: `${surface.transitionMs}ms` }"
  >
    <template v-if="items[layer.index] && painted[layer.index]">
      <iframe
        v-if="isFrame(items[layer.index]!)"
        :ref="(el) => bindEl(layer.index, el)"
        class="surface-frame"
        :src="painted[layer.index]"
        :style="entryStyle"
        allow="autoplay; encrypted-media; fullscreen; clipboard-read; clipboard-write"
        @load="onEntryLoad(layer.index)"
      />
      <img
        v-else-if="items[layer.index]!.kind === 'image'"
        :ref="(el) => bindEl(layer.index, el)"
        class="surface-media"
        :src="painted[layer.index]"
        :style="entryStyle"
        alt=""
        @load="onEntryLoad(layer.index)"
        @error="onEntryError(layer.index)"
      />
      <video
        v-else
        :key="`video-${layer.index}`"
        :ref="(el) => bindEl(layer.index, el)"
        class="surface-media"
        :src="painted[layer.index]"
        :style="entryStyle"
        autoplay
        playsinline
        muted
        :loop="videoLoop(items[layer.index]!)"
        @loadeddata="onEntryLoad(layer.index)"
        @error="onEntryError(layer.index)"
        @ended="onEnded"
      />
    </template>
  </div>

  <!-- Nothing in the rotation is provable right now (every entry dead, or none proven yet): the calm
       placeholder, never a broken frame. The prober keeps hunting; the first entry to prove paints. -->
  <div v-if="layers.length === 0" class="surface-loading" aria-hidden="true">
    <span class="surface-loading-dot" />
  </div>

  <!-- Pre-warm the NEXT entry invisibly behind the current one (frames navigate + images decode before
       they're revealed). Only PROVEN entries are pre-warmed — a probe is cheaper than a broken load. -->
  <iframe
    v-if="prewarmQuietEntry && isFrame(prewarmQuietEntry)"
    class="playlist-preload"
    :src="painted[prewarmQuietIndex!]"
    aria-hidden="true"
    tabindex="-1"
  />
  <img
    v-else-if="prewarmQuietEntry"
    class="playlist-preload"
    :src="painted[prewarmQuietIndex!]"
    alt=""
    aria-hidden="true"
  />

  <!-- POL-110 — the next entry's VIDEO buffers ahead of its slot. Exactly one, never played: it holds
       bytes, not a running decoder, so D84's two-decoders-on-a-kiosk-GPU worry cannot arise. -->
  <video
    v-if="prewarmVideoIndex !== undefined"
    :key="`prewarm-${prewarmVideoIndex}`"
    class="playlist-preload"
    :src="painted[prewarmVideoIndex]"
    preload="auto"
    muted
    playsinline
    aria-hidden="true"
    tabindex="-1"
  />
</template>
