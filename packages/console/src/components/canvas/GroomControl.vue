<!--
  GroomControl — how a framed page SITS on a screen or a combined surface (POL-98).

  Three knobs, the ones a wallboard actually needs and nothing more:

    Refresh — how often a DASHBOARD re-fetches itself. Presets, not a free number: an operator wants
              "every 5 minutes", not to reason about seconds, and a stray `5` would hammer someone's
              dashboard server from every panel on the wall. Dashboards only — a refresh cadence is
              what the kind MEANS (`canRefresh`), so a web page simply doesn't show it.
    Crop    — the inset chopped off each edge of the page: the nav bar, the footer, a sidebar. In
              percent by default (it survives a panel swap); px when you have measured the header.
    Scroll  — where the page is parked, in the page's own pixels.

  Crop and scroll are geometry on the SAME element the wall is already showing, so they land instantly
  with no reload — like zoom, and for the same reason. Emits the WHOLE groom; the parent sends it and
  the value comes back on the next admin/state broadcast, so this stays a controlled component.
-->
<script setup lang="ts">
import { computed } from "vue";
import type { SurfaceCrop, SurfaceGroom, SurfaceScroll } from "@polyptic/protocol";

const props = defineProps<{
  groom: SurfaceGroom;
  /** Does this selection frame a DASHBOARD? Only a dashboard carries a refresh cadence. */
  canRefresh: boolean;
  /** Caption under the panel — what the remembered values are keyed to. */
  caption: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ (e: "update", groom: SurfaceGroom): void }>();

/** The cadences an operator actually asks for. The contract floors a refresh at 30s. */
const REFRESH_PRESETS: { label: string; seconds?: number }[] = [
  { label: "Off" },
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
];

const crop = computed<SurfaceCrop>(
  () => props.groom.crop ?? { top: 0, right: 0, bottom: 0, left: 0, unit: "percent" },
);
const scroll = computed<SurfaceScroll>(() => props.groom.scroll ?? { x: 0, y: 0 });
const refreshSeconds = computed(() => props.groom.refreshSeconds);

const cropped = computed(() => {
  const c = crop.value;
  return c.top > 0 || c.right > 0 || c.bottom > 0 || c.left > 0;
});
const scrolled = computed(() => scroll.value.x > 0 || scroll.value.y > 0);
const groomed = computed(() => cropped.value || scrolled.value || refreshSeconds.value !== undefined);

/** A zero crop / zero scroll is ABSENT, not a row of zeroes — the wire says "ungroomed" plainly. */
function emitGroom(next: { crop: SurfaceCrop; scroll: SurfaceScroll; refreshSeconds?: number }): void {
  const c = next.crop;
  const hasCrop = c.top > 0 || c.right > 0 || c.bottom > 0 || c.left > 0;
  const hasScroll = next.scroll.x > 0 || next.scroll.y > 0;
  emit("update", {
    refreshSeconds: props.canRefresh ? next.refreshSeconds : undefined,
    crop: hasCrop ? c : undefined,
    scroll: hasScroll ? next.scroll : undefined,
  });
}

function setRefresh(seconds?: number): void {
  emitGroom({ crop: crop.value, scroll: scroll.value, refreshSeconds: seconds });
}

/** Clamp to the contract: a percent crop must leave 5% of each axis visible, so the frame can never
 *  be asked to grow without bound. The console refuses the value rather than sending a 400. */
function clampCrop(next: SurfaceCrop): SurfaceCrop {
  if (next.unit !== "percent") return next;
  const fix = (near: number, far: number): number => Math.max(0, Math.min(near, 95 - far));
  return {
    ...next,
    top: fix(next.top, next.bottom),
    bottom: fix(next.bottom, next.top),
    left: fix(next.left, next.right),
    right: fix(next.right, next.left),
  };
}

function setCropEdge(edge: "top" | "right" | "bottom" | "left", value: number): void {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  emitGroom({
    crop: clampCrop({ ...crop.value, [edge]: v }),
    scroll: scroll.value,
    refreshSeconds: refreshSeconds.value,
  });
}

function setCropUnit(unit: "percent" | "px"): void {
  if (unit === crop.value.unit) return;
  // The two units measure different things (a fraction of the page vs its CSS pixels), so switching
  // starts from zero rather than pretending 12% and 12px are the same crop.
  emitGroom({
    crop: { top: 0, right: 0, bottom: 0, left: 0, unit },
    scroll: scroll.value,
    refreshSeconds: refreshSeconds.value,
  });
}

function setScroll(axis: "x" | "y", value: number): void {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  emitGroom({
    crop: crop.value,
    scroll: { ...scroll.value, [axis]: v },
    refreshSeconds: refreshSeconds.value,
  });
}

function reset(): void {
  emit("update", {});
}

function num(event: Event): number {
  return Number((event.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="groom">
    <template v-if="props.canRefresh">
      <div class="row-label">Refresh</div>
      <div class="presets">
        <button
          v-for="preset in REFRESH_PRESETS"
          :key="preset.label"
          class="preset"
          :class="{ 'is-on': refreshSeconds === preset.seconds }"
          :disabled="props.disabled"
          @click="setRefresh(preset.seconds)"
        >
          {{ preset.label }}
        </button>
      </div>
    </template>

    <div class="row-label">
      Crop
      <span class="units">
        <button
          class="unit"
          :class="{ 'is-on': crop.unit === 'percent' }"
          :disabled="props.disabled"
          @click="setCropUnit('percent')"
        >
          %
        </button>
        <button
          class="unit"
          :class="{ 'is-on': crop.unit === 'px' }"
          :disabled="props.disabled"
          @click="setCropUnit('px')"
        >
          px
        </button>
      </span>
    </div>
    <div class="grid">
      <label class="field">
        <span>Top</span>
        <input
          type="number"
          min="0"
          :value="crop.top"
          :disabled="props.disabled"
          @change="setCropEdge('top', num($event))"
        />
      </label>
      <label class="field">
        <span>Right</span>
        <input
          type="number"
          min="0"
          :value="crop.right"
          :disabled="props.disabled"
          @change="setCropEdge('right', num($event))"
        />
      </label>
      <label class="field">
        <span>Bottom</span>
        <input
          type="number"
          min="0"
          :value="crop.bottom"
          :disabled="props.disabled"
          @change="setCropEdge('bottom', num($event))"
        />
      </label>
      <label class="field">
        <span>Left</span>
        <input
          type="number"
          min="0"
          :value="crop.left"
          :disabled="props.disabled"
          @change="setCropEdge('left', num($event))"
        />
      </label>
    </div>

    <div class="row-label">Scroll <span class="units-static">page px</span></div>
    <div class="grid">
      <label class="field">
        <span>X</span>
        <input
          type="number"
          min="0"
          :value="scroll.x"
          :disabled="props.disabled"
          @change="setScroll('x', num($event))"
        />
      </label>
      <label class="field">
        <span>Y</span>
        <input
          type="number"
          min="0"
          :value="scroll.y"
          :disabled="props.disabled"
          @change="setScroll('y', num($event))"
        />
      </label>
    </div>

    <button class="reset" :disabled="props.disabled || !groomed" @click="reset()">
      {{ groomed ? "Reset to the whole page" : "Whole page, unparked" }}
    </button>
  </div>
  <div class="hint">{{ props.caption }}</div>
</template>

<style scoped>
.groom {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.row-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted2);
  margin-top: 3px;
}

.presets,
.units {
  display: flex;
  gap: 4px;
}

.preset,
.unit {
  border-radius: 7px;
  border: 1px solid var(--line2);
  background: var(--surface);
  color: var(--fg2);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  padding: 5px 9px;
}
.unit {
  padding: 2px 7px;
  font-size: 11px;
  text-transform: none;
}
.preset {
  flex: 1;
}
.preset:not(:disabled):hover,
.unit:not(:disabled):hover {
  background: var(--muted-bg);
}
.preset.is-on,
.unit.is-on {
  border-color: var(--scr-good-line, var(--line));
  background: var(--muted-bg);
  color: var(--fg);
}
.preset:disabled,
.unit:disabled,
.reset:disabled {
  opacity: 0.5;
  cursor: default;
}

.units-static {
  font-size: 10.5px;
  font-weight: 500;
  text-transform: none;
  color: var(--muted2);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.field {
  display: flex;
  align-items: center;
  gap: 6px;
}
.field span {
  width: 44px;
  font-size: 11px;
  color: var(--muted2);
}
.field input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  color: var(--fg);
  font-size: 12.5px;
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}

.reset {
  height: 30px;
  margin-top: 3px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--muted-bg);
  color: var(--fg2);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.reset:not(:disabled):hover {
  color: var(--bad);
  border-color: var(--scr-bad-line);
  background: var(--bad-soft);
}

.hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.55;
}
</style>
