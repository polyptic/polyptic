<!--
  Inspector — the right-hand context panel for the canvas selection.

  Four states, mirroring the POL-72 design handoff (v3):
    - empty   : nothing selected → prompt to pick a screen
    - single  : live preview (mirrors the tile's canvas state, status chip overlaid) · rename ·
                "Driven by {machine}" + mono connector chip · Ident · content (LIBRARY only —
                ad-hoc URL entry was removed as an anti-pattern; add URLs to the Content library
                instead) · page zoom · layout read-out · remove from wall. The header carries a ⋯
                overflow menu with the dev-tools quick-launch (POL-85): the same arm-then-open flow
                as the Machines view (chrome = remote DevTools in a new tab, surf = the on-panel
                inspector), via the shared useScreenInspect composable — an operator debugging a
                wall never has to leave this page.
    - wall    : a combined surface — rename, Ident all / Split, spanning content, member panels
    - multi   : count + member list + Ident-all + Combine

  The zoom control (POL-57) appears only when the selection frames a page — a web or dashboard
  surface. Media has nothing to zoom, and an empty screen has nothing at all, so in both cases the
  control is absent rather than disabled. The server remembers each value against the (screen-or-wall,
  page) pair, which is what the "Remembered for this screen" caption is promising the operator.

  The groom panel (POL-98 — crop / scroll / dashboard refresh) sits under it on exactly the same test,
  and is remembered against exactly the same pair; only its refresh row is kind-specific (dashboards).

  All reads/writes go through the Pinia store; ident uses the shared composable.
-->
<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from "vue";
import { useConsoleStore } from "../../stores/console";
import { useIdent } from "./useIdent";
import { kindLabel } from "../../content";
import { devtoolsUrl } from "../../api";
import { useScreenInspect, type InspectTarget } from "../useInspect";
import ZoomControl from "./ZoomControl.vue";
import GroomControl from "./GroomControl.vue";
import type { SurfaceGroom } from "@polyptic/protocol";

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

// ── page zoom (POL-57) ──────────────────────────────────────────────────────
// The live zoom rides on the content read-out, and is present only for framed (web/dashboard)
// content — so `zoom !== undefined` is exactly the question "can this selection be zoomed?".
const singleZoom = computed(() => singleContent.value?.zoom);
const wallZoom = computed(() => wallContent.value?.zoom);

function zoomScreen(zoom: number) {
  const s = single.value;
  if (s) store.setScreenZoom(s.id, zoom);
}
function zoomWall(zoom: number) {
  const w = wall.value;
  if (w && !wallPending.value) store.setWallZoom(w.id, zoom);
}

// ── grooming (POL-98) ───────────────────────────────────────────────────────
// Crop / scroll / refresh ride on the same content read-out as the zoom and are present on exactly
// the same test (framed content), so the groom panel appears wherever the zoom control does. The
// refresh cadence is offered only for a DASHBOARD — that cadence is what the kind means.
const singleGroom = computed(() => singleContent.value?.groom);
const wallGroom = computed(() => wallContent.value?.groom);
const singleCanRefresh = computed(() => singleContent.value?.kind === "dashboard");
const wallCanRefresh = computed(() => wallContent.value?.kind === "dashboard");

function groomScreen(groom: SurfaceGroom) {
  const s = single.value;
  if (s) store.setScreenGroom(s.id, groom);
}
function groomWall(groom: SurfaceGroom) {
  const w = wall.value;
  if (w && !wallPending.value) store.setWallGroom(w.id, groom);
}

const wallSourcePick = ref("");
watch(wall, () => {
  wallSourcePick.value = "";
});

// ── combined-surface name (editable) ────────────────────────────────────────
// Mirrors the single-screen rename pattern: a draft synced from `wallName` (which is the
// operator-chosen name when set, else the derived member-join). Commit on blur/Enter; an empty or
// unchanged value reverts to the current label rather than sending a blank rename.
const wallNameDraft = ref("");
watch(
  wallName,
  (n) => {
    wallNameDraft.value = n;
  },
  { immediate: true },
);
function commitWallName() {
  const w = wall.value;
  if (!w) return;
  const v = wallNameDraft.value.trim();
  if (v && v !== wallName.value) store.renameWall(w.id, v);
  else wallNameDraft.value = wallName.value; // revert blank / no-op edits
}
// A just-combined wall carries a temp id until the authoritative admin/state re-points it; spanning
// content against the temp id would 404, so the Span control is disabled until the real wall arrives.
const wallPending = computed(() => (wall.value ? wall.value.id.startsWith("wall-pending") : false));
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

// ── content: library sources only (the ad-hoc URL bypass was removed — POL-72) ──
const sourcePick = ref("");
watch(single, () => {
  sourcePick.value = "";
});
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
const machineName = computed(() => {
  const s = single.value;
  if (!s) return "";
  const m = store.machineForScreen(s.id);
  return m ? m.label : s.machineId;
});

// ── dev-tools quick-launch (POL-85 — the ⋯ overflow in the single-screen header) ──
// Identical flow + semantics to the Machines view's per-screen button, via the shared composable:
// chrome = arm the POL-67 remote-DevTools tunnel and open it in a new tab; surf/unknown = the
// on-panel Web Inspector (confirmed first — it shows ON the glass and reloads the page). Offline
// machines leave the item disabled with the explanatory tooltip.
const menuOpen = ref(false);
// Refusals/timeouts surface as a transient inline notice — the Wall view has no toast rail.
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
function showNotice(message: string): void {
  notice.value = message;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 5000);
}
onUnmounted(() => {
  if (noticeTimer) clearTimeout(noticeTimer);
});

const inspectTarget = computed<InspectTarget | undefined>(() => {
  const s = single.value;
  if (!s) return undefined;
  const m = store.machineForScreen(s.id);
  return {
    screen: s,
    machineLabel: m?.label ?? s.machineId,
    machineOnline: m?.online === true,
    browser: m?.browser,
  };
});
const {
  isChrome,
  inspecting,
  pending: inspectPending,
  disabled: inspectDisabled,
  title: inspectTitle,
  toggle: toggleInspect,
} = useScreenInspect(inspectTarget, {
  inspect: (id, on) => store.inspectScreen(id, on),
  devtoolsUrl,
  notify: showNotice,
});
const inspectItemLabel = computed(() => {
  if (inspectPending.value) return inspecting.value ? "Closing…" : "Opening…";
  if (isChrome.value) return inspecting.value ? "Disarm DevTools" : "Open DevTools";
  return inspecting.value ? "Close on-panel inspector" : "Inspect on panel";
});
function launchInspect(): void {
  menuOpen.value = false;
  void toggleInspect();
}
// Close the menu (and drop any stale notice) when the selection moves to a different screen —
// keyed on the id, NOT the object, which is fresh on every broadcast.
watch(
  () => single.value?.id,
  () => {
    menuOpen.value = false;
    notice.value = "";
  },
);

// ── live preview (mirrors the tile's canvas state: live / offline / empty) ──
const previewState = computed<"live" | "offline" | "empty">(() => {
  const s = single.value;
  if (!s || !s.online) return "offline";
  return hasContent.value ? "live" : "empty";
});
const previewMain = computed(() => {
  switch (previewState.value) {
    case "offline":
      return "Screen dark";
    case "empty":
      return "No content";
    default:
      return singleContent.value?.name ?? "On air";
  }
});
const previewSub = computed(() => {
  switch (previewState.value) {
    case "offline":
      return "machine unreachable";
    case "empty":
      return "drop or assign content";
    default:
      return singleContentKind.value;
  }
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
      <input
        v-model="wallNameDraft"
        class="group-name-input"
        :disabled="wallPending"
        placeholder="Name this surface…"
        @blur="commitWallName"
        @keyup.enter="commitWallName"
      />

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
      <div v-else class="content-empty">Drag content to span across</div>

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

      <div class="hint">
        A library source spans across every panel, with bezel seams shown.
      </div>

      <template v-if="wallZoom !== undefined">
        <div class="section-label gap-top">Zoom</div>
        <ZoomControl
          :zoom="wallZoom"
          :disabled="wallPending"
          caption="Applies to the whole surface — the page zooms as one, across all panels."
          @update="zoomWall"
        />
      </template>

      <template v-if="wallGroom !== undefined">
        <div class="section-label gap-top">Grooming</div>
        <GroomControl
          :groom="wallGroom"
          :can-refresh="wallCanRefresh"
          :disabled="wallPending"
          caption="Cropped and parked across the whole surface — the panels stay one continuous page."
          @update="groomWall"
        />
      </template>

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
      <!-- header: section label + the ⋯ overflow (dev-tools quick-launch, POL-85) -->
      <div class="head-row">
        <span class="section-label flush">Screen</span>
        <div class="menu-wrap">
          <button
            class="kebab"
            :class="{ open: menuOpen }"
            title="Screen tools"
            aria-label="Screen tools"
            :aria-expanded="menuOpen"
            @click="menuOpen = !menuOpen"
          >
            ⋯
          </button>
          <template v-if="menuOpen">
            <div class="menu-scrim" @click="menuOpen = false" />
            <div class="menu">
              <button
                class="menu-item"
                :disabled="inspectDisabled"
                :title="inspectTitle"
                @click="launchInspect"
              >
                <span class="mi-glyph" aria-hidden="true">&lt;/&gt;</span>{{ inspectItemLabel }}
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- transient notice (inspector refusals/timeouts — nobody is standing at that screen) -->
      <div v-if="notice" class="notice">{{ notice }}</div>

      <!-- Live preview — mirrors the screen's canvas state, status chip overlaid top-left. -->
      <div class="preview" :class="previewState">
        <div class="preview-chip">
          <span class="dot" :style="{ background: statusColor }"></span>
          <span class="preview-status">{{ statusLabel }}</span>
        </div>
        <div class="preview-center">
          <span class="preview-main" :class="{ muted: previewState !== 'live' }">{{ previewMain }}</span>
          <span class="preview-sub">{{ previewSub }}</span>
        </div>
      </div>

      <input
        v-model="nameDraft"
        class="name-input"
        @blur="commitName"
        @keyup.enter="commitName"
      />

      <div class="id-row">
        <span class="driven-by">Driven by {{ machineName }}</span>
        <span class="spacer"></span>
        <span class="conn-chip">{{ single.connector }}</span>
      </div>

      <button class="ident-btn" :class="{ on: identingSingle }" @click="identSingle">
        <span class="dot accent"></span>
        {{ identingSingle ? "Flashing on wall…" : "Ident — flash on wall" }}
      </button>

      <div class="section-label">Content</div>
      <div v-if="hasContent" class="content-card">
        <span class="thumb"></span>
        <span class="content-meta">
          <span class="content-name">{{ singleContent?.name ?? "On air" }}</span>
          <span class="content-kind">{{ singleContentKind }}</span>
        </span>
      </div>
      <div v-else class="content-empty">Drag content here</div>

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

      <template v-if="singleZoom !== undefined">
        <div class="section-label gap-top">Zoom</div>
        <ZoomControl
          :zoom="singleZoom"
          caption="Remembered for this screen and this page."
          @update="zoomScreen"
        />
      </template>

      <template v-if="singleGroom !== undefined">
        <div class="section-label gap-top">Grooming</div>
        <GroomControl
          :groom="singleGroom"
          :can-refresh="singleCanRefresh"
          caption="Crop the chrome off, park the page where it matters — remembered for this screen and this page."
          @update="groomScreen"
        />
      </template>

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
          Click to rename &amp; ident · shift-click<br />several, then combine into a surface
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

/* single-screen header row: section label + the ⋯ overflow (POL-85) */
.head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 9px;
}
.menu-wrap {
  position: relative;
  flex: 0 0 auto;
  display: flex;
}
/* Mirrors the Machines view's kebab/menu language, sized down for the narrow panel. */
.kebab {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}
.kebab:hover,
.kebab.open {
  background: var(--muted-bg);
  color: var(--fg);
}
.menu-scrim {
  position: fixed;
  inset: 0;
  z-index: 30;
}
.menu {
  position: absolute;
  top: 31px;
  right: 0;
  z-index: 31;
  width: 200px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 5px;
  animation: menu-fadein 0.12s ease;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 7px;
  background: none;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg2);
  text-align: left;
  cursor: pointer;
}
.menu-item:hover:not(:disabled) {
  background: var(--muted-bg);
}
.menu-item:disabled {
  opacity: 0.45;
  cursor: default;
}
.mi-glyph {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: -0.5px;
  color: var(--muted2);
}
@keyframes menu-fadein {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* transient inline notice (inspector refusals/timeouts) */
.notice {
  margin-bottom: 10px;
  padding: 7px 10px;
  border-radius: 8px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
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

/* live preview — a 16:9 miniature of the selected screen's canvas tile */
.preview {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  margin-bottom: 12px;
  overflow: hidden;
}
.preview.live {
  background: var(--scr-live);
  border: 1px solid var(--line);
}
.preview.offline {
  background: var(--scr-off-bg);
  border: 1px solid var(--line);
}
.preview.empty {
  background: var(--scr-empty-bg);
  border: 1.5px dashed var(--scr-empty-line);
}
.preview-chip {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--label-bg);
  padding: 3px 8px;
  border-radius: 6px;
  z-index: 2;
  backdrop-filter: blur(3px);
}
.preview-status {
  font-size: 10px;
  font-weight: 600;
  color: var(--fg);
}
.preview-center {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 3px;
  padding: 0 14px;
  text-align: center;
}
.preview-main {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--fg);
}
.preview-main.muted {
  color: var(--muted);
}
.preview-sub {
  font-size: 10px;
  color: var(--muted);
  font-weight: 500;
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
  margin-bottom: 8px;
  font-family: inherit;
}
.name-input:focus {
  border-color: var(--accent);
}

.id-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 16px;
}
.id-row .spacer {
  flex: 1;
}
.conn-chip {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 10.5px;
  color: var(--muted);
  background: var(--muted-bg);
  border-radius: 5px;
  padding: 2px 7px;
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
  margin-bottom: 20px;
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

.driven-by {
  font-size: 11.5px;
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
  margin-top: 16px;
  width: 100%;
  padding: 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--bad);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
}
.unplace-btn:hover {
  background: var(--bad-soft);
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
.group-name-input {
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
.group-name-input:focus {
  border-color: var(--accent);
}
.group-name-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
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
