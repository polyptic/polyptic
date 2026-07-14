<!--
  Playlists.vue — the playlist library (POL-34), its own sidebar destination.

  A playlist is a carousel over CONTENT SOURCES (managed on the Content view): an ordered list of
  steps with per-step timing — statics show for the seconds you set, a video left blank plays to its
  end. Playlists assign to screens and video walls exactly like any other library source; this view
  owns authoring (the step-builder modal) and the list, keeping the Content view a flat list of
  addresses and files.
-->
<script setup lang="ts">
import { ref, computed } from "vue";
import { CreateContentSourceBody } from "@polyptic/protocol";
import type { ContentKind, ContentSource } from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";
import { useDialogStore } from "../stores/dialogs";
import { kindGlyph, kindColorVar } from "../content";

const store = useConsoleStore();
const dialogs = useDialogStore();

const playlists = computed(() => store.sources.filter((s) => s.kind === "playlist"));

/** What a playlist may contain: every library source except playlists themselves (no nesting). */
const stepSources = computed(() => store.sources.filter((s) => s.kind !== "playlist"));

/** The row's sub-line: step count plus the running order by name, e.g. "3 steps · A → B → C". */
function rowSub(p: ContentSource): string {
  const items = p.items ?? [];
  const count = `${items.length} step${items.length === 1 ? "" : "s"}`;
  if (items.length === 0) return count;
  const names = items.map((i) => store.sourceById(i.sourceId)?.name ?? "(removed)");
  return `${count} · ${names.join(" → ")}`;
}

// ── step-builder modal ────────────────────────────────────────────────────────
// Steps that are not videos need a hold time (defaulted to 15 s); a video left blank plays to the
// end before the playlist moves on. Durations are kept as TEXT so a video's blank survives editing.
const DEFAULT_ITEM_SECONDS = 15;
const modalOpen = ref(false);
const editingId = ref<string | null>(null); // null = creating
const draftName = ref("");
const draftItems = ref<{ sourceId: string; duration: string }[]>([]);
const errorMsg = ref<string | null>(null);
const saving = ref(false);

const modalTitle = computed(() => (editingId.value ? "Edit playlist" : "New playlist"));
const saveLabel = computed(() => (editingId.value ? "Save changes" : "Create playlist"));

function stepKind(sourceId: string): ContentKind | null {
  return sourceId ? (store.sourceById(sourceId)?.kind ?? null) : null;
}

function blankStep(): { sourceId: string; duration: string } {
  return { sourceId: "", duration: String(DEFAULT_ITEM_SECONDS) };
}

function openAdd() {
  editingId.value = null;
  draftName.value = "";
  draftItems.value = [blankStep()];
  errorMsg.value = null;
  modalOpen.value = true;
}

function openEdit(p: ContentSource) {
  editingId.value = p.id;
  draftName.value = p.name;
  draftItems.value = (p.items ?? []).map((i) => ({
    sourceId: i.sourceId,
    duration: i.durationSeconds !== undefined ? String(i.durationSeconds) : "",
  }));
  if (draftItems.value.length === 0) draftItems.value = [blankStep()]; // emptied by source deletions
  errorMsg.value = null;
  modalOpen.value = true;
}

function closeModal() {
  modalOpen.value = false;
  saving.value = false;
}

function addStep() {
  draftItems.value.push(blankStep());
}
function removeStep(i: number) {
  draftItems.value.splice(i, 1);
}
function moveStep(i: number, delta: -1 | 1) {
  const j = i + delta;
  const items = draftItems.value;
  if (j < 0 || j >= items.length) return;
  const a = items[i];
  const b = items[j];
  if (!a || !b) return;
  items[i] = b;
  items[j] = a;
}

/** A newly-picked video step defaults to "until it ends" (blank); anything else needs seconds. */
function onStepSourceChange(i: number) {
  const item = draftItems.value[i];
  if (!item) return;
  if (stepKind(item.sourceId) === "video") item.duration = "";
  else if (!item.duration.trim()) item.duration = String(DEFAULT_ITEM_SECONDS);
}

async function save() {
  if (saving.value) return;
  errorMsg.value = null;

  const items: { sourceId: string; durationSeconds?: number }[] = [];
  for (const [i, draft] of draftItems.value.entries()) {
    if (!draft.sourceId) {
      errorMsg.value = `Step ${i + 1}: pick a source.`;
      return;
    }
    const text = draft.duration.trim();
    if (!text) {
      if (stepKind(draft.sourceId) !== "video") {
        errorMsg.value = `Step ${i + 1}: set how long it shows, in seconds.`;
        return;
      }
      items.push({ sourceId: draft.sourceId });
      continue;
    }
    const seconds = Number(text);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
      errorMsg.value = `Step ${i + 1}: the duration must be 1–86400 whole seconds.`;
      return;
    }
    items.push({ sourceId: draft.sourceId, durationSeconds: seconds });
  }

  const name = draftName.value.trim();
  const parsed = CreateContentSourceBody.safeParse({ name, kind: "playlist", items });
  if (!parsed.success) {
    errorMsg.value = parsed.error.issues[0]?.message ?? "Please check the fields.";
    return;
  }

  saving.value = true;
  const ok = editingId.value
    ? await store.updateSource(editingId.value, { name, items })
    : await store.createSource(parsed.data);
  saving.value = false;
  if (ok) {
    modalOpen.value = false;
  } else {
    errorMsg.value = "Couldn't save the playlist. Check the steps and try again.";
  }
}

async function remove(p: ContentSource) {
  const yes = await dialogs.confirm({
    title: `Delete "${p.name}"?`,
    message:
      "Any screen or video wall currently showing it is cleared. Undo puts the playlist back in the " +
      "library, but not back on those screens.",
    confirmLabel: "Delete playlist",
    danger: true,
  });
  if (yes) await store.deleteSource(p.id);
}
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <!-- header -->
      <header class="head">
        <div class="head-text">
          <h1 class="title">Playlists</h1>
          <p class="subtitle">
            Carousels of content. Compose sources from your library into a rotation, then assign it
            to any screen or video wall — statics show for the time you set, videos can play to the
            end.
          </p>
        </div>
        <div class="head-actions">
          <button class="add-btn" @click="openAdd">+ New playlist</button>
        </div>
      </header>

      <!-- list -->
      <div v-if="playlists.length" class="list">
        <div v-for="p in playlists" :key="p.id" class="row">
          <span class="glyph" :style="{ color: `var(${kindColorVar('playlist')})` }">
            {{ kindGlyph("playlist") }}
          </span>
          <div class="row-meta">
            <div class="row-name">{{ p.name }}</div>
            <div class="row-sub">{{ rowSub(p) }}</div>
          </div>
          <button class="edit-btn" @click="openEdit(p)">Edit</button>
          <button class="del-btn" title="Delete playlist" @click="remove(p)">✕</button>
        </div>
      </div>

      <!-- empty -->
      <div v-else class="empty">
        <span class="empty-glyph">≣</span>
        <span class="empty-title">No playlists yet</span>
        <span class="empty-sub">
          Add web pages, dashboards, images or videos under
          <router-link class="empty-link" :to="{ name: 'content' }">Content</router-link>, then
          compose them into a rotation here.
        </span>
        <div class="empty-actions">
          <button class="add-btn ghost" :disabled="!stepSources.length" @click="openAdd">
            + New playlist
          </button>
        </div>
        <span v-if="!stepSources.length" class="empty-hint">
          You need at least one content source first.
        </span>
      </div>
    </div>

    <!-- ── step-builder modal ───────────────────────────────────────────────── -->
    <div v-if="modalOpen" class="scrim" @mousedown.self="closeModal">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">{{ modalTitle }}</div>

        <label class="field-label">Name</label>
        <input v-model="draftName" class="field" placeholder="e.g. Lobby rotation" />

        <label class="field-label">
          Steps <span class="optional">(played top to bottom, then repeats)</span>
        </label>
        <div class="steps">
          <div v-for="(item, i) in draftItems" :key="i" class="step-row">
            <span class="step-num">{{ i + 1 }}</span>
            <select
              v-model="item.sourceId"
              class="field select step-source"
              @change="onStepSourceChange(i)"
            >
              <option value="" disabled>Choose content…</option>
              <option v-for="s in stepSources" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
            <input
              v-model="item.duration"
              class="field step-duration"
              inputmode="numeric"
              :placeholder="stepKind(item.sourceId) === 'video' ? 'until it ends' : '15'"
            />
            <span class="step-unit">s</span>
            <button class="step-btn" :disabled="i === 0" title="Move up" @click="moveStep(i, -1)">
              ↑
            </button>
            <button
              class="step-btn"
              :disabled="i === draftItems.length - 1"
              title="Move down"
              @click="moveStep(i, 1)"
            >
              ↓
            </button>
            <button class="step-btn danger" title="Remove step" @click="removeStep(i)">✕</button>
          </div>
        </div>
        <button class="add-step" @click="addStep">+ Add step</button>
        <p class="field-hint steps-hint">
          Web pages, dashboards and images show for the seconds you set. Leave a video's time blank
          to let it play to the end before the playlist moves on.
        </p>

        <div v-if="errorMsg" class="error">⚠ {{ errorMsg }}</div>

        <div class="modal-actions">
          <button class="btn-secondary" @click="closeModal">Cancel</button>
          <button class="btn-primary" :disabled="saving" @click="save">{{ saveLabel }}</button>
        </div>
      </div>
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
.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.add-btn {
  padding: 9px 16px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
}
.add-btn:hover {
  opacity: 0.92;
}
.add-btn.ghost {
  background: transparent;
  border: 1px solid var(--line2);
  color: var(--fg2);
  margin-top: 4px;
}
.add-btn.ghost:hover:not(:disabled) {
  background: var(--muted-bg);
  opacity: 1;
}
.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* list */
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 13px;
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 13px 15px;
  background: var(--card);
  box-shadow: var(--shadow-sm);
}
.glyph {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: var(--muted-bg);
  font-size: 14px;
  font-weight: 700;
}
.row-meta {
  flex: 1;
  min-width: 0;
}
.row-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fg);
}
.row-sub {
  font-size: 11.5px;
  color: var(--muted2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.edit-btn {
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}
.edit-btn:hover {
  background: var(--muted-bg);
}
.del-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}
.del-btn:hover {
  background: var(--bad-soft);
  color: var(--bad);
}

/* empty */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  padding: 44px 20px;
  border: 1.5px dashed var(--line2);
  border-radius: 13px;
  text-align: center;
}
.empty-glyph {
  font-size: 26px;
  color: var(--muted2);
}
.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg2);
}
.empty-sub {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
  max-width: 46ch;
}
.empty-link {
  color: var(--accent-fg);
  text-decoration: none;
  font-weight: 500;
}
.empty-link:hover {
  text-decoration: underline;
}
.empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.empty-hint {
  font-size: 11.5px;
  color: var(--muted2);
}

/* modal */
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}
.modal {
  width: 540px;
  max-width: calc(100vw - 32px);
  max-height: 88vh;
  overflow-y: auto;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 15px;
  padding: 24px;
  box-shadow: var(--shadow-lg);
}
.modal-title {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin-bottom: 18px;
}
.field-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg2);
  margin-bottom: 6px;
}
.field {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 10px 12px;
  font-size: 13.5px;
  color: var(--fg);
  outline: none;
  margin-bottom: 16px;
  font-family: inherit;
}
.field:focus {
  border-color: var(--accent);
}
.field.select {
  appearance: auto;
  cursor: pointer;
}
.optional {
  color: var(--muted2);
  font-weight: 400;
}
.error {
  font-size: 12.5px;
  color: var(--bad);
  background: var(--bad-soft);
  border-radius: 8px;
  padding: 9px 11px;
  margin-bottom: 16px;
}
.modal-actions {
  display: flex;
  gap: 9px;
  justify-content: flex-end;
}
.btn-secondary {
  padding: 9px 16px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 13px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}
.btn-secondary:hover {
  background: var(--muted-bg);
}
.btn-primary {
  padding: 9px 18px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-primary:not(:disabled):hover {
  opacity: 0.92;
}
.field-hint {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.5;
}

/* step builder */
.steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}
.step-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.step-row .field {
  margin-bottom: 0;
}
.step-num {
  width: 18px;
  flex: 0 0 auto;
  text-align: right;
  font-size: 11.5px;
  color: var(--muted2);
  font-variant-numeric: tabular-nums;
}
.step-source {
  flex: 1;
  min-width: 0;
}
.step-duration {
  width: 92px;
  flex: 0 0 auto;
  text-align: right;
}
.step-unit {
  font-size: 11.5px;
  color: var(--muted2);
}
.step-btn {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--fg2);
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.step-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.step-btn:not(:disabled):hover {
  background: var(--muted-bg);
}
.step-btn.danger:not(:disabled):hover {
  background: var(--bad-soft);
  color: var(--bad);
}
.add-step {
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px dashed var(--line2);
  background: transparent;
  color: var(--fg2);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  margin-bottom: 12px;
}
.add-step:hover {
  background: var(--muted-bg);
}
.steps-hint {
  margin: 0 0 16px;
}
</style>
