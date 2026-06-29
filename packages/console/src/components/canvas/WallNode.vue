<!--
  WallNode — the custom Vue Flow node for a combined surface (video wall, Phase 3b).

  Purely presentational, driven by the `data` object WallCanvas builds from the
  store (the wall's derived name, panel count, per-member sub-rectangles for the
  bezel seams, plus content / ident / selection flags). It mirrors the combined
  surface from docs/design/console.dc.html (the ▦ box with "SPANS N SCREENS",
  seam lines between members, and ident overlay). The box spans the union of its
  members' placements; the seam cells outline each member so the bezels show.

  Non-draggable: a combined surface is moved by moving its member screens; this
  node only selects (click → store.selectWall).
-->
<script setup lang="ts">
import { computed } from "vue";

interface MemberRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  online: boolean;
}

interface WallNodeData {
  wallId: string;
  name: string;
  count: number;
  allOnline: boolean;
  selected: boolean;
  identing: boolean;
  hasContent: boolean;
  memberRects: MemberRect[];
}

const props = defineProps<{ id: string; data: WallNodeData }>();

const dotColor = computed(() => {
  if (props.data.identing) return "var(--accent)";
  return props.data.allOnline ? "var(--ok)" : "var(--bad)";
});

const ring = computed(() => {
  if (props.data.selected) return "0 0 0 2px var(--accent), var(--shadow-lg)";
  return "var(--shadow)";
});

const nodeStyle = computed<Record<string, string>>(() => {
  const s: Record<string, string> = {};
  // While identing, the keyframe animation owns box-shadow.
  if (!props.data.identing) s.boxShadow = ring.value;
  return s;
});
</script>

<template>
  <div class="wall-node" :class="{ identing: data.identing, selected: data.selected }" :style="nodeStyle">
    <!-- bezel seams: one outlined cell per member, gaps = bezel allowance -->
    <div
      v-for="m in data.memberRects"
      :key="m.id"
      class="seam-cell"
      :style="{ left: m.x + 'px', top: m.y + 'px', width: m.w + 'px', height: m.h + 'px' }"
    ></div>

    <!-- label chip -->
    <div class="label">
      <span class="dot" :style="{ background: dotColor }"></span>
      <span class="name">▦ {{ data.name }}</span>
    </div>

    <!-- ident overlay (wins) -->
    <div v-if="data.identing" class="overlay ident">
      <span class="tag">IDENT</span>
      <span class="big">{{ data.name }}</span>
      <span class="sub">flashing all {{ data.count }} panels…</span>
    </div>

    <template v-else>
      <!-- content: spans across all members -->
      <div v-if="data.hasContent" class="overlay content">
        <span class="spans">SPANS {{ data.count }} SCREENS</span>
        <span class="cname">On air</span>
        <span class="ckind">spanning content</span>
      </div>

      <!-- empty: prompt to set spanning content -->
      <div v-else class="overlay empty">
        <span class="plus">+</span>
        <span class="etext">Set content to span {{ data.count }} screens</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wall-node {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 11px;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  box-sizing: border-box;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
}
.wall-node.identing {
  animation: ident-flash 1.4s infinite;
}

.seam-cell {
  position: absolute;
  border: 1px solid var(--seam);
  box-sizing: border-box;
  pointer-events: none;
  z-index: 1;
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
  z-index: 5;
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

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 3px;
  padding: 0 10px;
  text-align: center;
  z-index: 4;
}
.spans {
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--accent-fg);
  font-weight: 600;
}
.cname {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--fg);
}
.ckind {
  font-size: 10px;
  color: var(--muted);
  font-weight: 500;
}

.empty {
  gap: 5px;
}
.plus {
  font-size: 16px;
  color: var(--accent);
  font-weight: 300;
}
.etext {
  font-size: 10.5px;
  color: var(--muted);
  font-weight: 500;
}

.ident {
  background: rgba(37, 99, 235, 0.16);
  z-index: 6;
}
.tag {
  font-size: 9px;
  letter-spacing: 0.12em;
  color: var(--accent-fg);
  font-weight: 600;
}
.big {
  font-size: 16px;
  font-weight: 600;
  color: var(--fg);
}
.sub {
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
