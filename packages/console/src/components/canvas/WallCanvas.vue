<!--
  WallCanvas — the spatial Vue Flow canvas of placed screens.

  Renders store.placedScreens(activeMuralId) as custom "screen" nodes at their
  placement {x,y} sized to {w,h}. Placement coordinates are in *canvas pixels*
  where the default w/h equal a screen's native resolution (≈1920×1080), so we
  apply a fixed display scale to keep tiles tile-sized and labels legible at
  zoom 1 (Vue Flow's own pan/zoom still works on top).

  Interactions:
    - drag a node  → store.moveScreen (converted back to canvas px)
    - drop a tray item (HTML5 DnD, screenId in dataTransfer) → store.placeScreen
    - click        → store.select([id]); shift-click toggles multi-select
    - click pane   → clear selection
-->
<script setup lang="ts">
import { ref, watch, computed } from "vue";
import type { Ref } from "vue";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import type { Node } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import type { ScreenView } from "@polyptic/protocol";

import { useConsoleStore } from "../../stores/console";
import { useIdent } from "./useIdent";
import ScreenNode from "./ScreenNode.vue";
import WallNode from "./WallNode.vue";
import SelectionToolbar from "./SelectionToolbar.vue";

/** Canvas-px → display-px. 0.094 maps a 1920×1080 screen to ~180×101 — matches the design's tile
 *  size and gives the label + state text room. MIN_TILE_* keeps small/odd-res screens legible. */
const SCALE = 0.094;
const MIN_TILE_W = 150;
const MIN_TILE_H = 96;

const store = useConsoleStore();
const { identingIds } = useIdent();

const vf = useVueFlow();
const { onNodeClick, onPaneClick, onNodeDragStart, onNodeDragStop, onPaneReady, fitView } = vf;

// Cast past UnwrapRef: wrapping Vue Flow's deeply-generic Node in a ref otherwise trips TS2589.
const nodes = ref([]) as Ref<Node[]>;
const draggingIds = new Set<string>();
let didInitialFit = false;

const hasPlaced = computed(() =>
  store.activeMuralId ? store.placedScreens(store.activeMuralId).length > 0 : false,
);

function statusOf(screen: ScreenView): "live" | "empty" | "offline" {
  if (!screen.online) return "offline";
  return screen.surfaceCount > 0 ? "live" : "empty";
}

function buildData(screen: ScreenView) {
  const machine = store.machineForScreen(screen.id);
  const selected = store.selectedScreenIds.includes(screen.id);
  return {
    screenId: screen.id,
    name: screen.friendlyName,
    status: statusOf(screen),
    online: !!screen.online,
    surfaceCount: screen.surfaceCount ?? 0,
    machineLabel: machine ? machine.label : screen.machineId,
    connector: screen.connector,
    identing: identingIds.has(screen.id),
    selected,
    selectedAlone: selected && store.selectedScreenIds.length === 1,
  };
}

/** Vue Flow node id for a combined surface (prefixed so it can never collide with a screen id). */
function wallNodeId(wallId: string): string {
  return `w:${wallId}`;
}

function buildWallData(wall: { id: string; memberScreenIds: string[] }, bounds: { x: number; y: number; w: number; h: number }) {
  const members = store.wallMembers(wall.id);
  return {
    wallId: wall.id,
    name: store.wallName(wall.id),
    count: wall.memberScreenIds.length,
    allOnline: members.length > 0 && members.every((m) => !!m.screen.online),
    selected: store.selectedWallId === wall.id,
    identing: members.some((m) => identingIds.has(m.screen.id)),
    hasContent: members.some((m) => (m.screen.surfaceCount ?? 0) > 0),
    // Member sub-rectangles relative to the union box (canvas px → display px) for the bezel seams.
    memberRects: members.map((m) => ({
      id: m.screen.id,
      x: (m.placement.x - bounds.x) * SCALE,
      y: (m.placement.y - bounds.y) * SCALE,
      w: m.placement.w * SCALE,
      h: m.placement.h * SCALE,
      online: !!m.screen.online,
    })),
  };
}

/** Reconcile the Vue Flow node list with the store, mutating in place so the
 *  canvas doesn't lose drag/selection state on every server push. Combined
 *  surfaces become "wall" nodes spanning their members' union; the member
 *  screens themselves are NOT drawn as solo tiles (they render inside the wall). */
function reconcile() {
  const muralId = store.activeMuralId;
  const placed = muralId ? store.placedScreens(muralId) : [];
  const walls = muralId ? store.wallsForMural(muralId) : [];
  const walledIds = new Set(walls.flatMap((w) => w.memberScreenIds));

  // Screens drawn as solo tiles = placed screens that aren't members of a combined surface.
  const soloScreens = placed.filter((p) => !walledIds.has(p.screen.id));

  // Every node id we still want present after this pass.
  const wantedIds = new Set<string>([
    ...soloScreens.map((p) => p.screen.id),
    ...walls.map((w) => wallNodeId(w.id)),
  ]);

  // Drop nodes that are no longer wanted (unplaced, walled, or a vanished wall).
  for (let i = nodes.value.length - 1; i >= 0; i--) {
    const n = nodes.value[i];
    if (n && !wantedIds.has(n.id)) nodes.value.splice(i, 1);
  }

  // ── solo screen tiles ──
  for (const { screen, placement } of soloScreens) {
    const data = buildData(screen);
    const pos = { x: placement.x * SCALE, y: placement.y * SCALE };
    const zIndex = data.identing ? 55 : data.selectedAlone ? 50 : data.selected ? 40 : 10;
    const style = {
      width: `${Math.max(placement.w * SCALE, MIN_TILE_W)}px`,
      height: `${Math.max(placement.h * SCALE, MIN_TILE_H)}px`,
      zIndex: String(zIndex),
    };
    const existing = nodes.value.find((n) => n.id === screen.id);
    if (existing) {
      existing.data = data;
      existing.style = style;
      // Don't yank a node out from under an in-progress drag.
      if (!draggingIds.has(screen.id)) {
        const cx = existing.position?.x ?? 0;
        const cy = existing.position?.y ?? 0;
        if (Math.abs(cx - pos.x) > 0.5 || Math.abs(cy - pos.y) > 0.5) existing.position = pos;
      }
    } else {
      nodes.value.push({
        id: screen.id,
        type: "screen",
        position: pos,
        data,
        style,
        draggable: true,
        selectable: true,
      } as Node);
    }
  }

  // ── combined surface boxes ──
  for (const wall of walls) {
    const bounds = store.wallBounds(wall.id);
    if (!bounds) continue;
    const nid = wallNodeId(wall.id);
    const data = buildWallData(wall, bounds);
    const pos = { x: bounds.x * SCALE, y: bounds.y * SCALE };
    const zIndex = data.identing ? 56 : data.selected ? 46 : 12;
    const style = {
      width: `${bounds.w * SCALE}px`,
      height: `${bounds.h * SCALE}px`,
      zIndex: String(zIndex),
    };
    const existing = nodes.value.find((n) => n.id === nid);
    if (existing) {
      existing.data = data;
      existing.style = style;
      existing.position = pos;
    } else {
      nodes.value.push({
        id: nid,
        type: "wall",
        position: pos,
        data,
        style,
        draggable: false,
        selectable: true,
      } as Node);
    }
  }
}

watch(
  () => [
    store.activeMuralId,
    store.placements,
    store.machines,
    store.videoWalls,
    store.selectedScreenIds,
    store.selectedWallId,
    [...identingIds],
  ],
  reconcile,
  { deep: true, immediate: true },
);

// Frame the wall once the first screens appear.
watch(
  () => nodes.value.length,
  (len) => {
    if (len > 0 && !didInitialFit) {
      didInitialFit = true;
      requestAnimationFrame(() => {
        try {
          fitView({ padding: 0.25 });
        } catch {
          /* canvas not ready yet — onPaneReady will catch it */
        }
      });
    }
  },
);

onPaneReady(() => {
  if (nodes.value.length > 0 && !didInitialFit) {
    didInitialFit = true;
    try {
      fitView({ padding: 0.25 });
    } catch {
      /* noop */
    }
  }
});

onNodeDragStart((p: any) => {
  const list = p?.nodes ?? (p?.node ? [p.node] : []);
  for (const n of list) draggingIds.add(n.id);
});

onNodeDragStop((p: any) => {
  const list = p?.nodes ?? (p?.node ? [p.node] : []);
  for (const n of list) {
    draggingIds.delete(n.id);
    // Only screen tiles are draggable; combined surfaces (type "wall") are not moved here.
    if (n.type === "wall") continue;
    store.moveScreen(n.id, Math.round(n.position.x / SCALE), Math.round(n.position.y / SCALE));
  }
});

onNodeClick((p: any) => {
  const node = p.node;
  // Click-to-assign: when a library source is armed in the left panel, clicking a screen or surface
  // assigns it (the server resolves the source to a surface of its kind) and disarms — no select.
  if (store.pickedSourceId) {
    if (node?.type === "wall") {
      const wid = node.data.wallId as string;
      store.assignPickedToWall(wid);
      store.selectWall(wid);
    } else {
      const sid = node.id as string;
      store.assignPickedToScreen(sid);
      store.select([sid]);
    }
    return;
  }
  // Clicking a combined surface selects the whole wall.
  if (node?.type === "wall") {
    store.selectWall(node.data.wallId as string);
    return;
  }
  const id = node.id as string;
  const ev = p.event;
  const shift = !!(ev && (ev.shiftKey || (ev.srcEvent && ev.srcEvent.shiftKey)));
  if (shift) {
    const cur = new Set(store.selectedScreenIds);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    store.select([...cur]);
  } else {
    store.select([id]);
  }
});

onPaneClick(() => store.select([]));

// ── Drop a screen from the Unplaced tray onto the canvas ───────────────────
function toFlow(clientX: number, clientY: number): { x: number; y: number } {
  const anyVf = vf as any;
  if (typeof anyVf.screenToFlowCoordinate === "function") {
    return anyVf.screenToFlowCoordinate({ x: clientX, y: clientY });
  }
  // Fallback for older @vue-flow/core: invert the viewport transform manually.
  const rect = anyVf.vueFlowRef?.value?.getBoundingClientRect?.();
  const vp = anyVf.viewport?.value ?? { x: 0, y: 0, zoom: 1 };
  const left = rect ? rect.left : 0;
  const top = rect ? rect.top : 0;
  return { x: (clientX - left - vp.x) / vp.zoom, y: (clientY - top - vp.y) / vp.zoom };
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  const dt = e.dataTransfer;
  const id = dt
    ? dt.getData("application/x-polyptic-screen") || dt.getData("text/plain")
    : "";
  if (!id || !store.activeMuralId) return;
  const f = toFlow(e.clientX, e.clientY);
  store.placeScreen(id, store.activeMuralId, Math.round(f.x / SCALE), Math.round(f.y / SCALE));
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
}
</script>

<template>
  <div class="wall-canvas" @drop="onDrop" @dragover="onDragOver">
    <VueFlow
      v-model:nodes="nodes"
      class="wall-flow"
      :min-zoom="0.2"
      :max-zoom="2"
      :snap-to-grid="true"
      :snap-grid="[12, 12]"
      :default-viewport="{ x: 40, y: 40, zoom: 1 }"
      :select-nodes-on-drag="false"
      :nodes-connectable="false"
      :elements-selectable="true"
    >
      <Background :gap="24" :size="1.2" pattern-color="var(--dot)" />
      <Controls :show-interactive="false" />

      <template #node-screen="nodeProps">
        <ScreenNode :id="nodeProps.id" :data="nodeProps.data" />
      </template>

      <template #node-wall="nodeProps">
        <WallNode :id="nodeProps.id" :data="nodeProps.data" />
      </template>
    </VueFlow>

    <SelectionToolbar />

    <div v-if="!hasPlaced" class="empty-canvas">
      <div class="empty-card">
        <div class="empty-glyph">▦</div>
        <div class="empty-title">No screens on this mural yet</div>
        <div class="empty-sub">
          Drag a screen from the <b>Unplaced</b> tray onto the canvas, or hit <b>Place</b>.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wall-canvas {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  background: var(--bg);
  overflow: hidden;
}
.wall-flow {
  width: 100%;
  height: 100%;
}

.empty-canvas {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 26px 30px;
  border: 1.5px dashed var(--line2);
  border-radius: 13px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  text-align: center;
  max-width: 320px;
}
.empty-glyph {
  font-size: 22px;
  color: var(--muted2);
}
.empty-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fg2);
}
.empty-sub {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}

/* Tone Vue Flow's chrome to the console palette. */
.wall-flow :deep(.vue-flow__node) {
  font-family: inherit;
}
/* Selection + focus are drawn by ScreenNode's own ring — silence Vue Flow's. */
.wall-flow :deep(.vue-flow__node:focus),
.wall-flow :deep(.vue-flow__node:focus-visible) {
  outline: none;
}
.wall-flow :deep(.vue-flow__node-screen.selected) {
  box-shadow: none;
}
.wall-flow :deep(.vue-flow__controls) {
  box-shadow: var(--shadow);
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--line);
}
.wall-flow :deep(.vue-flow__controls-button) {
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  color: var(--fg2);
  width: 28px;
  height: 28px;
}
.wall-flow :deep(.vue-flow__controls-button:hover) {
  background: var(--muted-bg);
}
.wall-flow :deep(.vue-flow__controls-button svg) {
  fill: currentColor;
}
</style>
