<script setup lang="ts">
/**
 * POL-108 — what a live surface shows when it is NOT showing frames: a plain-English board, in the
 * region's own box, saying what is wrong and what the wall is doing about it.
 *
 * A wall must never sit on a black rectangle, and a NOC operator glancing at eight camera tiles must
 * be able to tell a dead feed from a dark room. So: the feed's name/host, one honest sentence, and
 * nothing else. Static by construction — the wall-chrome motion rules (D66/POL-67) forbid animating
 * opacity/transform/filter (a software-rendered box drops promoted layers, and the board would be the
 * thing that vanished) and forbid continuous repaints. The dot blinks with a discrete `visibility`
 * step animation, reusing the same keyframes as the connection badge.
 */
import type { StreamHealth } from "./stream-engine";

defineProps<{
  /** The feed, as a human recognises it — its host, redacted of any query string. */
  label: string;
  health: StreamHealth;
  /** One sentence, verbatim from the engine: "no video for 12s (the source stopped sending)". */
  detail: string;
}>();

const TITLES: Record<StreamHealth, string> = {
  connecting: "Connecting to live stream",
  live: "Live",
  recovering: "Live stream interrupted",
  down: "No signal",
};
</script>

<template>
  <div class="stream-board" :class="`stream-board--${health}`">
    <div class="stream-board-head">
      <span class="stream-board-dot" :class="`stream-board-dot--${health}`" />
      <span class="stream-board-title">{{ TITLES[health] }}</span>
    </div>
    <div class="stream-board-label">{{ label }}</div>
    <div class="stream-board-detail">{{ detail }}</div>
  </div>
</template>
