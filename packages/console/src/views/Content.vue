<!--
  Content.vue — the content LIBRARY (Phase 3c) + ACCESS CREDENTIALS (POL-24).

  A managed, reusable set of named sources you assign to screens / video walls instead of typing an
  ad-hoc URL each time. Mirrors docs/design/console.dc.html's CONTENT VIEW: a list of sources (glyph
  badge · name · "kind · url") with Add / Edit / Delete, plus a modal for creating & editing.

  POL-24 lands the design's deferred "Authentication" picker: a web/dashboard source can reference a
  CREDENTIAL PROFILE (a centrally-held OAuth client the server exchanges for short-lived tokens and
  stamps into the URL at send time). Profiles are managed in the "Access credentials" section below
  the library — the secret is write-only; rows show live token health. All reads/writes go through
  the Pinia store.
-->
<script setup lang="ts">
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { CreateContentSourceBody, CreateCredentialProfileBody } from "@polyptic/protocol";
import type {
  ContentKind,
  ContentSource,
  CredentialProfileView,
  PlacementMode,
  UpdateCredentialProfileBody,
} from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";
import { CONTENT_KINDS, kindGlyph, kindLabel, kindColorVar } from "../content";

const store = useConsoleStore();
const router = useRouter();

// ── pages (POL-42) ────────────────────────────────────────────────────────────
// A page is composed in the Studio, not added by URL: "New page" opens a blank Studio; a page row's
// edit affordance reopens it. Deletion goes through the same source delete as everything else.
function newPage() {
  void router.push({ name: "studio" });
}

function openStudio(s: ContentSource) {
  void router.push({ name: "studio", params: { id: s.id } });
}

/** The list row's second line for a page: what it is, not an address it doesn't have. */
function pageSubtitle(s: ContentSource): string {
  const count = s.definition?.elements.length ?? 0;
  const aspect = s.definition?.aspect ?? "16:9";
  return `${count} element${count === 1 ? "" : "s"} · ${aspect} · composed in the Studio`;
}

// Playlists are library sources too, but they have their own sidebar view (POL-34) — the Content
// list stays a flat catalogue of addresses and files.
const sources = computed(() => store.sources.filter((s) => s.kind !== "playlist"));
const profiles = computed(() => store.profiles);

// ── modal state ──────────────────────────────────────────────────────────────
const modalOpen = ref(false);
const editingId = ref<string | null>(null); // null = creating
const draftName = ref("");
const draftKind = ref<ContentKind>("web");
const draftUrl = ref("");
const draftProfileId = ref(""); // "" = no authentication (POL-24)
const draftPlacement = ref<PlacementMode>("auto"); // POL-18 — display override (web/dashboard)
const errorMsg = ref<string | null>(null);
const saving = ref(false);

/** Auth applies to browser-loaded sources; images/videos are fetched directly by the player. */
const authPickable = computed(() => draftKind.value === "web" || draftKind.value === "dashboard");

const modalTitle = computed(() => (editingId.value ? "Edit source" : "Add content source"));
const saveLabel = computed(() => (editingId.value ? "Save changes" : "Add source"));

function openAdd() {
  editingId.value = null;
  draftName.value = "";
  draftKind.value = "web";
  draftUrl.value = "";
  draftProfileId.value = "";
  draftPlacement.value = "auto";
  errorMsg.value = null;
  modalOpen.value = true;
}

function openEdit(s: ContentSource) {
  editingId.value = s.id;
  draftName.value = s.name;
  draftKind.value = s.kind;
  draftUrl.value = s.url ?? "";
  draftProfileId.value = s.credentialProfileId ?? "";
  draftPlacement.value = s.placementMode ?? "auto";
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
    // Auth only rides on browser-loaded kinds; "" (None) and a non-authable kind both mean detach.
    credentialProfileId: authPickable.value && draftProfileId.value ? draftProfileId.value : null,
    // POL-18 — the display override, web/dashboard only. "auto" travels explicitly so an edit back
    // to auto actually clears a previously forced mode.
    ...(authPickable.value ? { placementMode: draftPlacement.value } : {}),
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
function pretty(url: string | undefined): string {
  return (url ?? "").replace(/^https?:\/\//, "");
}

/** The library row's sub-line: the kind plus the compact address. */
function rowSub(s: ContentSource): string {
  return `${kindLabel(s.kind)} · ${pretty(s.url ?? "")}`;
}

/** POL-18 — the row's framing/display read-out, or null when there is nothing worth saying. A
 *  source that frames fine in auto mode stays quiet — the badge is for the exceptions. */
function placementNote(s: ContentSource): string | null {
  if (s.kind !== "web" && s.kind !== "dashboard") return null;
  const mode = s.placementMode ?? "auto";
  if (mode === "window") return "windowed (forced)";
  if (mode === "iframe") return s.framing === "blocked" ? "framed (forced — blocks framing)" : null;
  if (s.framing === "blocked") return "blocks framing → windowed";
  return null;
}

/** The profile a source references, for the library row's auth read-out. */
function profileName(s: ContentSource): string | null {
  if (!s.credentialProfileId) return null;
  return store.profileById(s.credentialProfileId)?.name ?? null;
}

// ── credential profiles (POL-24) ──────────────────────────────────────────────
// The "Access credentials" section: centrally-held OAuth clients (client-credentials grant) the
// server exchanges for short-lived tokens. The secret is WRITE-ONLY: it is sent on create (and on
// edit only when the operator types a replacement) and never comes back — rows show token health.
const profileModalOpen = ref(false);
const editingProfileId = ref<string | null>(null); // null = creating
const pDraftName = ref("");
const pDraftEndpoint = ref("");
const pDraftClientId = ref("");
const pDraftSecret = ref(""); // on edit: "" = keep the stored secret
const pDraftScope = ref("");
const pDraftAudience = ref("");
const pDraftTokenParam = ref("auth_token");
const pErrorMsg = ref<string | null>(null);
const pSaving = ref(false);
/** Per-profile Test state: id → "running", or the last inline result line. */
const testState = ref<Record<string, string>>({});

const profileModalTitle = computed(() =>
  editingProfileId.value ? "Edit credential profile" : "Add credential profile",
);
const profileSaveLabel = computed(() => (editingProfileId.value ? "Save changes" : "Add profile"));

function openAddProfile() {
  editingProfileId.value = null;
  pDraftName.value = "";
  pDraftEndpoint.value = "";
  pDraftClientId.value = "";
  pDraftSecret.value = "";
  pDraftScope.value = "";
  pDraftAudience.value = "";
  pDraftTokenParam.value = "auth_token";
  pErrorMsg.value = null;
  profileModalOpen.value = true;
}

function openEditProfile(p: CredentialProfileView) {
  editingProfileId.value = p.id;
  pDraftName.value = p.name;
  pDraftEndpoint.value = p.tokenEndpoint;
  pDraftClientId.value = p.clientId;
  pDraftSecret.value = ""; // never echoed back; blank = unchanged
  pDraftScope.value = p.scope ?? "";
  pDraftAudience.value = p.audience ?? "";
  pDraftTokenParam.value = p.tokenParam;
  pErrorMsg.value = null;
  profileModalOpen.value = true;
}

function closeProfileModal() {
  profileModalOpen.value = false;
  pSaving.value = false;
}

async function saveProfile() {
  if (pSaving.value) return;
  pErrorMsg.value = null;

  const common = {
    name: pDraftName.value.trim(),
    tokenEndpoint: pDraftEndpoint.value.trim(),
    clientId: pDraftClientId.value.trim(),
    ...(pDraftScope.value.trim() ? { scope: pDraftScope.value.trim() } : {}),
    ...(pDraftAudience.value.trim() ? { audience: pDraftAudience.value.trim() } : {}),
    tokenParam: pDraftTokenParam.value.trim() || "auth_token",
  };

  let ok: boolean;
  if (editingProfileId.value) {
    const patch: UpdateCredentialProfileBody = {
      ...common,
      // Blank secret = keep the stored one; scope/audience blank = clear (null on the wire).
      ...(pDraftSecret.value ? { clientSecret: pDraftSecret.value } : {}),
      scope: pDraftScope.value.trim() || null,
      audience: pDraftAudience.value.trim() || null,
    };
    pSaving.value = true;
    ok = await store.updateProfile(editingProfileId.value, patch);
  } else {
    const parsed = CreateCredentialProfileBody.safeParse({
      ...common,
      clientSecret: pDraftSecret.value,
    });
    if (!parsed.success) {
      pErrorMsg.value = parsed.error.issues[0]?.message ?? "Please check the fields.";
      return;
    }
    pSaving.value = true;
    ok = await store.createProfile(parsed.data);
  }
  pSaving.value = false;
  if (ok) {
    profileModalOpen.value = false;
  } else {
    pErrorMsg.value = "Couldn't save. Check the endpoint and try again.";
  }
}

async function removeProfile(p: CredentialProfileView) {
  if (p.inUseBy > 0) {
    window.alert(
      `"${p.name}" authenticates ${p.inUseBy} content source${p.inUseBy === 1 ? "" : "s"}. ` +
        `Reassign or remove their authentication first.`,
    );
    return;
  }
  const yes = window.confirm(`Delete credential profile "${p.name}"?`);
  if (!yes) return;
  const result = await store.deleteProfile(p.id);
  if (result === "in-use") {
    window.alert(`"${p.name}" is in use by one or more content sources — reassign them first.`);
  }
}

/** Run a live token exchange for a profile and surface the IdP's answer inline on its row. */
async function runTest(p: CredentialProfileView) {
  testState.value = { ...testState.value, [p.id]: "running" };
  const result = await store.testProfile(p.id);
  const line = result.ok
    ? `✓ Token issued (expires in ${result.expiresIn ?? "?"}s)`
    : `✕ ${result.error ?? "Failed"}`;
  testState.value = { ...testState.value, [p.id]: line };
}

/** The host of a profile's token endpoint, for the compact row read-out. */
function endpointHost(p: CredentialProfileView): string {
  try {
    return new URL(p.tokenEndpoint).host;
  } catch {
    return p.tokenEndpoint;
  }
}

function statusLabel(p: CredentialProfileView): string {
  if (p.tokenStatus === "ok") return "token ok";
  if (p.tokenStatus === "pending") return "pending";
  return "auth failing";
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
  return s.kind === "image" && !!s.url;
}

/** The thumbnail address for an image row (guarded by `isImage`; typed for the template). */
function thumbSrc(s: ContentSource): string {
  return s.url ?? "";
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
          <button
            class="add-btn ghost compact"
            title="Compose elements into a page in the Studio"
            @click="newPage"
          >
            ▦ New page
          </button>
          <button class="add-btn" @click="openAdd">+ Add source</button>
        </div>
      </header>

      <!-- list -->
      <div v-if="sources.length" class="list">
        <div v-for="c in sources" :key="c.id" class="row">
          <img v-if="isImage(c)" class="thumb" :src="thumbSrc(c)" :alt="c.name" loading="lazy" />
          <span v-else class="glyph" :style="{ color: `var(${kindColorVar(c.kind)})` }">
            {{ kindGlyph(c.kind) }}
          </span>
          <div class="row-meta">
            <div class="row-name">
              {{ c.name }}
              <span v-if="c.kind === 'page'" class="page-badge">PAGE</span>
            </div>
            <div class="row-sub">
              <template v-if="c.kind === 'page'">{{ pageSubtitle(c) }}</template>
              <template v-else>
                {{ rowSub(c) }}
                <template v-if="profileName(c)"> · 🔒 {{ profileName(c) }}</template>
                <template v-if="placementNote(c)"> · ▣ {{ placementNote(c) }}</template>
              </template>
            </div>
          </div>
          <span class="kind-badge">{{ kindLabel(c.kind) }}</span>
          <button v-if="c.kind === 'page'" class="edit-btn" @click="openStudio(c)">Edit in Studio</button>
          <button v-else class="edit-btn" @click="openEdit(c)">Edit</button>
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

      <!-- ── access credentials (POL-24) ─────────────────────────────────────── -->
      <header class="head section-head">
        <div class="head-text">
          <h1 class="title">Access credentials</h1>
          <p class="subtitle">
            Sign screens into protected content. A profile is an OAuth client at your identity
            provider — the server keeps a short-lived token fresh and every source that uses the
            profile loads already authenticated.
          </p>
        </div>
        <div class="head-actions">
          <button class="add-btn ghost compact" @click="openAddProfile">+ Add profile</button>
        </div>
      </header>

      <div v-if="profiles.length" class="list">
        <div v-for="p in profiles" :key="p.id" class="row">
          <span class="glyph" :style="{ color: 'var(--accent)' }">🔒</span>
          <div class="row-meta">
            <div class="row-name">{{ p.name }}</div>
            <div class="row-sub">
              {{ endpointHost(p) }} · client {{ p.clientId }} ·
              {{ p.inUseBy }} source{{ p.inUseBy === 1 ? "" : "s" }}
              <template v-if="testState[p.id] && testState[p.id] !== 'running'">
                · {{ testState[p.id] }}
              </template>
            </div>
            <div v-if="p.tokenStatus === 'error' && p.lastError" class="row-err">
              {{ p.lastError }}
            </div>
          </div>
          <span class="status-pill" :class="p.tokenStatus">
            {{ p.tokenStatus === "ok" ? "●" : p.tokenStatus === "pending" ? "○" : "⚠" }}
            {{ statusLabel(p) }}
          </span>
          <button class="edit-btn" :disabled="testState[p.id] === 'running'" @click="runTest(p)">
            {{ testState[p.id] === "running" ? "Testing…" : "Test" }}
          </button>
          <button class="edit-btn" @click="openEditProfile(p)">Edit</button>
          <button class="del-btn" title="Delete profile" @click="removeProfile(p)">✕</button>
        </div>
      </div>

      <div v-else class="empty">
        <span class="empty-glyph">🔒</span>
        <span class="empty-title">No credential profiles yet</span>
        <span class="empty-sub">
          Showing dashboards that need a sign-in? Register a client at your identity provider, add
          its details here once, and any number of screens share the session.
        </span>
        <div class="empty-actions">
          <button class="add-btn ghost" @click="openAddProfile">+ Add credential profile</button>
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

        <!-- POL-24 — the design's deferred "Authentication" picker. Web/dashboard only: images and
             videos are fetched directly by the player, not loaded as an authenticated page. -->
        <template v-if="authPickable">
          <label class="field-label">Authentication</label>
          <select v-model="draftProfileId" class="field select">
            <option value="">None — public or anonymous access</option>
            <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <p v-if="!profiles.length" class="field-hint">
            Protected content? Add a credential profile under Access credentials below, then pick it
            here.
          </p>

          <!-- POL-18 — the display override. Auto probes the address's framing headers and falls
               back to an agent-placed window when the site refuses to be framed; the forced modes
               exist because header detection can never be perfect. -->
          <label class="field-label">Display</label>
          <select v-model="draftPlacement" class="field select">
            <option value="auto">Auto — windowed only if the site blocks framing</option>
            <option value="iframe">Always framed (embed in the player)</option>
            <option value="window">Always windowed (placed by the box)</option>
          </select>
        </template>

        <div v-if="errorMsg" class="error">⚠ {{ errorMsg }}</div>

        <div class="modal-actions">
          <button class="btn-secondary" @click="closeModal">Cancel</button>
          <button class="btn-primary" :disabled="saving" @click="save">{{ saveLabel }}</button>
        </div>
      </div>
    </div>

    <!-- ── credential profile modal (POL-24) ────────────────────────────────── -->
    <div v-if="profileModalOpen" class="scrim" @mousedown.self="closeProfileModal">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title">{{ profileModalTitle }}</div>

        <label class="field-label">Name</label>
        <input
          v-model="pDraftName"
          class="field"
          placeholder="e.g. Grafana — works IdP"
          @keyup.enter="saveProfile"
        />

        <label class="field-label">Token endpoint</label>
        <input
          v-model="pDraftEndpoint"
          class="field mono"
          placeholder="https://idp.example.com/realms/…/protocol/openid-connect/token"
          @keyup.enter="saveProfile"
        />

        <label class="field-label">Client ID</label>
        <input v-model="pDraftClientId" class="field mono" placeholder="polyptic-kiosk" />

        <label class="field-label">
          Client secret
          <span v-if="editingProfileId" class="optional">(leave blank to keep the current one)</span>
        </label>
        <input
          v-model="pDraftSecret"
          type="password"
          class="field mono"
          autocomplete="new-password"
          :placeholder="editingProfileId ? '••••••••  (unchanged)' : ''"
        />

        <label class="field-label">Scope <span class="optional">(optional — Entra needs api://…/.default)</span></label>
        <input v-model="pDraftScope" class="field mono" placeholder="" />

        <label class="field-label">Audience <span class="optional">(optional — for IdPs that take one)</span></label>
        <input v-model="pDraftAudience" class="field mono" placeholder="" />

        <label class="field-label">Token URL parameter</label>
        <input v-model="pDraftTokenParam" class="field mono" placeholder="auth_token" />
        <p class="field-hint">
          The query parameter the token is delivered in when a screen loads the content — Grafana's
          JWT sign-in reads <code>auth_token</code>.
        </p>

        <div v-if="pErrorMsg" class="error">⚠ {{ pErrorMsg }}</div>

        <div class="modal-actions">
          <button class="btn-secondary" @click="closeProfileModal">Cancel</button>
          <button class="btn-primary" :disabled="pSaving" @click="saveProfile">
            {{ profileSaveLabel }}
          </button>
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
  display: flex;
  align-items: center;
  gap: 8px;
}

/* POL-42 — the page chip beside a composed source's name. */
.page-badge {
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  padding: 2px 7px;
  border-radius: 20px;
  color: var(--accent-fg);
  background: var(--accent-soft);
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

/* access credentials (POL-24) */
.section-head {
  margin-top: 40px;
  padding-top: 28px;
  border-top: 1px solid var(--line2);
}
.status-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
}
.status-pill.ok {
  color: var(--ok, #1d8a4e);
  background: var(--ok-soft, var(--muted-bg));
}
.status-pill.pending {
  color: var(--muted);
  background: var(--muted-bg);
}
.status-pill.error {
  color: var(--bad);
  background: var(--bad-soft);
}
.row-err {
  font-size: 11px;
  color: var(--bad);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
.field.select {
  appearance: auto;
  cursor: pointer;
}
.field-hint {
  font-size: 11.5px;
  color: var(--muted);
  line-height: 1.5;
  margin: -10px 0 16px;
}
.field-hint code {
  font-size: 11px;
  background: var(--muted-bg);
  padding: 1px 4px;
  border-radius: 4px;
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
