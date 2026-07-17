<!--
  SceneDiffCard — the APPLY PREVIEW (POL-95).

  Applying a scene to a 12-screen mural used to be a blind leap: one click and the wall jumped. This
  card is the read-out — hover (or focus) an Apply affordance and the server tells you, before you
  commit, what the apply would do: which screens change content, which move, which walls combine or
  split, what gets cleared. Terraform-plan / kubectl-diff, in a hovercard.

  It is a READ-OUT, NOT A GATE: apply is still one click and this never blocks it. The diff is computed
  server-side (`GET /scenes/:id/diff`) because the control plane is the only thing that knows BOTH the
  saved snapshot and the live wall — the same engine that decides whether the Active badge still holds,
  so the preview and the badge can never disagree.
-->
<script setup lang="ts">
import { ref, computed, watch } from "vue";
import type { SceneDiff, SceneDiffEntry } from "@polyptic/protocol";

import { useConsoleStore } from "../../stores/console";

const props = defineProps<{ sceneId: string }>();

const store = useConsoleStore();

const diff = ref<SceneDiff | null>(null);
const loading = ref(true);

async function load(id: string): Promise<void> {
  loading.value = true;
  diff.value = null;
  const result = await store.fetchSceneDiff(id);
  // Ignore a late response for a scene the operator has already hovered away from.
  if (id !== props.sceneId) return;
  diff.value = result;
  loading.value = false;
}

watch(() => props.sceneId, load, { immediate: true });

/** "3 screens change content · 1 screen moves · 1 wall splits" — the glanceable line. */
const headline = computed<string>(() => {
  const d = diff.value;
  if (!d) return "";
  const s = d.summary;
  const screens = (n: number): string => `${n} ${n === 1 ? "screen" : "screens"}`;
  const walls = (n: number): string => `${n} ${n === 1 ? "wall" : "walls"}`;
  const parts: string[] = [];
  if (s.contentChanges) parts.push(`${s.contentChanges} ${s.contentChanges === 1 ? "target" : "targets"} change content`);
  if (s.cleared) parts.push(`${s.cleared} cleared`);
  if (s.moves) parts.push(`${screens(s.moves)} move`);
  if (s.placed) parts.push(`${screens(s.placed)} placed`);
  if (s.unplaced) parts.push(`${screens(s.unplaced)} removed from the mural`);
  if (s.combines) parts.push(`${walls(s.combines)} combine`);
  if (s.splits) parts.push(`${walls(s.splits)} split`);
  return parts.join(" · ");
});

const CHANGE_LABEL: Record<SceneDiffEntry["changes"][number], string> = {
  content: "content",
  cleared: "cleared",
  move: "moves",
  place: "placed",
  unplace: "off the mural",
  combine: "combines",
  split: "splits",
};

function contentLabel(side: SceneDiffEntry["from"]): string {
  return side ? side.label : "nothing";
}
</script>

<template>
  <div class="diff-card" role="tooltip">
    <div v-if="loading" class="line muted">Working out what would change…</div>

    <template v-else-if="diff">
      <div v-if="diff.identical" class="line muted">
        Nothing would change because the wall already matches this scene.
      </div>

      <template v-else>
        <div class="headline">{{ headline }}</div>

        <ul class="entries">
          <li v-for="e in diff.entries" :key="e.id" class="entry">
            <span class="entry-name" :class="{ wall: e.target === 'wall' }">{{ e.name }}</span>
            <span class="chips">
              <span v-for="c in e.changes" :key="c" class="chip" :class="c">
                {{ CHANGE_LABEL[c] }}
              </span>
            </span>
            <span v-if="e.changes.includes('content') || e.changes.includes('cleared')" class="flow">
              <span class="from">{{ contentLabel(e.from) }}</span>
              <span class="arrow">→</span>
              <span class="to" :class="{ empty: e.to === null }">{{ contentLabel(e.to) }}</span>
            </span>
          </li>
        </ul>

        <div v-if="diff.summary.unchanged" class="line muted">
          {{ diff.summary.unchanged }} unchanged
        </div>
      </template>

      <ul v-if="diff.warnings.length" class="warnings">
        <li v-for="w in diff.warnings" :key="w">{{ w }}</li>
      </ul>
    </template>

    <div v-else class="line muted">No preview available for this scene.</div>
  </div>
</template>

<style scoped>
.diff-card {
  width: 330px;
  max-width: calc(100vw - 32px);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 12px 13px;
  box-shadow: var(--shadow-lg);
  font-size: 12px;
  color: var(--fg2);
  text-align: left;
  cursor: default;
}
.headline {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 9px;
  line-height: 1.45;
}
.line {
  line-height: 1.45;
}
.muted {
  color: var(--muted);
}
.entries {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-height: 240px;
  overflow-y: auto;
}
.entry {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  line-height: 1.35;
}
.entry-name {
  font-weight: 600;
  color: var(--fg);
}
.entry-name.wall::before {
  content: "▦ ";
  color: var(--muted);
}
.chips {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
}
.chip {
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--muted-bg);
  color: var(--muted);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  text-transform: lowercase;
  white-space: nowrap;
}
.chip.content,
.chip.combine {
  color: var(--fg2);
}
.chip.cleared,
.chip.unplace,
.chip.split {
  color: var(--warn);
}
.flow {
  flex-basis: 100%;
  display: flex;
  align-items: baseline;
  gap: 5px;
  color: var(--muted);
  min-width: 0;
}
.from,
.to {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 44%;
}
.to {
  color: var(--fg2);
  font-weight: 500;
}
.to.empty {
  color: var(--muted);
  font-style: italic;
}
.arrow {
  color: var(--muted);
}
.warnings {
  list-style: none;
  margin: 8px 0 0;
  padding: 8px 0 0;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--warn);
  line-height: 1.4;
}
</style>
