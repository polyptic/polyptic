<!--
  PageCanvas — a whole PageDefinition rendered into whatever box the parent gives it.

  The player mounts this inside a page surface's content box (which may be span-sized for video
  walls); the Studio uses PageElementView directly (it needs its own per-element wrappers for
  selection/drag), so THIS component stays a dumb draw-the-definition renderer.

  The root declares `container-type: size`, which is what makes every element's cqh-based sizing
  track the PAGE's rendered size — the same definition reads identically on the Studio canvas, a
  1080p panel, and a spanned video wall (where this box is the full spanning content's size).
-->
<script setup lang="ts">
import { computed } from "vue";
import type { PageData, PageDefinition } from "@polyptic/protocol";
import PageElementView from "./PageElementView.vue";

const props = withDefaults(
  defineProps<{
    definition: PageDefinition;
    data?: PageData;
    live?: boolean;
    resolveSrc?: (src: string) => string;
    /** POL-97 — draw the page as an OVERLAY: its authored background is ignored and the canvas is
     *  transparent, so the content underneath shows through everywhere an element isn't. The same
     *  renderer, one flag — an overlay IS a page, and a second renderer could only drift from this one. */
    transparent?: boolean;
  }>(),
  { data: undefined, live: true, resolveSrc: undefined, transparent: false },
);

const background = computed(() => (props.transparent ? "transparent" : props.definition.bg));
</script>

<template>
  <div class="page-canvas" :style="{ background }">
    <div
      v-for="(element, i) in definition.elements"
      :key="element.id"
      class="page-canvas-el"
      :style="{
        left: `${element.x}%`,
        top: `${element.y}%`,
        width: `${element.w}%`,
        height: `${element.h}%`,
        zIndex: 10 + i,
      }"
    >
      <PageElementView :element="element" :data="data" :live="live" :resolve-src="resolveSrc" />
    </div>
  </div>
</template>

<style scoped>
.page-canvas {
  position: absolute;
  inset: 0;
  overflow: hidden;
  container-type: size;
}
.page-canvas-el {
  position: absolute;
}
</style>
