<!--
  Content.vue — the content LIBRARY (Phase 3c).

  A managed, reusable set of named sources you assign to screens / video walls instead of typing an
  ad-hoc URL each time. Mirrors docs/design/console.dc.html's CONTENT VIEW: a list of sources (glyph
  badge · name · "kind · url") with Add / Edit / Delete, plus a modal for creating & editing.

  A ContentSource is {id, name, kind, url} (the contract). The design's prototype also showed an
  "Authentication" picker, but the 3c contract carries no auth field, so this view manages name/kind/url
  only — auth lands in a later phase. All reads/writes go through the Pinia store.
-->
<script setup lang="ts">
import { ref, computed } from "vue";
import { CreateContentSourceBody } from "@polyptic/protocol";
import type { ContentKind, ContentSource } from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";
import { CONTENT_KINDS, kindGlyph, kindLabel, kindColorVar } from "../content";

const store = useConsoleStore();

const sources = computed(() => store.sources);

// ── modal state ──────────────────────────────────────────────────────────────
const modalOpen = ref(false);
const editingId = ref<string | null>(null); // null = creating
const draftName = ref("");
const draftKind = ref<ContentKind>("web");
const draftUrl = ref("");
const errorMsg = ref<string | null>(null);
const saving = ref(false);

const modalTitle = computed(() => (editingId.value ? "Edit source" : "Add content source"));
const saveLabel = computed(() => (editingId.value ? "Save changes" : "Add source"));

function openAdd() {
  editingId.value = null;
  draftName.value = "";
  draftKind.value = "web";
  draftUrl.value = "";
  errorMsg.value = null;
  modalOpen.value = true;
}

function openEdit(s: ContentSource) {
  editingId.value = s.id;
  draftName.value = s.name;
  draftKind.value = s.kind;
  draftUrl.value = s.url;
  errorMsg.value = null;
  modalOpen.value = true;
}

function closeModal() {
  modalOpen.value = false;
  saving.value = false;
}

async function save() {
  if (saving.value) return;
  errorMsg.value = null;
  const parsed = CreateContentSourceBody.safeParse({
    name: draftName.value.trim(),
    kind: draftKind.value,
    url: draftUrl.value.trim(),
  });
  if (!parsed.success) {
    errorMsg.value = parsed.error.issues[0]?.message ?? "Please check the fields.";
    return;
  }

  saving.value = true;
  const ok = editingId.value
    ? await store.updateSource(editingId.value, parsed.data)
    : await store.createSource(parsed.data);
  saving.value = false;
  if (ok) {
    modalOpen.value = false;
  } else {
    errorMsg.value = "Couldn't save. Check the address and try again.";
  }
}

async function remove(s: ContentSource) {
  const yes = window.confirm(
    `Delete "${s.name}"? Any screen or video wall currently showing it will be cleared.`,
  );
  if (yes) await store.deleteSource(s.id);
}

/** A compact, scheme-stripped address for the list row (matches the design's "address" read-out). */
function pretty(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

// ── upload modal (Phase 7) ─────────────────────────────────────────────────────
// An alternative to the "add by URL" path above: pick (or drop) an image/video file, it's uploaded
// to the server's disk volume and comes back as a ContentSource (kind image|video) via the same
// admin/state broadcast that feeds `sources`. We never set kind/url by hand here — the server derives
// them from the validated file and the serve route.
const uploadOpen = ref(false);
const uploadFile = ref<File | null>(null);
const uploadName = ref("");
const uploadError = ref<string | null>(null);
const uploading = ref(false);
const uploadProgress = ref(0); // 0..1
const dragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const MAX_BYTES = 200 * 1024 * 1024; // mirrors the server's MEDIA_MAX_BYTES default (~200MB)

function openUpload() {
  uploadFile.value = null;
  uploadName.value = "";
  uploadError.value = null;
  uploading.value = false;
  uploadProgress.value = 0;
  dragOver.value = false;
  uploadOpen.value = true;
}

function closeUpload() {
  if (uploading.value) return; // don't abandon an in-flight upload by closing
  uploadOpen.value = false;
}

/** Validate locally (type + size) before accepting a file — cheap feedback before any network hop. */
function acceptFile(file: File | null | undefined): void {
  if (!file) return;
  const isMedia = file.type.startsWith("image/") || file.type.startsWith("video/");
  if (!isMedia) {
    uploadError.value = "Unsupported file type — choose an image or video.";
    uploadFile.value = null;
    return;
  }
  if (file.size > MAX_BYTES) {
    uploadError.value = "File too large — the limit is 200 MB.";
    uploadFile.value = null;
    return;
  }
  uploadError.value = null;
  uploadFile.value = file;
  // Default the display name to the filename without its extension (the operator can override).
  if (!uploadName.value.trim()) uploadName.value = file.name.replace(/\.[^.]+$/, "");
}

function onPick(ev: Event) {
  const input = ev.target as HTMLInputElement;
  acceptFile(input.files?.[0]);
}

function onDrop(ev: DragEvent) {
  dragOver.value = false;
  acceptFile(ev.dataTransfer?.files?.[0]);
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

async function doUpload() {
  if (uploading.value || !uploadFile.value) return;
  uploadError.value = null;
  uploading.value = true;
  uploadProgress.value = 0;
  const res = await store.uploadSource(uploadFile.value, uploadName.value, (f) => {
    uploadProgress.value = f;
  });
  uploading.value = false;
  if (res.ok) {
    uploadOpen.value = false; // the new source appears in the library via admin/state
  } else {
    uploadError.value = res.error ?? "Upload failed. Please try again.";
  }
}

/** Whether a source's `url` resolves to a directly-renderable picture (for a list thumbnail). */
function isImage(s: ContentSource): boolean {
  return s.kind === "image";
}
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <!-- header -->
      <header class="head">
        <div class="head-text">
          <h1 class="title">Content sources</h1>
          <p class="subtitle">
            What your screens can display. Manage a source once here, then assign it to any screen or
            video wall.
          </p>
        </div>
        <div class="head-actions">
          <button class="add-btn ghost compact" @click="openUpload">⤓ Upload</button>
          <button class="add-btn" @click="openAdd">+ Add source</button>
        </div>
      </header>

      <!-- list -->
      <div v-if="sources.length" class="list">
        <div v-for="c in sources" :key="c.id" class="row">
          <img v-if="isImage(c)" class="thumb" :src="c.url" :alt="c.name" loading="lazy" />
          <span v-else class="glyph" :style="{ color: `var(${kindColorVar(c.kind)})` }">
            {{ kindGlyph(c.kind) }}
          </span>
          <div class="row-meta">
            <div class="row-name">{{ c.name }}</div>
            <div class="row-sub">{{ kindLabel(c.kind) }} · {{ pretty(c.url) }}</div>
          </div>
          <span class="kind-badge">{{ kindLabel(c.kind) }}</span>
          <button class="edit-btn" @click="openEdit(c)">Edit</button>
          <button class="del-btn" title="Delete source" @click="remove(c)">✕</button>
        </div>
      </div>

      <!-- empty -->
      <div v-else class="empty">
        <span class="empty-glyph">◇</span>
        <span class="empty-title">No content sources yet</span>
        <span class="empty-sub">
          Add a web page, dashboard, image or video, then assign it to screens on the Wall.
        </span>
        <div class="empty-actions">
          <button class="add-btn ghost" @click="openUpload">⤓ Upload a file</button>
          <button class="add-btn ghost" @click="openAdd">+ Add by URL</button>
        </div>
      </div>
    </div>

    <!-- ── add / edit modal ─────────────────────────────────────────────────── -->
    <div v-if="modalOpen" class="scrim" @mousedown.self="closeModal">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">{{ modalTitle }}</div>

        <label class="field-label">Name</label>
        <input
          v-model="draftName"
          class="field"
          placeholder="e.g. Lobby Dashboard"
          @keyup.enter="save"
        />

        <label class="field-label">Type</label>
        <div class="type-row">
          <button
            v-for="k in CONTENT_KINDS"
            :key="k"
            class="type-btn"
            :class="{ active: draftKind === k }"
            @click="draftKind = k"
          >
            <span class="type-glyph" :style="{ color: `var(${kindColorVar(k)})` }">{{ kindGlyph(k) }}</span>
            {{ kindLabel(k) }}
          </button>
        </div>

        <label class="field-label">Address</label>
        <input
          v-model="draftUrl"
          class="field mono"
          placeholder="https://…"
          @keyup.enter="save"
        />

        <div v-if="errorMsg" class="error">⚠ {{ errorMsg }}</div>

        <div class="modal-actions">
          <button class="btn-secondary" @click="closeModal">Cancel</button>
          <button class="btn-primary" :disabled="saving" @click="save">{{ saveLabel }}</button>
        </div>
      </div>
    </div>

    <!-- ── upload modal (Phase 7) ────────────────────────────────────────────── -->
    <div v-if="uploadOpen" class="scrim" @mousedown.self="closeUpload">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">Upload image or video</div>

        <!-- drop zone / picker -->
        <div
          class="drop"
          :class="{ over: dragOver, filled: !!uploadFile }"
          @click="fileInput?.click()"
          @dragover.prevent="dragOver = true"
          @dragleave.prevent="dragOver = false"
          @drop.prevent="onDrop"
        >
          <input
            ref="fileInput"
            type="file"
            accept="image/*,video/*"
            class="file-input"
            @change="onPick"
          />
          <template v-if="uploadFile">
            <span class="drop-glyph">{{ uploadFile.type.startsWith("video/") ? "▷" : "▦" }}</span>
            <span class="drop-name">{{ uploadFile.name }}</span>
            <span class="drop-sub">{{ fmtSize(uploadFile.size) }} · click to choose another</span>
          </template>
          <template v-else>
            <span class="drop-glyph">⤓</span>
            <span class="drop-name">Drop a file here, or click to browse</span>
            <span class="drop-sub">Images and videos · up to 200 MB</span>
          </template>
        </div>

        <label class="field-label">Name <span class="optional">(optional)</span></label>
        <input
          v-model="uploadName"
          class="field"
          placeholder="Defaults to the file name"
          :disabled="uploading"
        />

        <!-- progress -->
        <div v-if="uploading" class="progress-wrap">
          <div class="progress-bar" :style="{ width: `${Math.round(uploadProgress * 100)}%` }"></div>
          <span class="progress-label">Uploading… {{ Math.round(uploadProgress * 100) }}%</span>
        </div>

        <div v-if="uploadError" class="error">⚠ {{ uploadError }}</div>

        <div class="modal-actions">
          <button class="btn-secondary" :disabled="uploading" @click="closeUpload">Cancel</button>
          <button class="btn-primary" :disabled="uploading || !uploadFile" @click="doUpload">
            {{ uploading ? "Uploading…" : "Upload" }}
          </button>
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
.add-btn.ghost:hover {
  background: var(--muted-bg);
  opacity: 1;
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
.kind-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--fg2);
  background: var(--muted-bg);
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
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
  width: 440px;
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
.field.mono {
  font-variant-numeric: tabular-nums;
}
.field:focus {
  border-color: var(--accent);
}
.type-row {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
}
.type-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 6px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}
.type-btn:hover {
  background: var(--muted-bg);
}
.type-btn.active {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.type-glyph {
  font-size: 13px;
  font-weight: 700;
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

/* header actions */
.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.add-btn.compact {
  padding: 9px 13px;
}

/* image thumbnail in a list row (replaces the glyph badge for uploaded/linked images) */
.thumb {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  border-radius: 9px;
  object-fit: cover;
  background: var(--muted-bg);
  border: 1px solid var(--line);
}

/* empty-state action pair */
.empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

/* upload drop zone */
.drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  position: relative;
  border: 1.5px dashed var(--line2);
  border-radius: 12px;
  padding: 26px 18px;
  margin-bottom: 16px;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.drop:hover {
  background: var(--muted-bg);
}
.drop.over {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.drop.filled {
  border-style: solid;
  border-color: var(--line);
}
.file-input {
  display: none;
}
.drop-glyph {
  font-size: 22px;
  color: var(--accent);
  font-weight: 700;
}
.drop-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  word-break: break-all;
}
.drop-sub {
  font-size: 11.5px;
  color: var(--muted);
}
.optional {
  color: var(--muted2);
  font-weight: 400;
}
.field:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* upload progress */
.progress-wrap {
  position: relative;
  height: 22px;
  border-radius: 8px;
  background: var(--muted-bg);
  overflow: hidden;
  margin-bottom: 16px;
}
.progress-bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s ease;
}
.progress-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--fg);
}
</style>
