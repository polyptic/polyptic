<!--
  Wall.vue — the Wall view shell (Phase 3a).

  Layout mirrors docs/design/console.dc.html:
    top bar : mural switcher · live indicator · "N screens · health"
    body    : Unplaced-screens tray | Vue Flow canvas | Inspector

  The tray lists store.unplacedScreens; each row is draggable (HTML5 DnD,
  screenId in dataTransfer) so it can be dropped onto the canvas, and carries
  an Ident button plus a Place button (places at the next free grid slot). The
  theme toggle lives in the app shell, not here.
-->
<script setup lang="ts">
import { computed } from "vue";
import { useConsoleStore } from "../stores/console";
import { useIdent } from "../components/canvas/useIdent";
import MuralSwitcher from "../components/canvas/MuralSwitcher.vue";
import WallCanvas from "../components/canvas/WallCanvas.vue";
import Inspector from "../components/canvas/Inspector.vue";

const store = useConsoleStore();
const { ident } = useIdent();

const unplaced = computed(() => store.unplacedScreens);
const screenCount = computed(() => store.screens.length);

const alerts = computed(() => store.screens.filter((s) => !s.online).length);
const alertText = computed(() =>
  alerts.value > 0
    ? `· ${alerts.value} ${alerts.value === 1 ? "alert" : "alerts"}`
    : "· healthy",
);
const alertColor = computed(() => (alerts.value > 0 ? "var(--warn)" : "var(--ok)"));

function onDragStart(e: DragEvent, id: string) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData("application/x-polyptic-screen", id);
  e.dataTransfer.setData("text/plain", id);
  e.dataTransfer.effectAllowed = "move";
}

/** Place an unplaced screen at the next free grid slot (canvas px ≈ native res). */
function place(id: string) {
  const muralId = store.activeMuralId;
  if (!muralId) return;
  const n = store.placedScreens(muralId).length;
  const col = n % 4;
  const row = Math.floor(n / 4);
  store.placeScreen(id, muralId, col * 2040, row * 1200);
}
</script>

<template>
  <div class="wall">
    <!-- ── top bar ─────────────────────────────────────────────────────── -->
    <header class="topbar">
      <MuralSwitcher />
      <div class="spacer"></div>
      <div class="live" :class="{ off: !store.connected }">
        <span class="live-dot"></span>{{ store.connected ? "Live" : "Offline" }}
      </div>
      <div class="screens-chip">
        {{ screenCount }} screens
        <span class="alert" :style="{ color: alertColor }">{{ alertText }}</span>
      </div>
    </header>

    <!-- ── body ────────────────────────────────────────────────────────── -->
    <div class="body">
      <!-- Unplaced tray -->
      <aside class="tray">
        <div class="tray-head">Unplaced screens</div>

        <div v-if="unplaced.length" class="tray-list">
          <div
            v-for="s in unplaced"
            :key="s.id"
            class="tray-item"
            draggable="true"
            @dragstart="onDragStart($event, s.id)"
          >
            <div class="tray-top">
              <span class="dot" :style="{ background: s.online ? 'var(--ok)' : 'var(--bad)' }"></span>
              <span class="tray-name">{{ s.friendlyName }}</span>
            </div>
            <div class="tray-actions">
              <button class="mini-btn" @click="ident(s.id)">
                <span class="mini-dot"></span>Ident
              </button>
              <span class="spacer"></span>
              <button class="place-btn" title="Place on the canvas" @click="place(s.id)">
                ⠿ Place
              </button>
            </div>
          </div>
        </div>

        <div v-else class="tray-empty">
          No unplaced screens. Approve a machine in <b>Machines</b> to add more.
        </div>

        <div class="tray-hint">
          Drag a screen onto the canvas, or hit <b>Place</b>. Shift-click adjacent
          screens, then <b>Combine</b> them into one surface.
        </div>
      </aside>

      <!-- Canvas -->
      <WallCanvas class="canvas-area" />

      <!-- Inspector -->
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

/* tray */
.tray {
  width: 222px;
  flex: 0 0 222px;
  border-right: 1px solid var(--line);
  background: var(--surface);
  padding: 18px 14px;
  overflow-y: auto;
}
.tray-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 12px;
}
.tray-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tray-item {
  border: 1px dashed var(--line2);
  border-radius: 9px;
  padding: 8px 8px 8px 9px;
  background: var(--surface);
  cursor: grab;
  user-select: none;
}
.tray-item:active {
  cursor: grabbing;
}
.tray-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.tray-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--fg2);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tray-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mini-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 11px;
  color: var(--fg2);
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.mini-btn:hover {
  background: var(--muted-bg);
}
.mini-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}
.place-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 6px;
  border: none;
  background: var(--muted-bg);
  font-size: 11px;
  color: var(--muted);
  font-weight: 500;
  cursor: grab;
  font-family: inherit;
}
.place-btn:hover {
  color: var(--fg2);
}
.tray-empty {
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.55;
  padding: 4px 0;
}
.tray-empty b {
  color: var(--accent-fg);
  font-weight: 600;
}
.tray-hint {
  margin-top: 14px;
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.55;
}
.tray-hint b {
  color: var(--muted);
  font-weight: 600;
}

/* areas */
.canvas-area {
  flex: 1;
  min-width: 0;
}
.inspector-area {
  width: 272px;
  flex: 0 0 272px;
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
