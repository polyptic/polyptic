<!--
  SelectionToolbar — the floating affordance over the canvas (docs/design selBar).

  Two shapes, mirroring the design:
    - multi-select (≥2 loose screens) : "N screens selected" · Ident · ▦ Combine into surface
    - a combined surface selected      : "▦ {name}"          · Ident · Split

  Combine/Split are live (Phase 3b) and go through the store. Ident flashes the
  panels: for loose screens via per-screen pulses, for a wall via the single
  /walls/:id/ident route plus a local flash of its members.
-->
<script setup lang="ts">
import { computed } from "vue";
import { useConsoleStore } from "../../stores/console";
import { useIdent } from "./useIdent";

const store = useConsoleStore();
const { identMany, flash } = useIdent();

const wall = computed(() => store.selectedWall);
const count = computed(() => store.selectedScreenIds.length);

// Show for a selected combined surface, or for a multi-screen pre-combine selection.
const show = computed(() => !!wall.value || count.value > 1);

const label = computed(() =>
  wall.value ? `▦ ${store.wallName(wall.value.id)}` : `${count.value} screens selected`,
);

function identSel() {
  if (wall.value) {
    store.identWall(wall.value.id);
    flash([...wall.value.memberScreenIds]);
  } else {
    identMany([...store.selectedScreenIds]);
  }
}

function groupAction() {
  if (wall.value) {
    store.split(wall.value.id);
  } else if (store.activeMuralId && count.value > 1) {
    store.combine(store.activeMuralId, [...store.selectedScreenIds]);
  }
}
</script>

<template>
  <div v-if="show" class="sel-toolbar">
    <span class="sel-count">{{ label }}</span>
    <button class="sel-btn" @click="identSel">
      <span class="dot"></span>Ident
    </button>
    <button v-if="wall" class="sel-action split" @click="groupAction">Split</button>
    <button v-else class="sel-action combine" @click="groupAction">▦ Combine into surface</button>
  </div>
</template>

<style scoped>
.sel-toolbar {
  position: absolute;
  left: 50%;
  top: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 6px 6px 6px 12px;
  box-shadow: var(--shadow-lg);
  z-index: 90;
}
.sel-count {
  font-size: 12px;
  color: var(--fg2);
  font-weight: 500;
  white-space: nowrap;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sel-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 12px;
  color: var(--fg2);
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.sel-btn:hover {
  background: var(--muted-bg);
}
.sel-btn .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.sel-action {
  display: flex;
  align-items: center;
  padding: 6px 11px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
  border: 1px solid transparent;
}
.sel-action.combine {
  background: var(--primary);
  color: var(--primary-fg);
}
.sel-action.combine:hover {
  opacity: 0.92;
}
.sel-action.split {
  background: var(--surface);
  border-color: var(--line2);
  color: var(--bad);
}
.sel-action.split:hover {
  background: var(--bad-soft);
}
</style>
