<!--
  AudioControl — sound for the audible content on a screen or a combined surface (POL-112).

  A wall is muted until somebody says otherwise, so the OFF state has to be the obvious, readable one:
  the card reads "Muted" in plain words with a crossed speaker, and only lights up (accent border,
  live level) once the operator has actually turned the sound on. There is no ambiguous middle state
  and no icon-only guessing game — an operator must never have to walk to the lobby to find out
  whether the wall is about to shout.

  The slider stays usable while muted (it sets the level the sound will come UP at), which mirrors
  every OS mixer. Emits the whole intent; the parent sends it. The value the operator sees comes back
  on the next admin/state broadcast — the store patches it optimistically in the meantime.
-->
<script setup lang="ts">
import { computed } from "vue";
import type { AudioIntent } from "@polyptic/protocol";
import Toggle from "../Toggle.vue";

const props = defineProps<{
  audio: AudioIntent;
  /** What this control acts on, in the operator's words ("Screen sound" / "Wall sound"). */
  title: string;
  /** Shown under the control — what this particular target's audio means (screen vs. wall). */
  caption: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ (e: "update", audio: AudioIntent): void }>();

const on = computed(() => !props.audio.muted);
const percent = computed(() => Math.round(props.audio.volume * 100));
const stateText = computed(() => (on.value ? `Sound on · ${percent.value}%` : "Muted"));

function toggle(enabled: boolean): void {
  if (props.disabled) return;
  emit("update", { muted: !enabled, volume: props.audio.volume });
}

function setVolume(event: Event): void {
  if (props.disabled) return;
  const target = event.target as HTMLInputElement;
  const volume = Math.min(1, Math.max(0, Number(target.value) / 100));
  emit("update", { muted: props.audio.muted, volume });
}
</script>

<template>
  <div class="audio" :class="{ on }">
    <div class="audio-head">
      <!-- Static inline SVG, literal currentColor (wall/console rule: no fill="var()" attributes). -->
      <svg
        class="audio-glyph"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M4 9v6h4l5 4V5L8 9H4z" />
        <template v-if="on">
          <path d="M16.5 8.5a5 5 0 0 1 0 7" />
          <path d="M19 6a8.5 8.5 0 0 1 0 12" opacity="0.5" />
        </template>
        <path v-else d="M17 9l5 6M22 9l-5 6" />
      </svg>
      <span class="audio-meta">
        <span class="audio-title">{{ title }}</span>
        <span class="audio-state">{{ stateText }}</span>
      </span>
      <Toggle
        :model-value="on"
        :disabled="disabled"
        label="Sound on"
        @update:model-value="toggle"
      />
    </div>

    <input
      class="audio-slider"
      type="range"
      min="0"
      max="100"
      step="1"
      :value="percent"
      :disabled="disabled"
      aria-label="Volume"
      @input="setVolume"
    />

    <div class="audio-caption">{{ caption }}</div>
  </div>
</template>

<style scoped>
.audio {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 9px;
  border-radius: 9px;
  border: 1px solid var(--line);
}
.audio.on {
  border-color: var(--accent-line);
}
.audio-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.audio-glyph {
  width: 20px;
  height: 20px;
  flex: none;
  color: var(--muted);
}
.audio.on .audio-glyph {
  color: var(--accent-fg);
}
.audio-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.audio-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg);
}
.audio-state {
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
}
.audio.on .audio-state {
  color: var(--accent-fg);
}

.audio-slider {
  width: 100%;
  height: 4px;
  appearance: none;
  border-radius: 2px;
  background: var(--muted-bg);
  outline: none;
  cursor: pointer;
}
.audio.on .audio-slider {
  background: var(--accent-bg, var(--muted-bg));
}
.audio-slider:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.audio-slider::-webkit-slider-thumb {
  appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: none;
  background: var(--muted2);
  cursor: pointer;
}
.audio.on .audio-slider::-webkit-slider-thumb {
  background: var(--accent);
}
.audio-slider::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: none;
  background: var(--muted2);
  cursor: pointer;
}
.audio.on .audio-slider::-moz-range-thumb {
  background: var(--accent);
}

.audio-caption {
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.5;
}
</style>
