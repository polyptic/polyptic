<!--
  WallCanvas — the spatial Vue Flow canvas of placed screens.

  Renders store.placedScreens(activeMuralId) as custom "screen" nodes at their
  placement {x,y} sized to {w,h}. Placement coordinates are in *canvas pixels*
  where the default w/h equal a screen's native resolution (≈1920×1080), so we
  apply a fixed display scale to keep tiles tile-sized and labels legible at
  zoom 1 (Vue Flow's own pan/zoom still works on top).

  Interactions (POL-96 / POL-100 — the canvas now behaves like the Studio):
    - drag a screen     → snaps to its neighbours' edges/centres (dashed guides), then store.moveScreen
    - drag a WALL       → the whole combined surface moves as one unit, in one atomic server call;
                          the server re-checks adjacency and refuses a move that would break it up
    - drag several      → every selected tile moves together (one atomic call)
    - shift-drag pane   → rubber-band select
    - click             → select; shift-click toggles multi-select
    - arrows            → nudge the selection (Shift = a big step), snapping as it goes
    - Delete/Backspace  → unplace the selection · Escape → clear it
    - drop a tray item (HTML5 DnD, screenId in dataTransfer) → store.placeScreen
    - click pane        → clear selection
-->
<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from "vue";
import type { Ref } from "vue";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import type { Node } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import type { Rect, ScreenView } from "@polyptic/protocol";

import { useConsoleStore } from "../../stores/console";
import { useIdent } from "./useIdent";
import {
  GRID_PX,
  NUDGE_BIG_PX,
  NUDGE_PX,
  SNAP_PX,
  nudgeRect,
  snapCandidates,
  snapRect,
  unionBounds,
} from "./snap";
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
const {
  onNodeClick,
  onPaneClick,
  onNodeDragStart,
  onNodeDrag,
  onNodeDragStop,
  onSelectionDragStart,
  onSelectionDrag,
  onSelectionDragStop,
  onPaneReady,
  onSelectionEnd,
  getSelectedNodes,
  fitView,
  viewport,
} = vf;

// Cast past UnwrapRef: wrapping Vue Flow's deeply-generic Node in a ref otherwise trips TS2589.
const nodes = ref([]) as Ref<Node[]>;
const draggingIds = new Set<string>();
/** Where each node sat (display px) when this drag began — the delta is what the server is told. */
const dragOrigin = new Map<string, { x: number; y: number }>();
/** The node ids Vue Flow was last handed — see the note at the end of `reconcile`. */
let lastSignature = "";
let didInitialFit = false;

// Alignment guides (canvas px) shown while a single tile is dragged — the Studio's ergonomics.
const guideX = ref<number | null>(null);
const guideY = ref<number | null>(null);

// A refusal from the control plane (e.g. a move that would break a combined surface). The Wall view
// has no toast rail, so it shows as a transient line over the canvas.
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
function showNotice(message: string): void {
  notice.value = message;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 5000);
}

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
    content: screen.content ?? null,
    machineLabel: machine ? machine.label : screen.machineId,
    connector: screen.connector,
    identing: identingIds.has(screen.id),
    // POL-119 — `casting` = a session is live on the glass NOW (agent-reported); the enabled
    // toggle alone doesn't badge the tile, or every castable screen would shout all day.
    casting: screen.castEnabled === true && screen.castActive === true,
    selected,
    selectedAlone: selected && store.selectedScreenIds.length === 1,
  };
}

/** Vue Flow node id for a combined surface (prefixed so it can never collide with a screen id). */
function wallNodeId(wallId: string): string {
  return `w:${wallId}`;
}

/** The wall id behind a "w:…" node id, or null for a screen node. */
function wallIdOfNode(nodeId: string): string | null {
  return nodeId.startsWith("w:") ? nodeId.slice(2) : null;
}

function buildWallData(wall: { id: string; memberScreenIds: string[] }, bounds: { x: number; y: number; w: number; h: number }) {
  const members = store.wallMembers(wall.id);
  const content = members.map((m) => m.screen.content).find((c) => !!c) ?? null;
  return {
    wallId: wall.id,
    name: store.wallName(wall.id),
    count: wall.memberScreenIds.length,
    allOnline: members.length > 0 && members.every((m) => !!m.screen.online),
    selected: store.selectedWallId === wall.id,
    identing: members.some((m) => identingIds.has(m.screen.id)),
    hasContent: members.some((m) => (m.screen.surfaceCount ?? 0) > 0),
    contentName: content?.name ?? null,
    contentKind: content?.kind ?? null,
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
      // Vue Flow drags every SELECTED node together, so the store's selection is mirrored onto the
      // node — that's what makes a multi-selection move as one (and the marquee's result draggable).
      // `selected` lives on the runtime GraphNode, not the input Node type — hence the cast.
      (existing as unknown as { selected: boolean }).selected = data.selected;
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
        selected: data.selected,
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
      if (!draggingIds.has(nid)) existing.position = pos;
    } else {
      nodes.value.push({
        id: nid,
        type: "wall",
        position: pos,
        data,
        style,
        // POL-100 — a combined surface drags as ONE unit (its members translate together).
        draggable: true,
        selectable: true,
        // NOTE: deliberately NOT mirroring the store's selection onto the wall node. Vue Flow will
        // not sync a reconcile pass that REMOVES a selected node and ADDS another (found live: the
        // optimistic `wall-pending` box was never replaced by the real wall, so it could not be
        // dragged, renamed or given content until a reload). A wall drags as a single node either
        // way; the selection ring is drawn by WallNode itself from the store.
      } as Node);
    }
  }

  // Vue Flow only picks up a model change when the ARRAY ITSELF changes — an in-place edit that keeps
  // the same node COUNT is silently ignored (found live: combining swapped `w:wall-pending` for the
  // real `w:wall-1` without changing the length, and the canvas kept rendering the optimistic box,
  // which could then never be dragged, renamed or given content). Whenever the id set moves, hand
  // Vue Flow a fresh array so the swap actually lands.
  const signature = nodes.value.map((n) => n.id).join("|");
  if (signature !== lastSignature) {
    lastSignature = signature;
    nodes.value = [...nodes.value];
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

// ── geometry helpers (canvas px) ────────────────────────────────────────────

/** The canvas rectangle a node covers: a screen's placement, or a wall's union bounding box. */
function nodeRect(nodeId: string): Rect | undefined {
  const wallId = wallIdOfNode(nodeId);
  if (wallId) return store.wallBounds(wallId);
  return store.placementForScreen(nodeId);
}

/** The screen ids a node stands for (a wall stands for all its members). */
function nodeScreenIds(nodeId: string): string[] {
  const wallId = wallIdOfNode(nodeId);
  if (wallId) return [...(store.wallById(wallId)?.memberScreenIds ?? [])];
  return [nodeId];
}

/** Every OTHER tile's rectangle — what the moving tile snaps against (solo screens + whole walls). */
function siblingRects(movingNodeIds: readonly string[]): Rect[] {
  const muralId = store.activeMuralId;
  if (!muralId) return [];
  const moving = new Set(movingNodeIds.flatMap((id) => nodeScreenIds(id)));
  const walls = store.wallsForMural(muralId);
  const walled = new Set(walls.flatMap((w) => w.memberScreenIds));

  const rects: Rect[] = [];
  for (const wall of walls) {
    if (wall.memberScreenIds.some((sid) => moving.has(sid))) continue;
    const bounds = store.wallBounds(wall.id);
    if (bounds) rects.push(bounds);
  }
  for (const { screen, placement } of store.placedScreens(muralId)) {
    if (moving.has(screen.id) || walled.has(screen.id)) continue;
    rects.push(placement);
  }
  return rects;
}

/** Candidates = every sibling's edges/centres, plus the wall's own outer edges and centre. */
function candidatesFor(movingNodeIds: readonly string[]) {
  const siblings = siblingRects(movingNodeIds);
  return snapCandidates(siblings, unionBounds(siblings));
}

// ── drag ────────────────────────────────────────────────────────────────────
//
// Vue Flow routes a drag of a SELECTED node through its selection machinery (selectionDrag*) and an
// unselected one through nodeDrag* — the same gesture, two event families (found live: a selected
// wall moved on screen and no server call ever went out). Both are wired to the same handlers.
//
// The snap lands on DROP, not mid-drag: Vue Flow recomputes each node's position from the pointer on
// every tick, so a position we wrote during the drag would simply be overwritten. The guides show
// live (that's the preview), and the drop is what clicks into place.

/** The nodes a drag event carries (Vue Flow hands us `nodes` for a group, `node` for a lone tile). */
function draggedNodes(p: any): any[] {
  return p?.nodes?.length ? p.nodes : p?.node ? [p.node] : [];
}

/** The snapped canvas position of a single dragged tile, plus the guides to draw. */
function snapDragged(node: any) {
  const rect = nodeRect(node.id);
  if (!rect) return undefined;
  const moving: Rect = {
    x: node.position.x / SCALE,
    y: node.position.y / SCALE,
    w: rect.w,
    h: rect.h,
  };
  return { rect, ...snapRect(moving, candidatesFor([node.id]), { threshold: SNAP_PX, grid: GRID_PX }) };
}

function handleDragStart(p: any): void {
  for (const n of draggedNodes(p)) {
    draggingIds.add(n.id);
    dragOrigin.set(n.id, { x: n.position.x, y: n.position.y });
  }
}

function handleDrag(p: any): void {
  const list = draggedNodes(p);
  // A multi-tile drag keeps its members' relative geometry — snapping one of them would shear the
  // group, so alignment guides are a single-tile affair (a group still drags + nudges freely).
  if (list.length !== 1) {
    guideX.value = null;
    guideY.value = null;
    return;
  }
  const snapped = snapDragged(list[0]);
  guideX.value = snapped?.guideX ?? null;
  guideY.value = snapped?.guideY ?? null;
}

async function handleDragStop(p: any): Promise<void> {
  const list = draggedNodes(p);
  guideX.value = null;
  guideY.value = null;
  if (list.length === 0) return;

  // A lone tile lands on its SNAPPED position; a group moves by the raw delta it was dragged.
  const single = list.length === 1 ? snapDragged(list[0]) : undefined;
  const first = list[0];
  const origin = dragOrigin.get(first.id);

  let dx = origin ? Math.round((first.position.x - origin.x) / SCALE) : 0;
  let dy = origin ? Math.round((first.position.y - origin.y) / SCALE) : 0;
  if (single) {
    dx = Math.round(single.x - single.rect.x);
    dy = Math.round(single.y - single.rect.y);
  }

  for (const n of list) {
    draggingIds.delete(n.id);
    dragOrigin.delete(n.id);
  }
  if (dx === 0 && dy === 0) {
    reconcile(); // put the tile back where the store says it is (a nudge too small to keep)
    return;
  }

  const wallIds = list
    .map((n: any) => wallIdOfNode(n.id))
    .filter((id: string | null): id is string => !!id);
  const screenIds = list
    .filter((n: any) => !wallIdOfNode(n.id))
    .map((n: any) => n.id as string);

  // One screen on its own keeps the absolute placement path (it carries the snapped x/y exactly).
  // Anything else — a whole combined surface, or a group — is ONE atomic translate on the server.
  if (single && wallIds.length === 0 && screenIds.length === 1) {
    await store.moveScreen(screenIds[0]!, Math.round(single.x), Math.round(single.y));
    return;
  }

  const refusal = await store.moveTargets({ screenIds, wallIds }, dx, dy);
  if (refusal) showNotice(refusal);
  reconcile(); // the authoritative geometry (snapped, or rolled back) repaints the tiles
}

onNodeDragStart(handleDragStart);
onSelectionDragStart(handleDragStart);
onNodeDrag(handleDrag);
onSelectionDrag(handleDrag);
onNodeDragStop(handleDragStop);
onSelectionDragStop(handleDragStop);

// ── selection ───────────────────────────────────────────────────────────────

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

// Rubber-band (shift-drag on the pane) — Vue Flow draws the box; the store owns what it caught.
// Only loose screens are collected: a combined surface is addressed as a whole (selectWall), and
// mixing the two selections has no meaningful bulk action.
onSelectionEnd(() => {
  const caught = getSelectedNodes.value
    .filter((n) => !wallIdOfNode(n.id))
    .map((n) => n.id);
  if (caught.length === 0) return;
  store.select(caught);
});

onPaneClick(() => store.select([]));

// ── keyboard: nudge / unplace / clear (POL-100) ─────────────────────────────

/** True when the operator is typing — the canvas must not eat those keys. */
function typingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
}

/** The current selection as canvas targets: a wall, or some loose screens. */
function selectionTargets(): { screenIds: string[]; wallIds: string[] } {
  const wallId = store.selectedWallId;
  if (wallId) return { screenIds: [], wallIds: [wallId] };
  return { screenIds: [...store.selectedScreenIds], wallIds: [] };
}

async function nudge(dx: number, dy: number): Promise<void> {
  const targets = selectionTargets();
  const nodeIds = [
    ...targets.wallIds.map((id) => wallNodeId(id)),
    ...targets.screenIds,
  ];
  if (nodeIds.length === 0) return;

  let ddx = dx;
  let ddy = dy;
  // A single tile snaps as it nudges (arrow it at its neighbour and it lands bezel-tight); a group
  // moves by the raw step, so its internal geometry is preserved exactly.
  if (nodeIds.length === 1) {
    const rect = nodeRect(nodeIds[0]!);
    if (rect) {
      const snapped = nudgeRect(rect, dx, dy, candidatesFor(nodeIds), SNAP_PX);
      ddx = Math.round(snapped.x - rect.x);
      ddy = Math.round(snapped.y - rect.y);
    }
  }
  const refusal = await store.moveTargets(targets, ddx, ddy);
  if (refusal) showNotice(refusal);
}

async function unplaceSelection(): Promise<void> {
  const targets = selectionTargets();
  // Unplacing a wall's members dissolves the wall and returns the panels to the tray.
  const screenIds = targets.wallIds.length
    ? targets.wallIds.flatMap((id) => store.wallById(id)?.memberScreenIds ?? [])
    : targets.screenIds;
  if (screenIds.length === 0) return;
  await store.unplaceScreens(screenIds);
  store.select([]);
}

function onKeyDown(e: KeyboardEvent): void {
  if (typingInField(e.target)) return;
  const hasSelection = store.selectedWallId !== null || store.selectedScreenIds.length > 0;

  if (e.key === "Escape") {
    store.select([]);
    return;
  }
  if (!hasSelection) return;

  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    void unplaceSelection();
    return;
  }

  const step = e.shiftKey ? NUDGE_BIG_PX : NUDGE_PX;
  switch (e.key) {
    case "ArrowLeft":
      e.preventDefault();
      void nudge(-step, 0);
      break;
    case "ArrowRight":
      e.preventDefault();
      void nudge(step, 0);
      break;
    case "ArrowUp":
      e.preventDefault();
      void nudge(0, -step);
      break;
    case "ArrowDown":
      e.preventDefault();
      void nudge(0, step);
      break;
    default:
      break;
  }
}

onMounted(() => window.addEventListener("keydown", onKeyDown));
onUnmounted(() => {
  window.removeEventListener("keydown", onKeyDown);
  if (noticeTimer) clearTimeout(noticeTimer);
});

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
  // A library source dropped on the canvas → assign it to the screen/surface under the cursor. The
  // dragged id lives in the store (reliable), and we hit-test the node so this works even when the
  // node's own @drop doesn't fire.
  const sid = store.draggingSourceId;
  if (sid) {
    store.endSourceDrag();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const screenId = el?.closest<HTMLElement>("[data-screen-id]")?.dataset.screenId;
    const wallId = el?.closest<HTMLElement>("[data-wall-id]")?.dataset.wallId;
    if (screenId) store.setScreenContent(screenId, { sourceId: sid });
    else if (wallId) store.setWallContent(wallId, { sourceId: sid });
    return;
  }
  // Otherwise: a tray screen dropped on the canvas → place it.
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
  // A source drag is "copy"; a tray-screen placement is "move". Setting the wrong dropEffect makes
  // the browser reject the drop, so honour the in-progress source drag.
  if (e.dataTransfer) e.dataTransfer.dropEffect = store.draggingSourceId ? "copy" : "move";
}

// The guides live in canvas space, so they ride the viewport transform (pan + zoom) with the tiles.
const guideTransform = computed(() => {
  const vp = viewport.value;
  return `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
});
const guideLeft = computed(() => (guideX.value === null ? 0 : guideX.value * SCALE));
const guideTop = computed(() => (guideY.value === null ? 0 : guideY.value * SCALE));
</script>

<template>
  <div class="wall-canvas" @drop="onDrop" @dragover="onDragOver">
    <VueFlow
      v-model:nodes="nodes"
      class="wall-flow"
      :min-zoom="0.2"
      :max-zoom="2"
      :snap-to-grid="false"
      :default-viewport="{ x: 40, y: 40, zoom: 1 }"
      :select-nodes-on-drag="false"
      :nodes-connectable="false"
      :elements-selectable="true"
      selection-key-code="Shift"
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

    <!-- Alignment guides (the Studio's dashed accent lines), drawn in canvas space. -->
    <div class="guides" :style="{ transform: guideTransform }">
      <div v-if="guideX !== null" class="guide-v" :style="{ left: `${guideLeft}px` }"></div>
      <div v-if="guideY !== null" class="guide-h" :style="{ top: `${guideTop}px` }"></div>
    </div>

    <SelectionToolbar />

    <div v-if="notice" class="canvas-notice">{{ notice }}</div>

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

/* guides */
.guides {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
  pointer-events: none;
  z-index: 70;
}
.guide-v {
  position: absolute;
  top: -100000px;
  height: 200000px;
  width: 0;
  border-left: 1px dashed var(--accent);
}
.guide-h {
  position: absolute;
  left: -100000px;
  width: 200000px;
  height: 0;
  border-top: 1px dashed var(--accent);
}

.canvas-notice {
  position: absolute;
  left: 50%;
  bottom: 78px;
  transform: translateX(-50%);
  max-width: 460px;
  padding: 8px 12px;
  border-radius: 9px;
  border: 1px solid var(--line2);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  font-size: 12px;
  color: var(--fg2);
  line-height: 1.45;
  z-index: 95;
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
/* The rubber band (shift-drag on the pane). */
.wall-flow :deep(.vue-flow__selection) {
  background: var(--accent-soft);
  border: 1px dashed var(--accent);
  border-radius: 4px;
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
