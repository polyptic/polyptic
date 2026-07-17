<!--
  SelectionToolbar — the floating affordance over the canvas (docs/design selBar).

  Two shapes:
    - multi-select (≥2 loose screens) : "N screens selected" · Assign content ▾ · Clear content ·
                                        Ident · Unplace · ▦ Combine into surface
    - a combined surface selected     : "▦ {name}" · Assign content ▾ · Clear content · Ident · Split

  Bulk (POL-96): assigning a source to a selection, and CLEARING one, are single REST calls — the
  server fans out to every player and writes ONE activity line, so "put this on those five screens"
  costs one interaction and one broadcast. "Clear content" is the explicit unset the console never
  had: the panels fall back to the idle splash instead of being handed some other page to show.

  Combine (POL-100): a wall must be one contiguous region, so a gappy selection is called out BEFORE
  the operator commits — with a "Pack & combine" that closes the gaps (bezel-tight) and combines in
  one atomic server call. The same rule is enforced server-side; this is the friendly half of it.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { rectsAreAdjacent } from "@polyptic/protocol";
import type { Rect } from "@polyptic/protocol";
import { useConsoleStore } from "../../stores/console";
import { useIdent } from "./useIdent";
import { kindGlyph } from "../../content";

const store = useConsoleStore();
const { identMany, flash } = useIdent();

const wall = computed(() => store.selectedWall);
const count = computed(() => store.selectedScreenIds.length);

// Show for a selected combined surface, or for a multi-screen pre-combine selection.
const show = computed(() => !!wall.value || count.value > 1);

const label = computed(() =>
  wall.value ? `▦ ${store.wallName(wall.value.id)}` : `${count.value} screens selected`,
);

// ── content: assign across the selection, or clear it ────────────────────────
const menuOpen = ref(false);
const sources = computed(() => store.sources);

const targets = computed(() =>
  wall.value
    ? { screenIds: [] as string[], wallIds: [wall.value.id] }
    : { screenIds: [...store.selectedScreenIds], wallIds: [] as string[] },
);

/** Does anything in the selection currently have content? (Nothing to clear if not.) */
const hasContent = computed(() => {
  if (wall.value) return store.wallHasContent(wall.value.id);
  return store.selectedScreenIds.some((id) => (store.screenById(id)?.surfaceCount ?? 0) > 0);
});

function assign(sourceId: string) {
  menuOpen.value = false;
  void store.bulkSetContent(targets.value, { sourceId });
}

function clearContent() {
  menuOpen.value = false;
  void store.bulkSetContent(targets.value, null);
}

// ── combine, with the adjacency pre-flight ───────────────────────────────────
const memberRects = computed<Rect[]>(() =>
  store.selectedScreenIds
    .map((id) => store.placementForScreen(id))
    .filter((p): p is NonNullable<typeof p> => !!p),
);
/** The selection's screens don't form one contiguous region — combining would leave a hole. */
const gappy = computed(
  () => !wall.value && count.value > 1 && !rectsAreAdjacent(memberRects.value),
);
const combineNote = ref("");

watch([() => store.selectedScreenIds, () => store.selectedWallId], () => {
  combineNote.value = "";
  menuOpen.value = false;
});

async function combine(pack: boolean) {
  const muralId = store.activeMuralId;
  if (!muralId || count.value < 2) return;
  const result = await store.combine(muralId, [...store.selectedScreenIds], pack);
  combineNote.value =
    result === "not-adjacent"
      ? "Those screens don't sit next to each other. Pack them to close the gaps, or move them together."
      : result === "failed"
        ? "Combine failed because the control plane refused it."
        : "";
}

function identSel() {
  if (wall.value) {
    store.identWall(wall.value.id);
    flash([...wall.value.memberScreenIds]);
  } else {
    identMany([...store.selectedScreenIds]);
  }
}

function unplaceSel() {
  void store.unplaceScreens([...store.selectedScreenIds]);
}

function splitWall() {
  if (wall.value) store.split(wall.value.id);
}
</script>

<template>
  <div v-if="show" class="sel-wrap">
    <div class="sel-toolbar">
      <span class="sel-count">{{ label }}</span>

      <!-- Assign one source across the whole selection (one call, one broadcast). -->
      <div class="sel-menu-anchor">
        <button class="sel-btn" :disabled="!sources.length" @click="menuOpen = !menuOpen">
          Assign content <span class="caret">▾</span>
        </button>
        <div v-if="menuOpen" class="sel-menu">
          <button v-for="s in sources" :key="s.id" class="sel-menu-item" @click="assign(s.id)">
            <span class="mi-glyph">{{ kindGlyph(s.kind) }}</span>
            <span class="mi-name">{{ s.name }}</span>
          </button>
        </div>
      </div>

      <!-- The explicit unset: show nothing (the panels fall back to the idle splash). -->
      <button class="sel-btn" :disabled="!hasContent" @click="clearContent">Clear content</button>

      <button class="sel-btn" @click="identSel">
        <span class="dot"></span>{{ wall ? "Ident all" : "Ident" }}
      </button>

      <button v-if="!wall" class="sel-btn" @click="unplaceSel">Unplace</button>

      <button v-if="wall" class="sel-action split" @click="splitWall">Split</button>
      <button v-else class="sel-action combine" @click="combine(false)">▦ Combine into surface</button>
    </div>

    <!-- Adjacency: warn before the operator commits, and offer to close the gaps. -->
    <div v-if="gappy || combineNote" class="sel-note">
      <span class="note-text">
        {{
          combineNote ||
          "These screens aren't adjacent. A combined surface must be one contiguous block."
        }}
      </span>
      <button class="note-btn" @click="combine(true)">Pack &amp; combine</button>
    </div>
  </div>
</template>

<style scoped>
.sel-wrap {
  position: absolute;
  left: 50%;
  top: 14px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  z-index: 90;
}
.sel-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 6px 6px 6px 12px;
  box-shadow: var(--shadow-lg);
}
.sel-count {
  font-size: 12px;
  color: var(--fg2);
  font-weight: 500;
  white-space: nowrap;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sel-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 12px;
  color: var(--fg2);
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}
.sel-btn:hover:not(:disabled) {
  background: var(--muted-bg);
}
.sel-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.sel-btn .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.caret {
  font-size: 9px;
  color: var(--muted2);
}
.sel-menu-anchor {
  position: relative;
}
.sel-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  min-width: 200px;
  max-height: 260px;
  overflow-y: auto;
  padding: 5px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 100;
}
.sel-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  font-size: 12px;
  color: var(--fg2);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.sel-menu-item:hover {
  background: var(--muted-bg);
}
.mi-glyph {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted2);
}
.mi-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sel-action {
  display: flex;
  align-items: center;
  padding: 6px 11px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
  border: 1px solid transparent;
}
.sel-action.combine {
  background: var(--primary);
  color: var(--primary-fg);
}
.sel-action.combine:hover {
  opacity: 0.92;
}
.sel-action.split {
  background: var(--surface);
  border-color: var(--line2);
  color: var(--bad);
}
.sel-action.split:hover {
  background: var(--bad-soft);
}
.sel-note {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 520px;
  padding: 7px 8px 7px 12px;
  border-radius: 9px;
  border: 1px solid var(--warn-line, var(--line2));
  background: var(--surface);
  box-shadow: var(--shadow);
}
.note-text {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.45;
}
.note-btn {
  flex: 0 0 auto;
  padding: 5px 10px;
  border-radius: 7px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}
.note-btn:hover {
  background: var(--muted-bg);
}
</style>
