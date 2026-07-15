<script setup lang="ts">
/**
 * POL-108 — a LIVE surface: an HLS feed (camera, channel) rendered on a wall screen.
 *
 * Why this is not a `<video src>`: Chrome — the wall browser (D67) — has NO native HLS. It plays a
 * `.m3u8` exactly as well as it plays a text file: not at all. The only way to show a live feed in
 * Chrome is Media Source Extensions, i.e. a JS pipeline that fetches the playlist, fetches segments
 * and appends them to a SourceBuffer. We bundle `hls.js` for that, and it is BUNDLED, never a CDN
 * script: a wall box may have no internet beyond the control plane, and a player that fetches its
 * own video engine off the public web is a player that shows nothing on the boxes that matter most.
 *
 * Is a library a vendor dependency? No — the non-negotiable is that no VENDOR is hard-wired into a
 * core code path: no vendor's dashboard, no vendor's IdP, no vendor's camera. The contract here is
 * `StreamSurface.protocol` (an enum: hls today, whep declared), a vendor-neutral, standards-based
 * seam. hls.js is a rendering DETAIL of the player behind that seam, swappable without a contract
 * change — exactly as Vue is. Safari (native HLS) is used directly when present and hls.js is skipped.
 *
 * Failure is the interesting half, and it lives in ./stream-engine.ts — read that first. In short:
 * hls.js retries a segment on its own; a FATAL error or a silent STALL (frames stop, no event fires)
 * re-attaches the pipeline with backoff; and a feed that stays dead is handed back to the POL-86
 * prober, which re-proves the playlist URL forever and repaints when the source returns. At no point
 * is there a black rectangle: the board says, in English, what is wrong.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { CSSProperties } from "vue";
import Hls from "hls.js";
import type { StreamSurface } from "@polyptic/protocol";
import { StreamEngine } from "./stream-engine";
import type { StreamHealth } from "./stream-engine";
import StreamBoard from "./StreamBoard.vue";

const props = defineProps<{
  surface: StreamSurface;
  /** The PROVEN-reachable url (POL-86) — the element is never pointed at an unproven one. */
  src: string;
  /** Span/zoom sizing computed by the player, applied to the video element (video-wall slices). */
  contentStyle: CSSProperties;
  /** Human label for the board — the feed's host. */
  label: string;
}>();

const emit = defineEmits<{
  (e: "health", health: StreamHealth, detail: string): void;
  (e: "giveup", reason: string): void;
  (e: "log", message: string): void;
}>();

const videoEl = ref<HTMLVideoElement | null>(null);
const health = ref<StreamHealth>("connecting");
const detail = ref("connecting to the live stream");

let hls: Hls | undefined;

/**
 * Tearing a pipeline down FIRES AN ERROR EVENT on the element (Chrome: `MEDIA_ELEMENT_ERROR: Empty
 * src attribute`). Caught in live verification: the engine read its own teardown as "the source
 * failed", chewed through all four reconnects in a second, and the feed never came back even after
 * the camera did — the wall reported a dead feed that was, by then, alive. So a short window after
 * every detach, element errors are OURS and are ignored; the pipeline's own fatal errors (hls.js) are
 * the truth about the source, and they carry a real reason.
 */
let ownErrorsUntil = 0;
const OWN_ERROR_WINDOW_MS = 1_500;

/** Native HLS (Safari/iOS) — then the element plays the playlist itself and MSE is not needed. */
function nativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType("application/vnd.apple.mpegurl") !== "";
}

/** A protocol this build cannot play (`whep`, today) is stated on the glass, not silently black. */
const unsupported = computed<string | null>(() => {
  if (props.surface.protocol !== "hls") {
    return `this player build cannot play ${props.surface.protocol.toUpperCase()} streams yet`;
  }
  return null;
});

function attach(): void {
  const video = videoEl.value;
  if (!video) return;
  // A `<video>` that has ERRORED stays errored: `video.error` survives, and attaching a fresh
  // MediaSource to it fails instantly (Chrome: DEMUXER_ERROR_COULD_NOT_PARSE) — forever, even once
  // the source is healthy again. Caught in live verification: the camera came back and the wall
  // stayed dead, re-attaching into a poisoned element. Only the media load algorithm clears the
  // error, so the element is RESET before every attach.
  resetElement(video);

  if (nativeHls(video)) {
    video.src = props.src;
    void video.play().catch(() => {});
    return;
  }

  if (!Hls.isSupported()) {
    // No MSE at all (a very old browser, or MSE disabled): honest board, no retry loop.
    engine.stop();
    health.value = "down";
    detail.value = "this browser cannot play HLS (no Media Source Extensions)";
    emit("health", "down", detail.value);
    emit("giveup", detail.value);
    return;
  }

  hls = new Hls({
    // A wall joins a live edge and stays there; there is no back catalogue to keep in memory.
    liveDurationInfinity: true,
    backBufferLength: 30,
    enableWorker: true,
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    // Non-fatal errors are hls.js's own business — it retries the segment. Only what it gives up on
    // reaches the engine, which then owns the reconnect (and, eventually, the hand-back).
    if (!data.fatal) return;
    engine.fail(`${data.type}: ${data.details}`);
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    void videoEl.value?.play().catch(() => {});
  });
  hls.loadSource(props.src);
  hls.attachMedia(video);
}

/** Clear the element's src AND its sticky MediaError. `load()` is what actually resets `video.error`
 *  — and it fires an `error` event of its own ("Empty src attribute"), which is precisely why the
 *  own-error window exists. */
function resetElement(video: HTMLVideoElement): void {
  ownErrorsUntil = Date.now() + OWN_ERROR_WINDOW_MS;
  video.removeAttribute("src");
  video.load();
}

function detach(): void {
  hls?.destroy(); // detaches the MediaSource and releases the decoder
  hls = undefined;
  const video = videoEl.value;
  if (!video) return;
  resetElement(video);
}

/** The ELEMENT reported an error. Only trust it when it is not our own teardown, and quote what the
 *  browser actually said — "the video element rejected the stream" tells an operator nothing. */
function onVideoError(): void {
  if (Date.now() < ownErrorsUntil) return;
  const err = videoEl.value?.error;
  engine.fail(
    err ? `the browser rejected the stream (${err.message || `media error ${err.code}`})` : "the browser rejected the stream",
  );
}

const engine = new StreamEngine({
  attach,
  detach,
  /** The engine watches this advance — the only honest liveness signal (see stream-engine.ts). */
  mediaTime: () => videoEl.value?.currentTime ?? 0,
  onHealth: (h, d) => {
    health.value = h;
    detail.value = d;
    emit("health", h, d);
  },
  onGiveUp: (reason) => emit("giveup", reason),
  log: (msg) => emit("log", msg),
});

/** The prober healed this surface (network moved): re-attach the pipeline in place. */
function restart(reason: string): void {
  if (unsupported.value) return;
  engine.restart(reason);
}
defineExpose({ restart });

onMounted(() => {
  if (unsupported.value) {
    health.value = "down";
    detail.value = unsupported.value;
    emit("health", "down", detail.value);
    emit("log", `unsupported protocol: ${props.surface.protocol}`);
    return;
  }
  engine.start();
});

onUnmounted(() => engine.stop());

// The operator repointed this surface at another feed: same keyed element, new pipeline.
watch(
  () => props.src,
  () => {
    if (unsupported.value) return;
    engine.restart("the stream url changed");
  },
);
</script>

<template>
  <video
    v-show="!unsupported"
    ref="videoEl"
    class="surface-media surface-stream"
    :style="{ ...contentStyle, objectFit: surface.fit }"
    autoplay
    playsinline
    :muted="surface.muted"
    @error="onVideoError"
  />
  <!-- Frames are not arriving: say so, over the (frozen or empty) element. Never a black rectangle. -->
  <StreamBoard
    v-if="health !== 'live'"
    class="stream-board--overlay"
    :label="label"
    :health="health"
    :detail="detail"
  />
</template>
