<!--
  MuralSwitcher — the active-mural picker in the Wall top bar.

  Shows the active mural's name with a caret; the dropdown lists every mural
  (click to switch), plus create / rename / delete affordances backed by the
  store. Matches the design's "Reception Mural ▾" switcher. Create/rename/delete ask through the
  console's own dialog (POL-93); the "you need at least one mural" refusal is a statement, not a
  question, so it goes to the toast rail rather than blocking on an OK button.
-->
<script setup lang="ts">
import { ref, computed } from "vue";
import { useConsoleStore } from "../../stores/console";
import { useDialogStore } from "../../stores/dialogs";
import { useToastStore } from "../../stores/toasts";

const store = useConsoleStore();
const dialogs = useDialogStore();
const toasts = useToastStore();
const open = ref(false);

const active = computed(() => store.activeMural);
const murals = computed(() => store.murals);

function pick(id: string) {
  store.setActiveMural(id);
  open.value = false;
}

async function create() {
  open.value = false;
  const name = await dialogs.promptText({
    title: "New mural",
    message: "A mural is one wall of screens — a canvas you lay screens out on.",
    label: "Name",
    value: "New mural",
    confirmLabel: "Create mural",
  });
  if (name && name.trim()) void store.createMural(name.trim());
}

async function rename() {
  open.value = false;
  const m = active.value;
  if (!m) return;
  const name = await dialogs.promptText({
    title: "Rename mural",
    label: "Name",
    value: m.name,
    confirmLabel: "Rename",
  });
  if (name && name.trim() && name.trim() !== m.name) void store.renameMural(m.id, name.trim());
}

async function remove() {
  open.value = false;
  const m = active.value;
  if (!m) return;
  if (murals.value.length <= 1) {
    toasts.error("You need at least one mural", {
      detail: "Create another mural before deleting this one.",
    });
    return;
  }
  const yes = await dialogs.confirm({
    title: `Delete the mural "${m.name}"?`,
    message:
      "The screens on it return to Unplaced and keep their content. The layout itself is gone — " +
      "there is no undo for a deleted mural.",
    confirmLabel: "Delete mural",
    danger: true,
  });
  if (yes) void store.deleteMural(m.id);
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
        <button class="menu-item danger" @click="remove"><span class="tick">✕</span>Delete current…</button>
      </div>
    </template>
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
