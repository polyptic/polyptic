<!--
  Overlays.vue — the OVERLAYS VIEW (POL-97).

  An overlay is a PAGE (authored in the Studio, like any other page) composited ABOVE whatever content
  a screen is showing: a corner logo, an emergency ticker, a "MEETING IN PROGRESS" banner. It never
  replaces content — the wall keeps playing underneath, takeover included.

  The view is two halves:
    - APPLY: pick a page, pick a scope (fleet / a mural / a wall / a screen), apply. Re-applying a
      scope replaces its overlay; "Remove" takes it off. Both reach the glass in one push, no reload.
    - COVERAGE: every screen that currently WEARS an overlay, and which scope won it — resolved by the
      same precedence the server applies (screen > wall > mural > fleet), so what the operator reads
      here is what the wall is actually showing.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import type { OverlayScope } from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";

const store = useConsoleStore();
const router = useRouter();

/** Only a page can be an overlay — it is the one kind that composes (transparent bg, % regions). */
const pages = computed(() => store.contentSources.filter((s) => s.kind === "page"));

const scope = ref<OverlayScope>("fleet");
const targetId = ref<string>("");
const sourceId = ref<string>("");
const busy = ref(false);

/** The targets on offer for the chosen scope. Fleet has none (there is one fleet). */
const targets = computed<{ id: string; label: string }[]>(() => {
  if (scope.value === "mural") return store.murals.map((m) => ({ id: m.id, label: m.name }));
  if (scope.value === "wall") {
    return store.videoWalls.map((w) => ({
      id: w.id,
      label: w.name ?? `Wall of ${w.memberScreenIds.length}`,
    }));
  }
  if (scope.value === "screen") {
    return store.screens.map((s) => ({ id: s.id, label: s.friendlyName }));
  }
  return [];
});

const canApply = computed(
  () => sourceId.value !== "" && (scope.value === "fleet" || targetId.value !== ""),
);

function onScopeChange(): void {
  targetId.value = "";
}

async function apply(): Promise<void> {
  if (!canApply.value || busy.value) return;
  busy.value = true;
  await store.applyOverlay(
    scope.value,
    scope.value === "fleet" ? undefined : targetId.value,
    sourceId.value,
  );
  busy.value = false;
}

async function remove(s: OverlayScope, t?: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  await store.removeOverlay(s, t);
  busy.value = false;
}

function sourceName(id: string): string {
  return store.contentSources.find((s) => s.id === id)?.name ?? id;
}

/** How a scope reads in the list: "Every screen", "Mural — Atrium", "Screen — Nessie". */
function scopeLabel(s: OverlayScope, t?: string): string {
  if (s === "fleet") return "Every screen";
  if (s === "mural") return `Mural — ${store.murals.find((m) => m.id === t)?.name ?? t}`;
  if (s === "wall") {
    const wall = store.videoWalls.find((w) => w.id === t);
    return `Wall — ${wall?.name ?? t}`;
  }
  return `Screen — ${store.screenById(t ?? "")?.friendlyName ?? t}`;
}

/** Every screen currently wearing an overlay + the scope that won it (the client resolves it with
 *  the same precedence the server does, so this is what is really on the glass). */
const coverage = computed(() =>
  store.screens
    .map((screen) => ({ screen, overlay: store.overlayCoverage(screen.id) }))
    .filter((entry): entry is { screen: (typeof entry)["screen"]; overlay: NonNullable<(typeof entry)["overlay"]> } =>
      entry.overlay !== undefined,
    ),
);

const overlays = computed(() => store.overlays);
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <div class="head">
        <div class="head-text">
          <h1 class="title">Overlays</h1>
          <p class="subtitle">
            A page composited <em>above</em> whatever is playing — a logo, a ticker, a banner. The
            content underneath keeps running: an overlay never replaces it. The narrowest scope
            covering a screen wins: screen beats wall beats mural beats fleet.
          </p>
        </div>
        <button class="ghost-btn" @click="router.push({ name: 'studio' })">Author a page</button>
      </div>

      <!-- APPLY -->
      <section class="card">
        <div class="card-title">Apply an overlay</div>
        <div v-if="pages.length === 0" class="empty">
          No pages in the library yet. Compose one in the Studio (a transparent-friendly layout — a
          logo in a corner, a ticker across the bottom), then apply it here.
        </div>
        <div v-else class="apply-row">
          <label class="field">
            <span class="field-label">Page</span>
            <select v-model="sourceId" class="select">
              <option value="" disabled>Choose a page…</option>
              <option v-for="p in pages" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>

          <label class="field">
            <span class="field-label">Scope</span>
            <select v-model="scope" class="select" @change="onScopeChange">
              <option value="fleet">Fleet — every screen</option>
              <option value="mural">Mural</option>
              <option value="wall">Wall</option>
              <option value="screen">Screen</option>
            </select>
          </label>

          <label v-if="scope !== 'fleet'" class="field">
            <span class="field-label">Target</span>
            <select v-model="targetId" class="select">
              <option value="" disabled>Choose…</option>
              <option v-for="t in targets" :key="t.id" :value="t.id">{{ t.label }}</option>
            </select>
          </label>

          <button class="apply-btn" :disabled="!canApply || busy" @click="apply">Apply</button>
        </div>
      </section>

      <!-- ASSIGNMENTS -->
      <section class="card">
        <div class="card-title">Assignments</div>
        <div v-if="overlays.length === 0" class="empty">No overlays applied.</div>
        <div v-else class="list">
          <div v-for="o in overlays" :key="`${o.scope}:${o.targetId ?? '*'}`" class="row">
            <span class="scope-tag" :class="`scope-${o.scope}`">{{ o.scope }}</span>
            <span class="row-name">{{ scopeLabel(o.scope, o.targetId) }}</span>
            <span class="row-source">{{ sourceName(o.sourceId) }}</span>
            <button class="del-btn" title="Remove" @click="remove(o.scope, o.targetId)">✕</button>
          </div>
        </div>
      </section>

      <!-- COVERAGE -->
      <section class="card">
        <div class="card-title">Screens carrying an overlay</div>
        <div v-if="coverage.length === 0" class="empty">
          No screen is currently wearing an overlay.
        </div>
        <div v-else class="list">
          <div v-for="entry in coverage" :key="entry.screen.id" class="row">
            <span class="dot" />
            <span class="row-name">{{ entry.screen.friendlyName }}</span>
            <span class="row-source">{{ sourceName(entry.overlay.sourceId) }}</span>
            <span class="scope-tag" :class="`scope-${entry.overlay.scope}`">
              via {{ entry.overlay.scope }}
            </span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.page-inner {
  max-width: 840px;
  margin: 0 auto;
  padding: 30px 32px 60px;
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 24px;
}
.head-text {
  flex: 1;
}
.title {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 4px;
}
.subtitle {
  font-size: 13.5px;
  color: var(--muted);
  margin: 0;
  line-height: 1.5;
}
.ghost-btn {
  padding: 9px 16px;
  border-radius: 9px;
  border: 1px solid var(--line2);
  background: transparent;
  color: var(--fg2);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
}
.ghost-btn:hover {
  background: var(--muted-bg);
}
.card {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--card);
  box-shadow: var(--shadow-sm);
  padding: 16px 18px;
  margin-bottom: 16px;
}
.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 12px;
}
.empty {
  font-size: 12.5px;
  color: var(--muted2);
  line-height: 1.5;
}
.apply-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 170px;
}
.field-label {
  font-size: 11px;
  color: var(--muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.select {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 9px;
  font-size: 12.5px;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.select:focus {
  border-color: var(--accent);
}
.apply-btn {
  padding: 9px 16px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.apply-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 11px 13px;
  background: var(--surface);
}
.row-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.row-source {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.scope-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  background: var(--muted-bg);
  color: var(--muted);
  white-space: nowrap;
}
.scope-fleet {
  background: var(--ok-soft);
  color: var(--ok);
}
.dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--ok);
}
.del-btn {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}
.del-btn:hover {
  color: var(--bad);
  border-color: var(--bad);
}
</style>
