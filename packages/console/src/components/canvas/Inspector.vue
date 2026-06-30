<!--
  Inspector — the right-hand context panel for the canvas selection.

  Three states, mirroring docs/design/console.dc.html:
    - empty   : nothing selected → prompt to pick a screen
    - single  : rename, Ident (flash on wall), status + "Driven by {machine}",
                assign content (type a URL), layout read-out, remove from wall
    - multi   : count + member list + Ident-all; combining lands in 3b

  All reads/writes go through the Pinia store; ident uses the shared composable.
-->
<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useConsoleStore } from "../../stores/console";
import { useIdent } from "./useIdent";
import { kindLabel } from "../../content";

const store = useConsoleStore();
const { ident, identMany, flash, isIdenting } = useIdent();

// The content library, for the "Assign from library" pickers (single screen + combined surface).
const librarySources = computed(() => store.sources);

const selectedIds = computed(() => store.selectedScreenIds);
const count = computed(() => selectedIds.value.length);

// A combined surface takes precedence: selecting a wall clears the screen selection.
const wall = computed(() => store.selectedWall);

const single = computed(() => {
  if (wall.value) return undefined;
  const id = selectedIds.value[0];
  return count.value === 1 && id ? store.screenById(id) : undefined;
});
const members = computed(() =>
  selectedIds.value
    .map((id) => store.screenById(id))
    .filter((s): s is NonNullable<typeof s> => !!s),
);

// ── combined surface (wall) view ───────────────────────────────────────────
const wallMembers = computed(() => (wall.value ? store.wallMembers(wall.value.id) : []));
const wallName = computed(() => (wall.value ? store.wallName(wall.value.id) : ""));
const wallHasContent = computed(() => (wall.value ? store.wallHasContent(wall.value.id) : false));
const wallIdenting = computed(() =>
  wall.value ? wall.value.memberScreenIds.some((id) => isIdenting(id)) : false,
);
const wallRes = computed(() => {
  if (!wall.value) return "—";
  const b = store.wallBounds(wall.value.id);
  return b ? `${Math.round(b.w)} × ${Math.round(b.h)}` : "—";
});
const wallSurfaceText = computed(() => {
  const n = wallMembers.value.reduce((sum, m) => sum + (m.screen.surfaceCount ?? 0), 0);
  return `${n} surface${n === 1 ? "" : "s"} on air`;
});

// The actual content (name + kind) on the selection — a wall shows its source via any member.
const singleContent = computed(() => single.value?.content ?? null);
const wallContent = computed(() => wallMembers.value.map((m) => m.screen.content).find((c) => !!c) ?? null);
const singleContentKind = computed(() =>
  singleContent.value ? kindLabel(singleContent.value.kind) : surfaceText.value,
);
const wallContentKind = computed(() =>
  wallContent.value ? `${kindLabel(wallContent.value.kind)} · spans all panels` : wallSurfaceText.value,
);

const wallUrlDraft = ref("");
const wallSourcePick = ref("");
watch(wall, () => {
  wallUrlDraft.value = "";
  wallSourcePick.value = "";
});
// A just-combined wall carries a temp id until the authoritative admin/state re-points it; spanning
// content against the temp id would 404, so the Span control is disabled until the real wall arrives.
const wallPending = computed(() => (wall.value ? wall.value.id.startsWith("wall-pending") : false));
function submitWallUrl() {
  if (!wall.value || wallPending.value) return;
  const u = wallUrlDraft.value.trim();
  if (!u) return;
  store.setWallContent(wall.value.id, { url: u });
  wallUrlDraft.value = "";
}
function assignWallSource() {
  if (!wall.value || wallPending.value) return;
  const id = wallSourcePick.value;
  if (!id) return;
  store.setWallContent(wall.value.id, { sourceId: id });
  wallSourcePick.value = "";
}
function identWall() {
  if (!wall.value) return;
  store.identWall(wall.value.id);
  flash([...wall.value.memberScreenIds]);
}
function splitWall() {
  if (wall.value) store.split(wall.value.id);
}

// ── multi-select pre-combine ───────────────────────────────────────────────
function combine() {
  const muralId = store.activeMuralId;
  if (!muralId || count.value < 2) return;
  store.combine(muralId, [...selectedIds.value]);
}

// ── rename ─────────────────────────────────────────────────────────────────
const nameDraft = ref("");
watch(
  single,
  (s) => {
    nameDraft.value = s ? s.friendlyName : "";
  },
  { immediate: true },
);
function commitName() {
  const s = single.value;
  if (!s) return;
  const v = nameDraft.value.trim();
  if (v && v !== s.friendlyName) store.renameScreen(s.id, v);
  else nameDraft.value = s.friendlyName;
}

// ── content: library source + ad-hoc URL ────────────────────────────────────
const urlDraft = ref("");
const sourcePick = ref("");
watch(single, () => {
  urlDraft.value = "";
  sourcePick.value = "";
});
function submitUrl() {
  const s = single.value;
  if (!s) return;
  const u = urlDraft.value.trim();
  if (!u) return;
  store.setScreenContent(s.id, { url: u });
  urlDraft.value = "";
}
function assignSource() {
  const s = single.value;
  if (!s) return;
  const id = sourcePick.value;
  if (!id) return;
  store.setScreenContent(s.id, { sourceId: id });
  sourcePick.value = "";
}

// ── derived single-screen view ─────────────────────────────────────────────
const identingSingle = computed(() => (single.value ? isIdenting(single.value.id) : false));
const statusLabel = computed(() => {
  const s = single.value;
  if (!s) return "";
  if (identingSingle.value) return "Identing…";
  return s.online ? "Connected" : "Unreachable";
});
const statusColor = computed(() => {
  const s = single.value;
  if (!s) return "var(--ok)";
  return s.online ? "var(--ok)" : "var(--bad)";
});
const machineLine = computed(() => {
  const s = single.value;
  if (!s) return "";
  const m = store.machineForScreen(s.id);
  return `${m ? m.label : s.machineId} · ${s.connector}`;
});
const placement = computed(() =>
  single.value ? store.placementForScreen(single.value.id) : undefined,
);
const posText = computed(() => {
  const p = placement.value;
  return p ? `x ${Math.round(p.x)}  y ${Math.round(p.y)}` : "—";
});
const sizeText = computed(() => {
  const p = placement.value;
  return p ? `${Math.round(p.w)} × ${Math.round(p.h)}` : "—";
});
const hasContent = computed(() => (single.value?.surfaceCount ?? 0) > 0);
const surfaceText = computed(() => {
  const n = single.value?.surfaceCount ?? 0;
  return `${n} surface${n === 1 ? "" : "s"} on air`;
});

// ── actions ────────────────────────────────────────────────────────────────
function identSingle() {
  if (single.value) ident(single.value.id);
}
function identAll() {
  identMany([...selectedIds.value]);
}
function unplace() {
  if (single.value) store.unplaceScreen(single.value.id);
}
function selectOne(id: string) {
  store.select([id]);
}
</script>

<template>
  <div class="inspector">
    <!-- ── COMBINED SURFACE (video wall) ──────────────────────────────── -->
    <section v-if="wall" class="pad">
      <div class="group-head">▦ Combined surface</div>
      <div class="group-name">{{ wallName }}</div>

      <div class="group-actions">
        <button class="ident-btn flex" :class="{ on: wallIdenting }" @click="identWall">
          <span class="dot accent"></span>{{ wallIdenting ? "Flashing…" : "Ident all" }}
        </button>
        <button class="split-btn" @click="splitWall">Split</button>
      </div>

      <div class="section-label">Content · spans whole surface</div>
      <div v-if="wallHasContent" class="content-card">
        <span class="thumb seamed">
          <span class="seam-v" style="left: 33%"></span>
          <span class="seam-v" style="left: 66%"></span>
          <span class="seam-h"></span>
        </span>
        <span class="content-meta">
          <span class="content-name">{{ wallContent?.name ?? "On air" }}</span>
          <span class="content-kind">{{ wallContentKind }}</span>
        </span>
      </div>
      <div v-else class="content-empty">No content yet — spans across</div>

      <div v-if="librarySources.length" class="lib-pick">
        <select
          v-model="wallSourcePick"
          class="lib-select"
          :disabled="wallPending"
          @change="assignWallSource"
        >
          <option value="" disabled>Assign from library…</option>
          <option v-for="s in librarySources" :key="s.id" :value="s.id">
            {{ kindLabel(s.kind) }} · {{ s.name }}
          </option>
        </select>
      </div>
      <div v-else class="lib-empty">
        No saved sources.
        <router-link class="lib-link" :to="{ name: 'content' }">Manage library →</router-link>
      </div>

      <div class="url-field">
        <input
          v-model="wallUrlDraft"
          class="url-input"
          placeholder="https://…"
          :disabled="wallPending"
          @keyup.enter="submitWallUrl"
        />
        <button class="url-btn" :disabled="!wallUrlDraft.trim() || wallPending" @click="submitWallUrl">
          Span
        </button>
      </div>
      <div class="hint">
        A library source (or ad-hoc URL) spans across every panel, with bezel seams shown.
      </div>

      <div class="panels-head">
        <span class="section-label flush">{{ wall.memberScreenIds.length }} panels</span>
        <span class="panels-res">{{ wallRes }}</span>
      </div>
      <div class="member-list">
        <div v-for="m in wallMembers" :key="m.screen.id" class="member static">
          <span class="dot" :style="{ background: m.screen.online ? 'var(--ok)' : 'var(--bad)' }"></span>
          <span class="member-name">{{ m.screen.friendlyName }}</span>
          <span class="spacer"></span>
          <span class="member-kind">{{ m.screen.connector }}</span>
        </div>
      </div>
    </section>

    <!-- ── SINGLE ─────────────────────────────────────────────────────── -->
    <section v-else-if="single" class="pad">
      <div class="section-label">Screen</div>
      <input
        v-model="nameDraft"
        class="name-input"
        @blur="commitName"
        @keyup.enter="commitName"
      />

      <button class="ident-btn" :class="{ on: identingSingle }" @click="identSingle">
        <span class="dot accent"></span>
        {{ identingSingle ? "Flashing on wall…" : "Ident — flash on wall" }}
      </button>

      <div class="status-row">
        <span class="dot" :style="{ background: statusColor }"></span>
        <span class="status-text">{{ statusLabel }}</span>
      </div>
      <div class="driven-by">Driven by {{ machineLine }}</div>

      <div class="section-label gap-top">Content</div>
      <div v-if="hasContent" class="content-card">
        <span class="thumb"></span>
        <span class="content-meta">
          <span class="content-name">{{ singleContent?.name ?? "On air" }}</span>
          <span class="content-kind">{{ singleContentKind }}</span>
        </span>
      </div>
      <div v-else class="content-empty">No content yet</div>

      <div v-if="librarySources.length" class="lib-pick">
        <select v-model="sourcePick" class="lib-select" @change="assignSource">
          <option value="" disabled>Assign from library…</option>
          <option v-for="s in librarySources" :key="s.id" :value="s.id">
            {{ kindLabel(s.kind) }} · {{ s.name }}
          </option>
        </select>
      </div>
      <div v-else class="lib-empty">
        No saved sources.
        <router-link class="lib-link" :to="{ name: 'content' }">Manage library →</router-link>
      </div>

      <div class="url-field">
        <input
          v-model="urlDraft"
          class="url-input"
          placeholder="https://…"
          @keyup.enter="submitUrl"
        />
        <button class="url-btn" :disabled="!urlDraft.trim()" @click="submitUrl">Show</button>
      </div>
      <div class="hint">Pick a library source above, or paste an ad-hoc URL to show it here.</div>

      <div class="section-label gap-top">Layout</div>
      <div class="layout-grid">
        <div class="layout-cell">{{ posText }}</div>
        <div class="layout-cell">{{ sizeText }}</div>
      </div>

      <button class="unplace-btn" @click="unplace">Remove from wall</button>
    </section>

    <!-- ── MULTI (pre-combine) ────────────────────────────────────────── -->
    <section v-else-if="count > 1" class="pad">
      <div class="section-label">Selection</div>
      <div class="multi-count">{{ count }} screens selected</div>

      <div class="group-actions">
        <button class="combine-btn" @click="combine">▦ Combine into surface</button>
        <button class="ident-btn shrink" @click="identAll">
          <span class="dot accent"></span>Ident
        </button>
      </div>

      <div class="member-list">
        <button
          v-for="m in members"
          :key="m.id"
          class="member"
          @click="selectOne(m.id)"
        >
          <span class="dot" :style="{ background: m.online ? 'var(--ok)' : 'var(--bad)' }"></span>
          <span class="member-name">{{ m.friendlyName }}</span>
        </button>
      </div>

      <div class="hint gap-top">
        Combining treats these panels as one screen — content spans across all of
        them, with bezel seams shown.
      </div>
    </section>

    <!-- ── EMPTY ──────────────────────────────────────────────────────── -->
    <section v-else class="pad">
      <div class="section-label">Screen</div>
      <div class="empty-state">
        <span class="empty-glyph">◫</span>
        <span class="empty-title">Select a screen on the canvas</span>
        <span class="empty-sub">
          Click to rename &amp; ident · shift-click<br />several to multi-select
        </span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  border-left: 1px solid var(--line);
  overflow-y: auto;
}
.pad {
  padding: 18px 16px;
}

.section-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 11px;
}
.gap-top {
  margin-top: 18px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.dot.accent {
  background: var(--accent);
}

.name-input {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  outline: none;
  margin-bottom: 12px;
  font-family: inherit;
}
.name-input:focus {
  border-color: var(--accent);
}

.ident-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  color: var(--fg);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  margin-bottom: 18px;
  font-family: inherit;
}
.ident-btn:hover {
  background: var(--muted-bg);
}
.ident-btn.on {
  border-color: var(--accent-line);
  color: var(--accent-fg);
}
.ident-btn.block {
  margin-bottom: 16px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.status-text {
  font-size: 12.5px;
  color: var(--fg2);
  font-weight: 500;
}
.driven-by {
  font-size: 12px;
  color: var(--muted);
}

.content-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px;
  border-radius: 9px;
  border: 1px solid var(--line);
}
.thumb {
  width: 44px;
  height: 26px;
  border-radius: 5px;
  background: var(--scr-live);
  flex: 0 0 auto;
}
.content-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.35;
}
.content-name {
  font-size: 12.5px;
  color: var(--fg2);
  font-weight: 500;
}
.content-kind {
  font-size: 10.5px;
  color: var(--muted2);
}
.content-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 14px;
  border: 1.5px dashed var(--line2);
  border-radius: 9px;
  font-size: 12px;
  color: var(--muted);
}

.url-field {
  display: flex;
  gap: 7px;
  margin-top: 10px;
}
.url-input {
  flex: 1;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 12.5px;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.url-input:focus {
  border-color: var(--accent);
}
.url-btn {
  padding: 9px 14px;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.url-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.url-btn:not(:disabled):hover {
  opacity: 0.92;
}

/* library source picker */
.lib-pick {
  margin-top: 10px;
}
.lib-select {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 12.5px;
  color: var(--fg);
  outline: none;
  font-family: inherit;
  cursor: pointer;
}
.lib-select:focus {
  border-color: var(--accent);
}
.lib-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.lib-empty {
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--muted2);
  line-height: 1.5;
}
.lib-link {
  color: var(--accent-fg);
  font-weight: 600;
  text-decoration: none;
}
.lib-link:hover {
  text-decoration: underline;
}

.hint {
  margin-top: 8px;
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.55;
}

.layout-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  font-size: 11.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.layout-cell {
  background: var(--muted-bg);
  border-radius: 7px;
  padding: 7px 9px;
}

.unplace-btn {
  margin-top: 18px;
  width: 100%;
  padding: 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.unplace-btn:hover {
  background: var(--bad-soft);
  color: var(--bad);
  border-color: var(--scr-bad-line);
}

.multi-count {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 14px;
}
.member-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.member {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}
.member:hover {
  background: var(--muted-bg);
}
.member-name {
  font-size: 12.5px;
  color: var(--fg2);
  font-weight: 500;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 34px 12px;
  border: 1.5px dashed var(--line2);
  border-radius: 11px;
  text-align: center;
}
.empty-glyph {
  font-size: 20px;
  color: var(--muted2);
}
.empty-title {
  font-size: 12.5px;
  color: var(--muted);
  font-weight: 500;
}
.empty-sub {
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.5;
}

/* ── combined surface (wall) ── */
.group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-fg);
  margin-bottom: 11px;
}
.group-name {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
}
.ident-btn.flex {
  flex: 1;
  margin-bottom: 0;
}
.ident-btn.shrink {
  width: auto;
  flex: 0 0 auto;
  margin-bottom: 0;
  padding: 10px 13px;
}
.split-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  color: var(--bad);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  font-family: inherit;
}
.split-btn:hover {
  background: var(--bad-soft);
}
.combine-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.combine-btn:hover {
  opacity: 0.92;
}

.thumb.seamed {
  position: relative;
  overflow: hidden;
}
.seam-v {
  position: absolute;
  top: 0;
  width: 1px;
  height: 100%;
  background: var(--seam);
}
.seam-h {
  position: absolute;
  left: 0;
  top: 50%;
  width: 100%;
  height: 1px;
  background: var(--seam);
}

.panels-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 18px;
  margin-bottom: 10px;
}
.section-label.flush {
  margin-bottom: 0;
}
.panels-res {
  font-size: 11px;
  color: var(--muted2);
  font-variant-numeric: tabular-nums;
}
.member.static {
  cursor: default;
}
.member.static:hover {
  background: transparent;
}
.member .spacer {
  flex: 1;
}
.member-kind {
  font-size: 10.5px;
  color: var(--muted2);
}
</style>
