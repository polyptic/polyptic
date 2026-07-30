<!--
  MuralSwitcher — the active-mural picker in the Wall top bar.

  Shows the active mural's name with a caret; the dropdown lists every mural
  (click to switch), plus create / rename / delete affordances backed by the
  store. Matches the design's "Reception Mural ▾" switcher. Create/rename use a
  lightweight prompt — a dedicated dialog is out of scope for 3a.
-->
<script setup lang="ts">
import { ref, computed } from "vue";
import { useConsoleStore } from "../../stores/console";
import MuralPeople from "./MuralPeople.vue";

const store = useConsoleStore();
const open = ref(false);
// POL-191 — the access sheet for the ACTIVE mural. Opened from the menu; the server refuses the read
// with a 403 for anyone who is not an admin on this mural, and the sheet says so plainly.
const peopleOpen = ref(false);

const active = computed(() => store.activeMural);
const murals = computed(() => store.murals);

function pick(id: string) {
  store.setActiveMural(id);
  open.value = false;
}

function create() {
  open.value = false;
  const name = window.prompt("Name the new mural", "New mural");
  if (name && name.trim()) store.createMural(name.trim());
}

function people() {
  open.value = false;
  if (active.value) peopleOpen.value = true;
}

function rename() {
  open.value = false;
  const m = active.value;
  if (!m) return;
  const name = window.prompt("Rename mural", m.name);
  if (name && name.trim() && name.trim() !== m.name) store.renameMural(m.id, name.trim());
}

function remove() {
  open.value = false;
  const m = active.value;
  if (!m) return;
  if (murals.value.length <= 1) {
    window.alert("You need at least one mural.");
    return;
  }
  if (window.confirm(`Delete mural “${m.name}”? Screens on it return to Unplaced.`)) {
    store.deleteMural(m.id);
  }
}
</script>

<template>
  <div class="mural-switcher">
    <button class="trigger" @click="open = !open">
      <span class="name">{{ active ? active.name : "No mural" }}</span>
      <span class="caret">▾</span>
    </button>

    <template v-if="open">
      <div class="backdrop" @click="open = false"></div>
      <div class="menu">
        <div class="menu-label">Murals</div>
        <button
          v-for="m in murals"
          :key="m.id"
          class="menu-item"
          :class="{ active: active && m.id === active.id }"
          @click="pick(m.id)"
        >
          <span class="tick">{{ active && m.id === active.id ? "✓" : "" }}</span>
          <span class="menu-name">{{ m.name }}</span>
        </button>
        <div class="divider"></div>
        <button class="menu-item" @click="create"><span class="tick">＋</span>New mural…</button>
        <button class="menu-item" @click="rename"><span class="tick">✎</span>Rename current…</button>
        <button class="menu-item" @click="people"><span class="tick">◍</span>Access…</button>
        <button class="menu-item danger" @click="remove"><span class="tick">✕</span>Delete current…</button>
      </div>
    </template>

    <MuralPeople
      v-if="peopleOpen && active"
      :mural-id="active.id"
      :mural-name="active.name"
      @close="peopleOpen = false"
    />
  </div>
</template>

<style scoped>
.mural-switcher {
  position: relative;
}
.trigger {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border: none;
  background: transparent;
  border-radius: 8px;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  cursor: pointer;
}
.trigger:hover {
  background: var(--muted-bg);
}
.caret {
  color: var(--muted2);
  font-size: 10px;
}

.backdrop {
  position: fixed;
  inset: 0;
  z-index: 110;
}
.menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 120;
  min-width: 220px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 11px;
  box-shadow: var(--shadow-lg);
  padding: 6px;
}
.menu-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  padding: 6px 8px 4px;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 9px;
  border: none;
  background: transparent;
  border-radius: 8px;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  text-align: left;
}
.menu-item:hover {
  background: var(--muted-bg);
}
.menu-item.active {
  color: var(--fg);
}
.menu-item.danger {
  color: var(--muted);
}
.menu-item.danger:hover {
  background: var(--bad-soft);
  color: var(--bad);
}
.menu-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tick {
  width: 14px;
  flex: 0 0 auto;
  text-align: center;
  color: var(--accent-fg);
  font-size: 11px;
}
.divider {
  height: 1px;
  background: var(--line);
  margin: 6px 4px;
}
</style>
