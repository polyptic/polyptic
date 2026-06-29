<!--
  Scenes.vue — the SCENES VIEW (Phase 3d).

  A scene is a named SNAPSHOT of one mural's whole wall — its layout (placements), grouping (video
  walls) and content (per screen + per wall) — re-appliable in one click. Mirrors
  docs/design/console.dc.html's SCENES VIEW: a header ("Saved presets of the whole wall. Apply one in
  a click, or schedule it to activate at a time of day.") + "+ Save current wall", then a card per
  scene with a status dot, an inline-rename name, an "Active" badge, an illustrative schedule-time
  input ("at <time>"), Apply and Delete; and the standing note that scheduling is illustrative.

  Scenes belong to a mural, so this view scopes to the active mural (switch murals on the Wall). All
  reads/writes go through the Pinia store; the server snapshots & re-applies — the client only names,
  renames, schedules, applies and deletes.

  Scheduling is ILLUSTRATIVE (D24): the time is stored but never fired — nothing here or on the server
  activates a scene at that time.
-->
<script setup lang="ts">
import { ref, computed } from "vue";
import { useConsoleStore } from "../stores/console";

const store = useConsoleStore();

const activeMural = computed(() => store.activeMural);
const scenes = computed(() => store.activeMuralScenes);

// ── save-current-wall modal ────────────────────────────────────────────────────
const saveOpen = ref(false);
const sceneName = ref("");
const saving = ref(false);

function openSave() {
  sceneName.value = "";
  saveOpen.value = true;
}
function closeSave() {
  saveOpen.value = false;
  saving.value = false;
}
async function confirmSave() {
  const muralId = store.activeMuralId;
  if (!muralId || saving.value) return;
  const name = sceneName.value.trim() || `Scene ${scenes.value.length + 1}`;
  saving.value = true;
  const ok = await store.saveScene(name, muralId);
  saving.value = false;
  if (ok) saveOpen.value = false;
}

// ── per-scene row actions ──────────────────────────────────────────────────────
function onRename(id: string, e: Event) {
  const v = (e.target as HTMLInputElement).value;
  store.renameSceneTo(id, v);
}
function onSchedule(id: string, e: Event) {
  const v = (e.target as HTMLInputElement).value;
  store.scheduleScene(id, v);
}
function apply(id: string) {
  store.applyScene(id);
}
async function remove(id: string) {
  const scene = store.sceneById(id);
  const yes = window.confirm(`Delete scene "${scene?.name ?? id}"? This can't be undone.`);
  if (yes) await store.deleteScene(id);
}
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <!-- header -->
      <header class="head">
        <div class="head-text">
          <h1 class="title">Scenes</h1>
          <p class="subtitle">
            Saved presets of the whole wall. Apply one in a click, or schedule it to activate at a
            time of day.
            <span v-if="activeMural" class="mural-tag">· {{ activeMural.name }}</span>
          </p>
        </div>
        <button class="save-btn" :disabled="!store.activeMuralId" @click="openSave">
          + Save current wall
        </button>
      </header>

      <!-- list -->
      <div v-if="scenes.length" class="list">
        <div v-for="s in scenes" :key="s.id" class="row">
          <span class="dot" :class="{ active: s.id === store.activeSceneId }"></span>
          <input
            class="name"
            :value="s.name"
            @change="onRename(s.id, $event)"
            @keyup.enter="($event.target as HTMLInputElement).blur()"
          />
          <span class="summary">{{ store.sceneSummary(s.id) }}</span>
          <span v-if="s.id === store.activeSceneId" class="active-badge">Active</span>
          <label class="sched">
            at
            <input
              type="time"
              class="sched-input"
              :value="s.scheduleAt ?? ''"
              @change="onSchedule(s.id, $event)"
            />
          </label>
          <button class="apply-btn" @click="apply(s.id)">Apply</button>
          <button class="del-btn" title="Delete scene" @click="remove(s.id)">✕</button>
        </div>
      </div>

      <!-- empty -->
      <div v-else class="empty">
        <span class="empty-glyph">▦</span>
        <span class="empty-title">No scenes saved for this mural yet</span>
        <span class="empty-sub">
          Lay out the wall on the Wall view, then save it here as a scene you can re-apply in one
          click.
        </span>
        <button class="save-btn ghost" :disabled="!store.activeMuralId" @click="openSave">
          + Save current wall
        </button>
      </div>

      <div class="note">
        Scheduling is illustrative in this prototype — times are stored but not fired.
      </div>
    </div>

    <!-- ── save-current-wall modal ─────────────────────────────────────────────── -->
    <div v-if="saveOpen" class="scrim" @mousedown.self="closeSave">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">Save current wall as scene</div>
        <div class="modal-sub">
          Captures every screen &amp; surface's content and layout. Switch back in one click.
        </div>
        <input
          v-model="sceneName"
          class="field"
          placeholder="Scene name…"
          autofocus
          @keyup.enter="confirmSave"
        />
        <div class="modal-actions">
          <button class="btn-secondary" @click="closeSave">Cancel</button>
          <button class="btn-primary" :disabled="saving" @click="confirmSave">Save scene</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.page-inner {
  max-width: 840px;
  margin: 0 auto;
  padding: 30px 32px 60px;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 24px;
}
.head-text {
  flex: 1;
}
.title {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 4px;
}
.subtitle {
  font-size: 13.5px;
  color: var(--muted);
  margin: 0;
  line-height: 1.5;
}
.mural-tag {
  color: var(--fg2);
  font-weight: 500;
}
.save-btn {
  padding: 9px 16px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
}
.save-btn:hover {
  opacity: 0.92;
}
.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.save-btn.ghost {
  background: transparent;
  border: 1px solid var(--line2);
  color: var(--fg2);
  margin-top: 4px;
}
.save-btn.ghost:hover {
  background: var(--muted-bg);
  opacity: 1;
}

/* list */
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 13px 15px;
  background: var(--card);
  box-shadow: var(--shadow-sm);
}
.dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--muted2);
}
.dot.active {
  background: var(--ok);
}
.name {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 6px 8px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.name:hover {
  border-color: var(--line);
}
.name:focus {
  border-color: var(--accent);
  background: var(--surface);
}
.summary {
  font-size: 11.5px;
  color: var(--muted2);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.active-badge {
  background: var(--ok-soft);
  color: var(--ok);
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
}
.sched {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
}
.sched-input {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 5px 7px;
  font-size: 11.5px;
  color: var(--fg2);
  outline: none;
  font-family: inherit;
}
.sched-input:focus {
  border-color: var(--accent);
}
.apply-btn {
  padding: 7px 13px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--fg);
  cursor: pointer;
  font-family: inherit;
}
.apply-btn:hover {
  background: var(--muted-bg);
}
.del-btn {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}
.del-btn:hover {
  background: var(--bad-soft);
  color: var(--bad);
}

/* empty */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  padding: 44px 20px;
  border: 1.5px dashed var(--line2);
  border-radius: 13px;
  text-align: center;
}
.empty-glyph {
  font-size: 26px;
  color: var(--muted2);
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg2);
}
.empty-sub {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
  max-width: 46ch;
}

.note {
  margin-top: 14px;
  font-size: 11.5px;
  color: var(--muted2);
}

/* modal */
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}
.modal {
  width: 360px;
  max-width: calc(100vw - 32px);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 22px;
  box-shadow: var(--shadow-lg);
}
.modal-title {
  font-size: 15.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin-bottom: 6px;
}
.modal-sub {
  font-size: 12.5px;
  color: var(--muted);
  margin-bottom: 16px;
  line-height: 1.5;
}
.field {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 11px 13px;
  font-size: 14px;
  color: var(--fg);
  outline: none;
  margin-bottom: 16px;
  font-family: inherit;
}
.field:focus {
  border-color: var(--accent);
}
.modal-actions {
  display: flex;
  gap: 9px;
  justify-content: flex-end;
}
.btn-secondary {
  padding: 9px 16px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 13px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}
.btn-secondary:hover {
  background: var(--muted-bg);
}
.btn-primary {
  padding: 9px 18px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-primary:not(:disabled):hover {
  opacity: 0.92;
}
</style>
