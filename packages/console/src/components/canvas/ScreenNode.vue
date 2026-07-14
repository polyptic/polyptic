<!--
  ScreenNode — the custom Vue Flow node for a placed screen.

  Purely presentational: it is driven entirely by the `data` object that
  WallCanvas builds from the store (friendly name, connection/online state,
  surface count, machine label, selection + ident flags). It mirrors the
  "screen tile" visual language from docs/design/console.dc.html (buildScreen):
  a translucent label chip with a connection dot, and live / empty / offline /
  ident states. (An `error` branch is included to match the design; the 3a
  contract carries no per-screen error signal, so it is never triggered yet.)
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { ContentKind } from "@polyptic/protocol";
import { useScreenThumbnail } from "./useThumbnails";
import { kindLabel } from "../../content";
import { useConsoleStore } from "../../stores/console";

type ScreenStatus = "live" | "empty" | "offline" | "error";

interface ScreenNodeData {
  screenId: string;
  name: string;
  status: ScreenStatus;
  online: boolean;
  surfaceCount: number;
  content?: { name: string; kind: ContentKind } | null;
  machineLabel: string;
  connector: string;
  identing: boolean;
  /** POL-119 — a cast (AirPlay) session is live on this panel NOW (agent-reported). */
  casting?: boolean;
  selected: boolean;
  selectedAlone: boolean;
}

const props = defineProps<{ id: string; data: ScreenNodeData }>();

// Live preview: the agent's most recent capture of what's actually on this panel, refreshed on a
// throttle by the shared manager and painted as the tile's fill (behind the label/state overlays).
// Paused automatically while the screen is offline, so we fall back to the neutral/empty styling.
const thumbUrl = useScreenThumbnail(
  computed(() => props.data.screenId),
  computed(() => props.data.online),
);

// Only paint a preview when we actually have a frame AND the screen is reachable. An offline screen
// keeps its "Screen dark" treatment; identing wins over everything (handled below).
const hasThumb = computed(
  () => !!thumbUrl.value && props.data.status !== "offline" && !props.data.identing,
);

const dotColor = computed(() => {
  if (props.data.status === "offline") return "var(--bad)";
  if (props.data.status === "error") return "var(--warn)";
  return "var(--ok)";
});

const bgBorder = computed<Record<string, string>>(() => {
  switch (props.data.status) {
    case "offline":
      return { background: "var(--scr-off-bg)", border: "1px solid var(--line)" };
    case "error":
      return { background: "var(--scr-bad-bg)", border: "1px solid var(--scr-bad-line)" };
    case "empty":
      return { background: "var(--scr-empty-bg)", border: "1.5px dashed var(--scr-empty-line)" };
    default:
      return { background: "var(--scr-live)", border: "1px solid var(--line)" };
  }
});

const ring = computed(() => {
  if (props.data.selectedAlone) return "0 0 0 2px var(--accent), var(--shadow-lg)";
  if (props.data.selected) return "0 0 0 1.5px var(--accent-line), var(--shadow)";
  return "var(--shadow-sm)";
});

const nodeStyle = computed<Record<string, string>>(() => {
  const s: Record<string, string> = { ...bgBorder.value };
  // While identing, the keyframe animation owns box-shadow.
  if (!props.data.identing) s.boxShadow = ring.value;
  return s;
});

// The actual content's name + kind (from admin/state), falling back to a generic label only when the
// server hasn't told us what's on the screen.
const contentLabel = computed(() => props.data.content?.name ?? "Showing content");
const kindText = computed(() =>
  props.data.content
    ? kindLabel(props.data.content.kind)
    : `${props.data.surfaceCount} surface${props.data.surfaceCount === 1 ? "" : "s"}`,
);

// Drag-and-drop: drop a library source from the tray onto this screen to assign it as content.
const store = useConsoleStore();
const dropHover = ref(false);
const SRC_TYPE = "application/x-polyptic-source";
function onDragOver(e: DragEvent) {
  // A source drag is in progress (tracked in the store) → become a drop target.
  if (!store.draggingSourceId && !e.dataTransfer?.types.includes(SRC_TYPE)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  dropHover.value = true;
}
function onDrop(e: DragEvent) {
  dropHover.value = false;
  // Read the dragged source from the store (reliable) rather than dataTransfer.getData (empty on
  // some real drops).
  const sid = store.draggingSourceId ?? e.dataTransfer?.getData(SRC_TYPE);
  store.endSourceDrag();
  if (!sid) return;
  e.preventDefault();
  e.stopPropagation();
  store.setScreenContent(props.data.screenId, { sourceId: sid });
}
</script>

<template>
  <div
    class="screen-node"
    :class="{ identing: data.identing, 'has-thumb': hasThumb, 'drop-hover': dropHover }"
    :style="nodeStyle"
    :data-screen-id="data.screenId"
    @dragover="onDragOver"
    @dragleave="dropHover = false"
    @drop="onDrop"
  >
    <!-- live preview fill (behind the label + state overlays) -->
    <div
      v-if="hasThumb"
      class="thumb"
      :style="{ backgroundImage: `url(${thumbUrl})` }"
      aria-hidden="true"
    ></div>

    <!-- label chip -->
    <div class="label">
      <span class="dot" :style="{ background: dotColor }"></span>
      <span class="name">{{ data.name }}</span>
    </div>

    <!-- casting badge (POL-119) — a session is live on the glass right now -->
    <div v-if="data.casting && !data.identing" class="cast-badge" title="A device is casting to this screen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 17a9 9 0 0 1 14 0" opacity="0.4" />
        <path d="M12 15l4.5 6h-9z" fill="currentColor" stroke="none" />
      </svg>
      <span>Casting</span>
    </div>

    <!-- ident overlay (wins over everything else) -->
    <div v-if="data.identing" class="state ident-state">
      <span class="ident-tag">IDENT</span>
      <span class="ident-name">{{ data.name }}</span>
      <span class="ident-sub">flashing on wall…</span>
    </div>

    <template v-else>
      <!-- live -->
      <template v-if="data.status === 'live'">
        <!-- When a preview frame is showing, the picture IS the content — drop the redundant
             "Showing content" label so the capture reads clean; keep the small surface-count tag. -->
        <div v-if="!hasThumb" class="state live-state">
          <span class="content-name">{{ contentLabel }}</span>
        </div>
        <span class="kind-label">{{ kindText }}</span>
      </template>

      <!-- error (not reachable from the 3a contract; kept for parity) -->
      <div v-else-if="data.status === 'error'" class="state error-state">
        <span class="err-glyph">⚠</span>
        <span class="err-text">Content failed to load<br />retrying…</span>
      </div>

      <!-- empty -->
      <div v-else-if="data.status === 'empty' && !hasThumb" class="state empty-state">
        <span class="plus">+</span>
        <span class="empty-text">Drop content</span>
      </div>

      <!-- offline -->
      <div v-else class="state offline-state">
        <span class="off-1">Screen dark</span>
        <span class="off-2">Machine unreachable</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.screen-node {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 9px;
  overflow: hidden;
  cursor: grab;
  user-select: none;
  box-sizing: border-box;
}
.screen-node.identing {
  animation: ident-flash 1.4s infinite;
}
/* Drag-a-source-here affordance. */
.screen-node.drop-hover {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}
/* When a live preview is showing, neutralise the status background so the capture fills cleanly. */
.screen-node.has-thumb {
  background: #0b0d12 !important;
}

/* Live preview fill — the captured frame, scaled to cover the tile, sitting beneath every overlay. */
.thumb {
  position: absolute;
  inset: 0;
  z-index: 1;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
/* A soft top scrim keeps the label chip legible over bright captures. */
.screen-node.has-thumb .label {
  background: rgba(8, 10, 14, 0.62);
  backdrop-filter: blur(4px);
}
.screen-node.has-thumb .name {
  color: #f4f6fb;
}
.screen-node.has-thumb .kind-label {
  color: rgba(244, 246, 251, 0.82);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
}

/* casting badge (POL-119) — top-right, opposite the label chip; same scrim treatment over thumbs
   (grim captures the whole output, so during a session the thumb IS the cast — keep it legible). */
.cast-badge {
  position: absolute;
  top: 7px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  z-index: 4;
  background: var(--label-bg);
  backdrop-filter: blur(3px);
  color: var(--accent-fg);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.cast-badge svg {
  width: 12px;
  height: 12px;
}
.screen-node.has-thumb .cast-badge {
  background: rgba(8, 10, 14, 0.62);
  backdrop-filter: blur(4px);
}

.label {
  position: absolute;
  top: 7px;
  left: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--label-bg);
  padding: 3px 8px;
  border-radius: 6px;
  z-index: 4;
  backdrop-filter: blur(3px);
  max-width: calc(100% - 16px);
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.name {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 5px;
  padding: 0 10px;
  text-align: center;
}
.live-state {
  gap: 3px;
}
.content-name {
  font-size: 11.5px;
  color: var(--fg2);
  font-weight: 500;
}
.kind-label {
  position: absolute;
  bottom: 7px;
  left: 8px;
  font-size: 9.5px;
  color: var(--muted);
  font-weight: 500;
  z-index: 3;
}

.err-glyph {
  font-size: 15px;
  color: var(--bad);
}
.err-text {
  font-size: 10px;
  color: var(--bad);
  font-weight: 500;
  line-height: 1.45;
}

.plus {
  font-size: 16px;
  color: var(--accent);
  font-weight: 300;
}
.empty-text {
  font-size: 10px;
  color: var(--muted);
  font-weight: 500;
}

.off-1 {
  font-size: 10px;
  color: var(--muted);
  font-weight: 500;
}
.off-2 {
  font-size: 9.5px;
  color: var(--bad);
  font-weight: 500;
}

.ident-state {
  gap: 3px;
  background: rgba(37, 99, 235, 0.16);
  z-index: 6;
}
.ident-tag {
  font-size: 9px;
  letter-spacing: 0.12em;
  color: var(--accent-fg);
  font-weight: 600;
}
.ident-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}
.ident-sub {
  font-size: 9.5px;
  color: var(--accent-fg);
}

@keyframes ident-flash {
  0%,
  100% {
    box-shadow: 0 0 0 2px var(--accent), 0 0 26px rgba(59, 130, 246, 0.55);
  }
  50% {
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
  }
}
</style>
