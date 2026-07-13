<!--
  UnplacedTray — the floating "unplaced screens" tray, docked bottom-center of the Wall canvas
  (POL-72, design handoff v3 §2). Rendered only when there is at least one unplaced screen; with
  zero unplaced the canvas is simply clean — no placeholder replaces it.

  Each card carries: a status dot, an inline-editable name, an Ident button, and a ⠿ Place handle
  that starts the same HTML5 drag-to-place the old sidebar tray used (screenId in dataTransfer,
  dropped on WallCanvas). Clicking Place instead auto-places at the next free grid slot.
-->
<script setup lang="ts">
import { computed } from "vue";
import { useConsoleStore } from "../../stores/console";
import { useIdent } from "./useIdent";

const store = useConsoleStore();
const { ident } = useIdent();

const unplaced = computed(() => store.unplacedScreens);
const label = computed(
  () => `${unplaced.value.length} unplaced screen${unplaced.value.length === 1 ? "" : "s"}`,
);

function onDragStart(e: DragEvent, id: string) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData("application/x-polyptic-screen", id);
  e.dataTransfer.setData("text/plain", id);
  e.dataTransfer.effectAllowed = "move";
}

/** Click fallback: place at the next free grid slot (canvas px ≈ native res). */
function place(id: string) {
  const muralId = store.activeMuralId;
  if (!muralId) return;
  const n = store.placedScreens(muralId).length;
  const col = n % 4;
  const row = Math.floor(n / 4);
  store.placeScreen(id, muralId, col * 2040, row * 1200);
}

function commitName(e: Event, id: string) {
  const screen = store.screenById(id);
  const input = e.target as HTMLInputElement;
  const v = input.value.trim();
  if (!screen) return;
  if (v && v !== screen.friendlyName) store.renameScreen(id, v);
  else input.value = screen.friendlyName;
}
</script>

<template>
  <div v-if="unplaced.length" class="unplaced-tray">
    <div class="tray-label">
      <span class="tray-count">{{ label }}</span>
      <span class="tray-sub">drag onto the wall</span>
    </div>
    <div class="tray-divider"></div>
    <div class="tray-cards">
      <div v-for="s in unplaced" :key="s.id" class="tray-card">
        <span class="dot" :style="{ background: s.online ? 'var(--ok)' : 'var(--bad)' }"></span>
        <input
          class="name-input"
          :value="s.friendlyName"
          @blur="commitName($event, s.id)"
          @keyup.enter="($event.target as HTMLInputElement).blur()"
        />
        <button class="ident-btn" @click="ident(s.id)">
          <span class="ident-dot"></span>Ident
        </button>
        <button
          class="place-handle"
          draggable="true"
          title="Drag onto the canvas, or click to auto-place"
          @dragstart="onDragStart($event, s.id)"
          @click="place(s.id)"
        >
          ⠿ Place
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.unplaced-tray {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  max-width: calc(100% - 28px);
  display: flex;
  align-items: stretch;
  gap: 10px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 13px;
  padding: 9px 10px 9px 15px;
  box-shadow: var(--shadow-lg);
  z-index: 60;
  animation: tray-in 0.25s ease;
}
@keyframes tray-in {
  from {
    opacity: 0;
    transform: translate(-50%, 6px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

.tray-label {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  line-height: 1.45;
  padding-right: 4px;
}
.tray-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
}
.tray-sub {
  font-size: 10.5px;
  color: var(--muted2);
  white-space: nowrap;
}
.tray-divider {
  flex: 0 0 auto;
  width: 1px;
  background: var(--line);
}
.tray-cards {
  display: flex;
  align-items: stretch;
  gap: 10px;
  overflow-x: auto;
  min-width: 0;
}
.tray-card {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 8px 7px 12px;
  border: 1px dashed var(--line2);
  border-radius: 9px;
  background: var(--bg);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.name-input {
  width: 84px;
  flex: 0 0 auto;
  background: transparent;
  border: none;
  font-size: 12px;
  color: var(--fg2);
  font-weight: 600;
  outline: none;
  padding: 0;
  font-family: inherit;
}
.ident-btn {
  flex: 0 0 auto;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 11px;
  color: var(--fg2);
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.ident-btn:hover {
  background: var(--muted-bg);
}
.ident-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}
.place-handle {
  flex: 0 0 auto;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  border-radius: 6px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 11px;
  font-weight: 600;
  cursor: grab;
  font-family: inherit;
}
.place-handle:active {
  cursor: grabbing;
}
</style>
