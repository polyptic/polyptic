<!--
  ScreenRow.vue — one screen under an approved machine in the Machines view.

  Mirrors the retired SolidJS admin's ScreenRow: a connectivity dot, an inline rename (committed on
  Enter/blur, reverted on Escape), the screen's connector + "Driven by {machine}" line, and an Ident
  pulse. The rename draft re-syncs from the authoritative admin/state on every snapshot UNLESS the
  operator is mid-edit, so a live repaint never clobbers typed text or steals focus.

  All mutations go through the Pinia store (renameScreen / identScreen) — no direct fetch here.
-->
<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { ScreenView } from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";
import { useScreenThumbnail } from "./canvas/useThumbnails";

const props = defineProps<{ screen: ScreenView; machineLabel: string }>();

const store = useConsoleStore();

// Live preview of what's actually on this panel, refreshed on a throttle by the shared manager and
// paused automatically while the screen is offline (falls back to the neutral placeholder tile).
const thumbUrl = useScreenThumbnail(
  computed(() => props.screen.id),
  computed(() => props.screen.online),
);

const draft = ref(props.screen.friendlyName);
const focused = ref(false);
const identing = ref(false);
let identTimer: ReturnType<typeof setTimeout> | null = null;

// Re-sync from inbound snapshots unless the operator is actively editing this field.
watch(
  () => props.screen.friendlyName,
  (name) => {
    if (!focused.value) draft.value = name;
  },
);

const trimmed = computed(() => draft.value.trim());
const canRename = computed(() => {
  const n = trimmed.value;
  return n.length >= 1 && n.length <= 64 && n !== props.screen.friendlyName;
});

function commit(): void {
  if (!canRename.value) return;
  void store.renameScreen(props.screen.id, trimmed.value);
}

function revert(): void {
  draft.value = props.screen.friendlyName;
}

function ident(): void {
  void store.identScreen(props.screen.id);
  identing.value = true;
  if (identTimer) clearTimeout(identTimer);
  identTimer = setTimeout(() => {
    identing.value = false;
  }, 3000);
}

// Permanently forget this screen (POL-14) — deletes it, its placement + content. Aimed at stale
// screens (an output the machine no longer drives); a still-reported output reappears on reconnect.
function remove(): void {
  const yes = window.confirm(
    `Remove screen "${props.screen.friendlyName}"? This permanently deletes it, its placement and ` +
      `content from the console. If its machine still drives this output, the screen reappears when the ` +
      `machine next reconnects.`,
  );
  if (yes) void store.removeScreen(props.screen.id);
}
</script>

<template>
  <div class="screen-row">
    <span
      class="dot"
      :class="screen.online ? 'dot-on' : 'dot-off'"
      :title="screen.online ? 'player connected' : 'player offline'"
    ></span>

    <!-- live preview tile (falls back to a neutral placeholder when offline / no frame yet) -->
    <div class="preview" :class="{ live: thumbUrl }">
      <div
        v-if="thumbUrl"
        class="preview-img"
        :style="{ backgroundImage: `url(${thumbUrl})` }"
        aria-hidden="true"
      ></div>
      <span v-else class="preview-empty" aria-hidden="true">▦</span>
    </div>

    <div class="name-col">
      <input
        v-model="draft"
        class="rename"
        spellcheck="false"
        autocomplete="off"
        :aria-label="`Rename ${screen.friendlyName}`"
        @focus="focused = true"
        @blur="focused = false; commit()"
        @keyup.enter="commit(); ($event.target as HTMLInputElement).blur()"
        @keyup.esc="revert(); ($event.target as HTMLInputElement).blur()"
      />
      <div class="sub">
        <span class="chip">{{ screen.connector }}</span>
        <span class="driven">Driven by {{ machineLabel }}</span>
        <span class="surfaces">
          {{ screen.surfaceCount }} {{ screen.surfaceCount === 1 ? "surface" : "surfaces" }}
        </span>
      </div>
    </div>

    <button class="ident-btn" :class="{ active: identing }" @click="ident">
      <span class="ident-dot"></span>{{ identing ? "Flashing…" : "Ident" }}
    </button>

    <button class="remove-btn" title="Remove this screen from the console" @click="remove">
      Remove
    </button>
  </div>
</template>

<style scoped>
.screen-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.dot-on {
  background: var(--ok);
}
.dot-off {
  background: var(--muted2);
}
.preview {
  flex: 0 0 auto;
  width: 64px;
  height: 36px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--muted-bg);
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview.live {
  background: #0b0d12;
}
.preview-img {
  width: 100%;
  height: 100%;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.preview-empty {
  font-size: 14px;
  color: var(--muted2);
  line-height: 1;
}
.name-col {
  flex: 1;
  min-width: 0;
}
.rename {
  width: 100%;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 4px 7px;
  margin: -4px -7px 2px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.rename:hover {
  border-color: var(--line);
}
.rename:focus {
  border-color: var(--accent);
  background: var(--card);
}
.sub {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 11.5px;
  color: var(--muted2);
  white-space: nowrap;
  overflow: hidden;
}
.chip {
  font-variant-numeric: tabular-nums;
  background: var(--muted-bg);
  color: var(--fg2);
  font-weight: 500;
  padding: 2px 7px;
  border-radius: 6px;
}
.driven {
  color: var(--muted);
}
.surfaces {
  color: var(--muted2);
}
.ident-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
  box-shadow: var(--shadow-sm);
}
.ident-btn:hover {
  background: var(--muted-bg);
}
.ident-btn.active {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.ident-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.remove-btn {
  padding: 7px 11px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--bad);
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
  box-shadow: var(--shadow-sm);
}
.remove-btn:hover {
  background: var(--bad-soft);
  border-color: var(--bad);
}
</style>
