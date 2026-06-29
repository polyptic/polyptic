<!--
  SceneStrip — the scene switcher that sits on the LEFT of the Wall top bar (design v4 moved scenes
  there). Shows the saved scenes for the active mural as clickable chips inside a pill group (click =
  apply that scene; the active one is marked), followed by a "Save scene" affordance that snapshots
  the current wall.

  Applying is one click — the store re-applies via the existing instant render path. Saving opens a
  small inline modal to name the scene (mirrors the design's "Save current wall as scene" dialog).

  This relocates the earlier top-bar scene control; the rest of the top bar (Live, screen count) is
  untouched. Full scene management (rename, schedule, delete) lives in the Scenes view.
-->
<script setup lang="ts">
import { ref, computed } from "vue";
import { useConsoleStore } from "../../stores/console";

const store = useConsoleStore();

const scenes = computed(() => store.activeMuralScenes);

function apply(id: string) {
  store.applyScene(id);
}

// ── save-current-wall modal ────────────────────────────────────────────────────
const saveOpen = ref(false);
const sceneName = ref("");
const saving = ref(false);

function openSave() {
  if (!store.activeMuralId) return;
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
</script>

<template>
  <div class="scene-strip">
    <div v-if="scenes.length" class="pills">
      <button
        v-for="s in scenes"
        :key="s.id"
        class="pill"
        :class="{ active: s.id === store.activeSceneId }"
        :title="`Apply ${s.name}`"
        @click="apply(s.id)"
      >
        {{ s.name }}
      </button>
    </div>

    <button class="save" :disabled="!store.activeMuralId" @click="openSave">Save scene</button>

    <!-- ── save modal ───────────────────────────────────────────────────────── -->
    <teleport to="body">
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
    </teleport>
  </div>
</template>

<style scoped>
.scene-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.pills {
  display: inline-flex;
  background: var(--muted-bg);
  border-radius: 9px;
  padding: 3px;
  gap: 2px;
  max-width: 46vw;
  overflow-x: auto;
}
.pill {
  padding: 5px 12px;
  border: none;
  background: transparent;
  border-radius: 7px;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
}
.pill:hover {
  color: var(--fg2);
}
.pill.active {
  background: var(--surface);
  color: var(--fg);
  box-shadow: var(--shadow-sm);
}
.save {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
  font-family: inherit;
  font-size: 12.5px;
  color: var(--fg2);
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  box-shadow: var(--shadow-sm);
}
.save:hover {
  background: var(--muted-bg);
}
.save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
