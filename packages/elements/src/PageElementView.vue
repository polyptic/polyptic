<!--
  PageElementView — ONE page element's visual, filling whatever box its parent gives it.

  This is the single renderer behind both the wall (player → PageCanvas) and the console's Studio
  canvas: the pitch's anti-drift rule is that the preview IS the renderer, so there is deliberately
  no second "preview mode" implementation. The `live` flag only decides what to do where the two
  contexts genuinely differ:

    - live (the wall): embeds render their resolved iframe/media; a feed with no data yet shows a
      quiet skeleton, never fake headlines.
    - studio (live=false): embeds render a labelled placeholder card (an iframe would fight the
      editor's mouse), and feeds/weather show obviously-generic sample content so the layout reads.

  SIZING: everything scales in container-query units against the PAGE (the canvas root declares
  `container-type: size`), so one definition renders identically on a 300px studio canvas and a 4K
  panel. An element of height h (% of page) sizes its type at factors of `h` cqh, mirroring the
  design mockup's math. Radii/sizes authored "in px" are treated as px AT 1080p design scale
  (value / 10.8 → cqh).

  D66: nothing here animates opacity/transform/filter EXCEPT the ticker's scroll, which is the
  pitch's explicit, documented exception (plain CSS transform loop; primary target is the
  GPU-composited Chrome boxes — on software-rendered fallback boxes a ticker is an operator choice).
  Clock/countdown/feed-ages update text nodes on a shared 1 Hz timer. SVG colouring never uses
  `fill="var(…)"` presentation attributes.
-->
<script setup lang="ts">
import { computed } from "vue";
import type {
  PageData,
  PageElement,
  PageFeedItem,
} from "@polyptic/protocol";
import { formatAge, formatClock, formatCountdown, useNow } from "./clock";
import { qrSvgPath, qrModuleCount } from "./qr";
import { embedZoomStyle, feedFontSizes } from "./style";

const props = withDefaults(
  defineProps<{
    element: PageElement;
    /** The send-time data bundle (player) or a studio-built equivalent. */
    data?: PageData;
    /** true on the wall; false on the Studio canvas. */
    live?: boolean;
    /** Studio: the display name for an embed/image placeholder (the picked source's name). */
    label?: string;
    /** Player: re-home media URLs onto the origin the box reaches the server at (POL-5). */
    resolveSrc?: (src: string) => string;
  }>(),
  { live: true, data: undefined, label: undefined, resolveSrc: undefined },
);

const now = useNow();

/** Font-size (etc.) as a fraction of THIS element's height, in page container units. */
function cq(factor: number): string {
  return `${(props.element.h * factor).toFixed(2)}cqh`;
}

/** A design-scale "px" value (authored at 1080p) in container units. */
function designPx(value: number): string {
  return `${(value / 10.8).toFixed(2)}cqh`;
}

// ── embed ─────────────────────────────────────────────────────────────────────
const embedResolution = computed(() =>
  props.element.kind === "embed" ? props.data?.embeds?.[props.element.id] : undefined,
);
const embedLabel = computed(() => {
  if (props.label) return props.label;
  if (props.element.kind !== "embed") return "";
  if (props.element.props.url) return props.element.props.url.replace(/^https?:\/\//, "");
  return props.element.props.sourceId ? "Source unavailable" : "Pick a source";
});
/** POL-133 — the authored per-element page zoom, applied to the live frame the same way the player
 *  zooms a directly-assigned page (1/zoom layout, scale back up). Part of the composition, so the
 *  Studio preview and every wall agree by construction (D74). */
const embedZoom = computed(() =>
  props.element.kind === "embed" ? (props.element.props.zoom ?? 1) : 1,
);
const embedFrameStyle = computed(() => embedZoomStyle(embedZoom.value));

// ── image ─────────────────────────────────────────────────────────────────────
const imageSrc = computed(() => {
  if (props.element.kind !== "image") return undefined;
  const src = props.data?.images?.[props.element.id]?.src;
  if (!src) return undefined;
  return props.resolveSrc ? props.resolveSrc(src) : src;
});

// ── feed ──────────────────────────────────────────────────────────────────────
const SAMPLE_FEED: PageFeedItem[] = [
  { title: "Line 3 returns to full rate after maintenance" },
  { title: "Q3 energy usage down 8% on last year" },
  { title: "New visitor sign-in policy starts Monday" },
  { title: "Apprentice open evening — Thursday 18:00" },
  { title: "Car park B resurfacing next week" },
  { title: "Planned network window Sunday 06:00" },
  { title: "Canteen menu refreshed for autumn" },
  { title: "H&S audit passed with zero findings" },
];
const feedData = computed(() =>
  props.element.kind === "feed" ? props.data?.feeds?.[props.element.id] : undefined,
);
const feedItems = computed<PageFeedItem[]>(() => {
  if (props.element.kind !== "feed") return [];
  const count = props.element.props.items;
  if (feedData.value) return feedData.value.items.slice(0, count);
  return props.live ? [] : SAMPLE_FEED.slice(0, count);
});
const feedSkeletonCount = computed(() =>
  props.element.kind === "feed" && props.live && !feedData.value ? props.element.props.items : 0,
);
/** POL-133 — the card's three font sizes at the authored scale (100 = the pre-POL-133 sizing). */
const feedFonts = computed(() =>
  feedFontSizes(
    props.element.h,
    props.element.kind === "feed" ? (props.element.props.fontScale ?? 100) : 100,
  ),
);
const feedHeader = computed(() => {
  if (props.element.kind !== "feed") return "";
  if (feedData.value?.title) return feedData.value.title.toUpperCase();
  const domain = props.element.props.url.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  return (domain || "FEED").toUpperCase();
});

// ── clock / countdown ─────────────────────────────────────────────────────────
const clockText = computed(() =>
  props.element.kind === "clock"
    ? formatClock(now.value, props.element.props.format, props.element.props.seconds)
    : "",
);
const countdownText = computed(() =>
  props.element.kind === "countdown" ? formatCountdown(now.value, props.element.props.target) : "",
);

// ── weather ───────────────────────────────────────────────────────────────────
const weatherData = computed(() =>
  props.element.kind === "weather" ? props.data?.weather?.[props.element.id] : undefined,
);
const weatherTemp = computed(() => {
  if (props.element.kind !== "weather") return "";
  const units = props.element.props.units;
  if (weatherData.value) {
    const celsius = weatherData.value.tempC;
    return units === "F" ? `${Math.round((celsius * 9) / 5 + 32)}°F` : `${Math.round(celsius)}°C`;
  }
  // Studio sample so the layout reads; the wall shows an honest em-dash until data lands.
  if (!props.live) return units === "F" ? "64°F" : "18°C";
  return "—°";
});
const weatherSub = computed(() => {
  if (props.element.kind !== "weather") return "";
  if (weatherData.value) return `${weatherData.value.location} · ${weatherData.value.description}`;
  const location = props.element.props.location || "Weather";
  return props.live ? location : `${location} · partly cloudy`;
});
/** Coarse icon family for the WMO code (styled via stroke on currentColor — never fill="var()"). */
const weatherIcon = computed<"sun" | "partly" | "cloud" | "rain" | "snow" | "storm">(() => {
  const code = weatherData.value?.code;
  if (code === undefined) return "partly";
  if (code <= 1) return "sun";
  if (code === 2) return "partly";
  if (code === 3 || code === 45 || code === 48) return "cloud";
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  return "rain";
});

// ── qr ────────────────────────────────────────────────────────────────────────
const qrPath = computed(() =>
  props.element.kind === "qr" ? qrSvgPath(props.element.props.url) : undefined,
);
const qrModules = computed(() =>
  props.element.kind === "qr" ? qrModuleCount(props.element.props.url) : 0,
);

// ── ticker ────────────────────────────────────────────────────────────────────
const tickerDuration = computed(() => {
  if (props.element.kind !== "ticker") return 0;
  return Math.max(8, Math.round(1800 / (props.element.props.speed || 60)));
});
</script>

<template>
  <!-- EMBED -->
  <template v-if="element.kind === 'embed'">
    <iframe
      v-if="live && embedResolution && (embedResolution.kind === 'web' || embedResolution.kind === 'dashboard')"
      class="pel-embed-frame"
      :src="embedResolution.url"
      :style="embedFrameStyle"
      allow="autoplay; encrypted-media; fullscreen"
    />
    <img
      v-else-if="live && embedResolution && embedResolution.kind === 'image'"
      class="pel-embed-media"
      :src="resolveSrc ? resolveSrc(embedResolution.url) : embedResolution.url"
      alt=""
    />
    <video
      v-else-if="live && embedResolution && embedResolution.kind === 'video'"
      class="pel-embed-media"
      :src="resolveSrc ? resolveSrc(embedResolution.url) : embedResolution.url"
      autoplay
      playsinline
      loop
      muted
    />
    <div v-else class="pel-embed-placeholder">
      <svg class="pel-embed-chart" viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="0,44 12,38 24,41 36,30 48,33 60,22 72,26 84,15 100,19" fill="none" stroke="#3b82f6" stroke-width="1.4" />
        <polyline points="0,52 14,49 28,50 42,44 56,46 70,40 84,42 100,36" fill="none" stroke="#22c55e" stroke-width="1.1" opacity=".7" />
      </svg>
      <span class="pel-embed-kicker" :style="{ fontSize: `clamp(8px, ${cq(0.08)}, 2.2cqh)` }">EMBED</span>
      <span class="pel-embed-label" :style="{ fontSize: `clamp(11px, ${cq(0.14)}, 4cqh)` }">{{ embedLabel }}</span>
      <span class="pel-embed-note" :style="{ fontSize: `clamp(8px, ${cq(0.085)}, 2.2cqh)` }">
        credentials stamped by the control plane{{ embedZoom !== 1 ? ` · zoom ${Math.round(embedZoom * 100)}%` : "" }}
      </span>
    </div>
  </template>

  <!-- TICKER -->
  <div
    v-else-if="element.kind === 'ticker'"
    class="pel-ticker"
    :style="{ background: element.props.bg }"
  >
    <div
      class="pel-ticker-run"
      :style="{
        color: element.props.fg,
        fontSize: cq(0.42),
        animationDuration: `${tickerDuration}s`,
      }"
    >
      <span class="pel-ticker-text">{{ element.props.text || "…" }}</span>
      <span class="pel-ticker-text">{{ element.props.text || "…" }}</span>
    </div>
  </div>

  <!-- FEED -->
  <div v-else-if="element.kind === 'feed'" class="pel-feed">
    <span class="pel-feed-header" :style="{ fontSize: feedFonts.header }">{{ feedHeader }}</span>
    <template v-if="feedItems.length">
      <div v-for="(item, i) in feedItems" :key="i" class="pel-feed-item">
        <span class="pel-feed-title" :style="{ fontSize: feedFonts.title }">{{ item.title }}</span>
        <span class="pel-feed-meta" :style="{ fontSize: feedFonts.meta }">{{ formatAge(item.publishedAt, now) }}</span>
      </div>
    </template>
    <template v-else>
      <!-- Live wall, no data yet: quiet skeleton bars — never invented headlines. Static (D66). -->
      <div v-for="i in feedSkeletonCount" :key="i" class="pel-feed-item">
        <span class="pel-feed-skeleton" :style="{ width: `${88 - ((i * 17) % 30)}%` }" />
        <span class="pel-feed-skeleton pel-feed-skeleton--meta" />
      </div>
    </template>
  </div>

  <!-- IMAGE -->
  <template v-else-if="element.kind === 'image'">
    <img
      v-if="imageSrc"
      class="pel-image"
      :src="imageSrc"
      :style="{ objectFit: element.props.fit }"
      alt=""
    />
    <div v-else class="pel-image-placeholder">
      <span class="pel-image-glyph">▦</span>
      <span class="pel-image-label" :style="{ fontSize: `clamp(9px, ${cq(0.1)}, 2.6cqh)` }">{{ label ?? "Pick an image" }}</span>
    </div>
  </template>

  <!-- TEXT -->
  <div
    v-else-if="element.kind === 'text'"
    class="pel-text"
    :style="{
      color: element.props.color,
      fontSize: designPx(element.props.size),
      justifyContent:
        element.props.align === 'center' ? 'center' : element.props.align === 'right' ? 'flex-end' : 'flex-start',
      textAlign: element.props.align,
    }"
  >
    {{ element.props.text }}
  </div>

  <!-- CLOCK -->
  <div v-else-if="element.kind === 'clock'" class="pel-clock" :style="{ color: element.props.color, fontSize: cq(0.52) }">
    {{ clockText }}
  </div>

  <!-- SHAPE -->
  <div
    v-else-if="element.kind === 'shape'"
    class="pel-shape"
    :style="{
      background: element.props.fill,
      borderRadius: designPx(element.props.radius),
      opacity: element.props.opacity / 100,
    }"
  />

  <!-- WEATHER -->
  <div v-else-if="element.kind === 'weather'" class="pel-weather">
    <svg
      class="pel-weather-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <template v-if="weatherIcon === 'sun'">
        <circle cx="12" cy="12" r="4.4" />
        <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19" />
      </template>
      <template v-else-if="weatherIcon === 'partly'">
        <circle cx="7.8" cy="7.4" r="2.9" />
        <path d="M7.8 1.8v1.5M2.2 7.4h1.5M3.6 3.2l1.1 1.1M12 3.2l-1.1 1.1" />
        <path d="M17.5 21a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 16.9" />
      </template>
      <template v-else-if="weatherIcon === 'rain'">
        <path d="M17.5 16a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 11.9" />
        <path d="M8 18.5v2M12 18v2M16 18.5v2" />
      </template>
      <template v-else-if="weatherIcon === 'snow'">
        <path d="M17.5 16a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 11.9" />
        <path d="M8 19h.01M12 20h.01M16 19h.01" />
      </template>
      <template v-else-if="weatherIcon === 'storm'">
        <path d="M17.5 15a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 10.9" />
        <path d="m12.5 13-2.5 4h3l-2.5 4" />
      </template>
      <template v-else>
        <path d="M17.5 19a4.5 4.5 0 1 0 0-9h-1.8A7 7 0 1 0 4 14.9" />
      </template>
    </svg>
    <div class="pel-weather-copy">
      <span class="pel-weather-temp" :style="{ fontSize: cq(0.34) }">{{ weatherTemp }}</span>
      <span class="pel-weather-sub" :style="{ fontSize: `max(9px, ${cq(0.13)})` }">{{ weatherSub }}</span>
    </div>
  </div>

  <!-- QR — POL-133: authored module/background colours (defaults = the old hardcoded pair). The
       path fill is a LITERAL colour value, never fill="var(…)" (D66/D74's SVG rule). -->
  <div
    v-else-if="element.kind === 'qr'"
    class="pel-qr"
    :style="{ background: element.props.bg ?? '#ffffff' }"
  >
    <svg
      v-if="qrPath"
      width="100%"
      height="100%"
      :viewBox="`0 0 ${qrModules} ${qrModules}`"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <path :d="qrPath" :fill="element.props.fg ?? '#09090b'" fill-rule="evenodd" />
    </svg>
  </div>

  <!-- COUNTDOWN -->
  <div v-else-if="element.kind === 'countdown'" class="pel-countdown">
    <span class="pel-countdown-big" :style="{ color: element.props.color, fontSize: cq(0.42) }">{{ countdownText }}</span>
    <span class="pel-countdown-sub" :style="{ fontSize: `max(9px, ${cq(0.16)})` }">
      {{ element.props.label || "Countdown" }} · {{ element.props.target }}
    </span>
  </div>
</template>

<style scoped>
/* Embed */
.pel-embed-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
  pointer-events: none; /* wall content is display-only; the kiosk never exposes an input path */
}
.pel-embed-media {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pel-embed-placeholder {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #131c2e, #0e1420);
  border: 1px solid rgba(255, 255, 255, 0.07);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 3%;
  overflow: hidden;
}
.pel-embed-chart {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0.5;
}
.pel-embed-kicker {
  position: relative;
  letter-spacing: 0.1em;
  color: rgba(255, 255, 255, 0.45);
  font-weight: 600;
}
.pel-embed-label {
  position: relative;
  font-weight: 600;
  color: #e6ecf7;
  letter-spacing: -0.01em;
  max-width: 92%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pel-embed-note {
  position: relative;
  color: rgba(255, 255, 255, 0.4);
}

/* Ticker */
.pel-ticker {
  position: absolute;
  inset: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
}
.pel-ticker-run {
  display: flex;
  white-space: nowrap;
  align-items: center;
  font-weight: 500;
  animation-name: pel-tickmove;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  will-change: transform;
}
.pel-ticker-text {
  padding-right: 64px;
}

/* Feed */
.pel-feed {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 4px;
  padding: 6% 8% 7%;
  display: flex;
  flex-direction: column;
  gap: 5%;
  overflow: hidden;
}
.pel-feed-header {
  flex: 0 0 auto; /* the masthead must never be squeezed by an over-full item list */
  font-weight: 600;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.45);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pel-feed-item {
  /* Natural height, no flex squeeze: an over-tall list clips its LAST item at the card edge
     instead of crushing every headline to one ellipsised line. */
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pel-feed-title {
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.pel-feed-meta {
  color: rgba(255, 255, 255, 0.35);
}
.pel-feed-skeleton {
  display: block;
  height: 0.8em;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.09);
}
.pel-feed-skeleton--meta {
  width: 18%;
  height: 0.55em;
  margin-top: 3px;
  background: rgba(255, 255, 255, 0.05);
}

/* Image */
.pel-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.pel-image-placeholder {
  position: absolute;
  inset: 0;
  border: 1.5px dashed rgba(255, 255, 255, 0.22);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 4%;
  overflow: hidden;
}
.pel-image-glyph {
  color: rgba(255, 255, 255, 0.4);
}
.pel-image-label {
  color: rgba(255, 255, 255, 0.45);
  text-align: center;
  padding: 0 4%;
}

/* Text */
.pel-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding: 0 2%;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.15;
  overflow: hidden;
}

/* Clock */
.pel-clock {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* Shape */
.pel-shape {
  position: absolute;
  inset: 0;
}

/* Weather */
.pel-weather {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8%;
  color: rgba(255, 255, 255, 0.75);
}
.pel-weather-icon {
  width: 24%;
  height: 44%;
}
.pel-weather-copy {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  min-width: 0;
}
.pel-weather-temp {
  font-weight: 600;
  color: rgba(255, 255, 255, 0.92);
}
.pel-weather-sub {
  color: rgba(255, 255, 255, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* QR */
.pel-qr {
  position: absolute;
  inset: 0;
  background: #ffffff;
  border-radius: 4px;
  padding: 9%;
  display: flex;
}

/* Countdown */
.pel-countdown {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2%;
}
.pel-countdown-big {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.pel-countdown-sub {
  color: rgba(255, 255, 255, 0.5);
}
</style>

<style>
/* Global (unscoped) on purpose: the ticker animation name must resolve wherever the component is
   mounted. The ONE sanctioned transform animation on wall chrome — see the header comment + D74. */
@keyframes pel-tickmove {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}
</style>
