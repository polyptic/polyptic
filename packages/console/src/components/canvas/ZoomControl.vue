<!--
  ZoomControl — page zoom for the framed content on a screen or a combined surface (POL-57).

  A browser's zoom control, in the Inspector: − steps down the ladder, + steps up, and the percentage
  in the middle is a button that resets to 100% (and reads as inert at 100%, where there is nothing to
  reset). The caller decides whether the selection can be zoomed at all — this component assumes it can.

  Emits the NEW zoom. The parent sends it; the value the operator sees comes back on the next
  admin/state broadcast, so this stays a controlled component with no local state to drift.
-->
<script setup lang="ts">
import { computed } from "vue";
import { canZoomIn, canZoomOut, DEFAULT_ZOOM, zoomIn, zoomLabel, zoomOut } from "../../zoom";

const props = defineProps<{
  zoom: number;
  /** Caption under the control — what the remembered value is keyed to. */
  caption: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ (e: "update", zoom: number): void }>();

const label = computed(() => zoomLabel(props.zoom));
const atDefault = computed(() => props.zoom === DEFAULT_ZOOM);
const canOut = computed(() => !props.disabled && canZoomOut(props.zoom));
const canIn = computed(() => !props.disabled && canZoomIn(props.zoom));
</script>

<template>
  <div class="zoom">
    <button
      class="zoom-btn"
      :disabled="!canOut"
      title="Zoom out"
      aria-label="Zoom out"
      @click="emit('update', zoomOut(props.zoom))"
    >
      −
    </button>

    <button
      class="zoom-value"
      :disabled="props.disabled || atDefault"
      :title="atDefault ? 'Already at 100%' : 'Reset to 100%'"
      @click="emit('update', DEFAULT_ZOOM)"
    >
      {{ label }}
    </button>

    <button
      class="zoom-btn"
      :disabled="!canIn"
      title="Zoom in"
      aria-label="Zoom in"
      @click="emit('update', zoomIn(props.zoom))"
    >
      +
    </button>
  </div>
  <div class="hint">{{ props.caption }}</div>
</template>

<style scoped>
.zoom {
  display: flex;
  align-items: center;
  gap: 7px;
}

.zoom-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  color: var(--fg);
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  font-family: inherit;
}
.zoom-btn:not(:disabled):hover {
  background: var(--muted-bg);
}

.zoom-value {
  flex: 1;
  height: 34px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--muted-bg);
  color: var(--fg2);
  font-size: 12.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  font-family: inherit;
}
.zoom-value:not(:disabled):hover {
  color: var(--bad);
  border-color: var(--scr-bad-line);
  background: var(--bad-soft);
}
/* At 100% the value is a read-out, not an affordance — no "nothing happens" click. */
.zoom-value:disabled {
  cursor: default;
}

.zoom-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.55;
}
</style>
