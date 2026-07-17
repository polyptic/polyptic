<!--
  Wall.vue — the Wall view shell (Phase 3a; redesigned for POL-72, design handoff v3).

  Layout:
    top bar : scenes · mural switcher · live indicator · "N screens · health" · activity bell
    body    : content-library sidebar | Vue Flow canvas (+ floating unplaced tray) | Inspector

  The left sidebar is content-library ONLY — unplaced screens live in UnplacedTray, floating
  bottom-center of the canvas (and absent entirely when there are none). The live-activity feed
  is the ActivityBell in the top bar. The theme toggle lives in the app shell, not here.
-->
<script setup lang="ts">
import { computed } from "vue";
import { useConsoleStore } from "../stores/console";
import { kindGlyph, kindLabel, kindColorVar } from "../content";
import MuralSwitcher from "../components/canvas/MuralSwitcher.vue";
import SceneStrip from "../components/canvas/SceneStrip.vue";
import WallCanvas from "../components/canvas/WallCanvas.vue";
import Inspector from "../components/canvas/Inspector.vue";
import UnplacedTray from "../components/canvas/UnplacedTray.vue";
import ActivityBell from "../components/canvas/ActivityBell.vue";

const store = useConsoleStore();

const screenCount = computed(() => store.screens.length);

// ── content library (left panel) ───────────────────────────────────────────
const librarySources = computed(() => store.sources);
const pickedSourceId = computed(() => store.pickedSourceId);

/** Arm a library source for click-to-assign: click it, then click a screen/wall on the canvas.
 *  POL-107 — a VIEWER may not assign content (the server 403s `PUT /screens/:id/content`), so the
 *  library is read-only for it: nothing arms, nothing drags. */
function pickSource(id: string) {
  if (!store.canAuthor) return;
  store.pickSource(id);
}

const alerts = computed(() => store.screens.filter((s) => !s.online).length);
const alertText = computed(() =>
  alerts.value > 0
    ? `· ${alerts.value} ${alerts.value === 1 ? "alert" : "alerts"}`
    : "· healthy",
);
const alertColor = computed(() => (alerts.value > 0 ? "var(--warn)" : "var(--ok)"));

/** Drag a library source onto a screen/surface to assign it (distinct DnD type from screen placement). */
function onSourceDragStart(e: DragEvent, id: string) {
  if (!store.canAuthor) {
    e.preventDefault(); // a viewer's drag never starts — it could only end in a 403
    return;
  }
  store.beginSourceDrag(id); // the drop reads this (store), not the unreliable dataTransfer.getData
  if (!e.dataTransfer) return;
  e.dataTransfer.setData("application/x-polyptic-source", id);
  e.dataTransfer.effectAllowed = "copy";
}
</script>

<template>
  <div class="wall">
    <!-- ── top bar ─────────────────────────────────────────────────────── -->
    <header class="topbar">
      <!-- Scenes on the LEFT (design v4): apply a saved scene in one click, or save the current wall. -->
      <SceneStrip />
      <div class="topbar-divider"></div>
      <MuralSwitcher />
      <div class="spacer"></div>
      <div class="live" :class="{ off: !store.connected }">
        <span class="live-dot"></span>{{ store.connected ? "Live" : "Offline" }}
      </div>
      <div class="screens-chip">
        {{ screenCount }} screens
        <span class="alert" :style="{ color: alertColor }">{{ alertText }}</span>
      </div>
      <ActivityBell />
    </header>

    <!-- ── body ────────────────────────────────────────────────────────── -->
    <div class="body">
      <!-- Content library (the sidebar's only job — unplaced screens live in the canvas tray) -->
      <aside class="library">
        <div class="lib-head">
          <span class="lib-title">Content library</span>
          <router-link class="manage-link" :to="{ name: 'content' }">Manage →</router-link>
        </div>

        <div v-if="librarySources.length" class="lib-list">
          <div
            v-for="s in librarySources"
            :key="s.id"
            class="lib-item"
            :class="{ armed: pickedSourceId === s.id }"
            :title="s.url"
            :draggable="store.canAuthor"
            @click="pickSource(s.id)"
            @dragstart="onSourceDragStart($event, s.id)"
            @dragend="store.endSourceDrag()"
          >
            <span class="lib-glyph" :style="{ color: `var(${kindColorVar(s.kind)})` }">
              {{ kindGlyph(s.kind) }}
            </span>
            <span class="lib-meta">
              <span class="lib-name">{{ s.name }}</span>
              <span class="lib-kind">{{ kindLabel(s.kind) }}</span>
            </span>
          </div>
        </div>
        <div v-else class="lib-empty">
          No sources yet. <router-link class="manage-link" :to="{ name: 'content' }">Add one →</router-link>
        </div>

        <div v-if="pickedSourceId" class="lib-armed-hint">
          Click a screen or surface on the canvas to assign it.
          <button class="lib-cancel" @click="store.clearPickedSource()">Cancel</button>
        </div>

        <div class="lib-hint">
          Shift-click (or shift-drag a box) to select several screens, then <b>Combine</b> them into
          one surface.
        </div>
      </aside>

      <!-- Canvas, with the unplaced tray floating over its bottom edge -->
      <div class="canvas-wrap">
        <WallCanvas class="canvas-area" />
        <UnplacedTray />
      </div>

      <!-- Inspector fills the full right column (the feed pane moved to the top-bar bell) -->
      <Inspector class="inspector-area" />
    </div>
  </div>
</template>

<style scoped>
.wall {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* top bar */
.topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 56px;
  flex: 0 0 56px;
  padding: 0 18px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.spacer {
  flex: 1;
}
.topbar-divider {
  width: 1px;
  height: 22px;
  flex: 0 0 auto;
  background: var(--line);
}
.live {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--muted);
  font-weight: 500;
}
.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  animation: wall-pulse 2s infinite;
}
.live.off .live-dot {
  background: var(--bad);
  animation: none;
}
.screens-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--muted-bg);
  font-size: 12px;
  color: var(--fg2);
  font-weight: 500;
}
.alert {
  font-weight: 600;
}

/* body */
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* content library sidebar */
.library {
  width: 222px;
  flex: 0 0 222px;
  border-right: 1px solid var(--line);
  background: var(--surface);
  padding: 18px 14px;
  overflow-y: auto;
}
.lib-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.lib-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.manage-link {
  font-size: 11px;
  color: var(--accent-fg);
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
}
.manage-link:hover {
  text-decoration: underline;
}
.lib-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.lib-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 9px;
  border-radius: 9px;
  border: 1px solid transparent;
  cursor: pointer;
  user-select: none;
}
.lib-item:hover {
  background: var(--muted-bg);
  border-color: var(--line);
}
.lib-item.armed {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.lib-glyph {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  background: var(--muted-bg);
  font-size: 12px;
  font-weight: 700;
}
.lib-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
  min-width: 0;
}
.lib-name {
  font-size: 12.5px;
  color: var(--fg2);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lib-kind {
  font-size: 10.5px;
  color: var(--muted2);
}
.lib-empty {
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.55;
  padding: 2px 0;
}
.lib-armed-hint {
  margin-top: 10px;
  font-size: 11px;
  color: var(--accent-fg);
  background: var(--accent-soft);
  border-radius: 8px;
  padding: 8px 10px;
  line-height: 1.5;
}
.lib-cancel {
  display: block;
  margin-top: 6px;
  padding: 3px 9px;
  border-radius: 6px;
  border: 1px solid var(--accent-line);
  background: transparent;
  color: var(--accent-fg);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.lib-cancel:hover {
  background: var(--surface);
}
.lib-hint {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.55;
}
.lib-hint b {
  color: var(--muted);
  font-weight: 600;
}

/* areas */
.canvas-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
}
.canvas-area {
  flex: 1;
  min-width: 0;
}
.inspector-area {
  width: 272px;
  flex: 0 0 272px;
  min-height: 0;
}

@keyframes wall-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
</style>
