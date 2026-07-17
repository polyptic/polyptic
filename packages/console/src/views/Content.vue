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
import { ref, computed, watch } from "vue";
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
import {
  defaultRefreshDraft,
  draftFromPolicy,
  policyFromDraft,
  type RefreshDraft,
} from "../refresh-draft";

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

// ── search / filter / sort (POL-94) ───────────────────────────────────────────
// The library grew into a pile: a flat, unsorted list with no way to find anything. All three are
// CLIENT-side — a library is tens of rows, not thousands, and a round trip to filter a list you are
// already holding is a worse experience than typing into it.

const query = ref("");
const kindFilter = ref<ContentKind | "all">("all");
const sortBy = ref<"name" | "kind" | "usage">("name");

/** The kinds actually present in the library — never offer a filter that can only return nothing. */
const availableKinds = computed<ContentKind[]>(() =>
  CONTENT_KINDS.filter((k) => sources.value.some((s) => s.kind === k)),
);

/** Total references (screens + walls + playlists + pages) — the "recently/most used" sort key. */
function usageCount(s: ContentSource): number {
  const u = store.statusForSource(s.id)?.usage;
  if (!u) return 0;
  return u.screenIds.length + u.wallIds.length + u.playlistIds.length + u.pageIds.length;
}

/** Name + address + kind, matched case-insensitively on every whitespace-separated term. */
function matches(s: ContentSource, terms: string[]): boolean {
  const hay = `${s.name} ${s.url ?? ""} ${kindLabel(s.kind)}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

const visibleSources = computed(() => {
  const terms = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = sources.value.filter(
    (s) => (kindFilter.value === "all" || s.kind === kindFilter.value) && matches(s, terms),
  );
  const sorted = [...filtered];
  if (sortBy.value === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sortBy.value === "kind") {
    sorted.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  } else {
    // Most-used first — the sources an operator actually lives with float to the top.
    sorted.sort((a, b) => usageCount(b) - usageCount(a) || a.name.localeCompare(b.name));
  }
  return sorted;
});

// ── usage + health (POL-94) ───────────────────────────────────────────────────

/** "Used on 2 screens · 1 video wall" — or "Not used yet", which is itself the useful answer. */
function usageLine(s: ContentSource): string {
  return store.usageSummary(s.id) || "Not used yet";
}

/** The screens (by friendly name) currently reporting this source as unreachable. */
function brokenOn(s: ContentSource): string[] {
  const ids = store.statusForSource(s.id)?.unreachableScreenIds ?? [];
  return ids.map((id) => store.screenById(id)?.friendlyName ?? id);
}

function healthLabel(s: ContentSource): string {
  const health = store.healthForSource(s.id);
  if (health === "reachable") return "loading";
  if (health === "unreachable") return "not loading";
  return "not checked";
}

/**
 * What the badge means, spelled out — because a health badge that overclaims is worse than none.
 * The player PROVES a URL fetchable before it paints it (POL-86); that is all this knows. It cannot
 * see inside a cross-origin frame (same-origin policy), so a 500, an expired session's login page
 * and an empty dashboard all read as "loading". Say so, in the tooltip, every time.
 */
function healthTitle(s: ContentSource): string {
  const status = store.statusForSource(s.id);
  const health = status?.health ?? "unknown";
  const seen = status?.lastSeenAt ? ` Last reported ${timeAgo(status.lastSeenAt)}.` : "";
  if (health === "reachable") {
    return (
      `The screens showing this fetched it successfully — it is loading on the glass.${seen} ` +
      `This does not mean the page rendered what you want: a browser cannot see inside someone ` +
      `else's page, so an error page or a signed-out dashboard also counts as "loading".`
    );
  }
  if (health === "unreachable") {
    const where = brokenOn(s);
    const detail = status?.detail ? ` (${status.detail})` : "";
    return (
      `A screen showing this could not fetch it at all${detail} — ` +
      `${where.length ? where.join(", ") : "the screen"} is showing a placeholder and retrying.${seen}`
    );
  }
  return (
    "Nobody is showing this right now, so nothing has checked it. Polyptic never probes a source " +
    "no screen is displaying — a library of 200 links would become 200 requests an hour."
  );
}

/** "2 min ago" / "3 h ago" — the badge's "when was this last seen" half, in the operator's terms. */
function timeAgo(at: string): string {
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

// ── modal state ──────────────────────────────────────────────────────────────
const modalOpen = ref(false);
const editingId = ref<string | null>(null); // null = creating
const draftName = ref("");
const draftKind = ref<ContentKind>("web");
const draftUrl = ref("");
const draftProfileId = ref(""); // "" = no authentication (POL-24)
const draftPlacement = ref<PlacementMode>("auto"); // POL-18 — display override (web/dashboard)
// POL-157 — the reload cadence draft (web/dashboard only). The pure model lives in refresh-draft.ts.
const deploymentTz = computed(() => store.scheduler?.timezone ?? "UTC");
const draftRefresh = ref<RefreshDraft>(defaultRefreshDraft(deploymentTz.value));
const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];
function toggleRefreshDay(day: number): void {
  const days = draftRefresh.value.days;
  draftRefresh.value.days = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
}
const errorMsg = ref<string | null>(null);
const saving = ref(false);

/** Auth applies to browser-loaded sources; images/videos are fetched directly by the player. */
const authPickable = computed(() => draftKind.value === "web" || draftKind.value === "dashboard");

/** POL-114 — a deck has no address and no kind to change: it IS a converted document. The edit modal
 *  therefore offers exactly one thing, its name. */
const editingDeck = computed(() => editingId.value !== null && draftKind.value === "deck");

/** POL-108 — a live stream is addressed by its HLS playlist. The placeholder says so, and the hint
 *  below the field names the RTSP seam explicitly (a restreamer sits OUTSIDE Polyptic, by design)
 *  without naming any product: the operator picks their own. */
const urlPlaceholder = computed(() =>
  draftKind.value === "stream" ? "https://…/stream.m3u8" : "https://…",
);
const isStream = computed(() => draftKind.value === "stream");

const modalTitle = computed(() =>
  editingDeck.value ? "Rename deck" : editingId.value ? "Edit source" : "Add content source",
);
const saveLabel = computed(() => (editingId.value ? "Save changes" : "Add source"));

function openAdd() {
  editingId.value = null;
  draftName.value = "";
  draftKind.value = "web";
  draftUrl.value = "";
  draftProfileId.value = "";
  draftPlacement.value = "auto";
  draftRefresh.value = defaultRefreshDraft(deploymentTz.value);
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
  draftRefresh.value = draftFromPolicy(s.refresh, deploymentTz.value);
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

  // A deck: rename only (its url + pages are the conversion's, not the operator's).
  if (editingDeck.value && editingId.value) {
    const name = draftName.value.trim();
    if (name.length === 0) {
      errorMsg.value = "Please give the deck a name.";
      return;
    }
    saving.value = true;
    const renamed = await store.updateSource(editingId.value, { name });
    saving.value = false;
    if (renamed) modalOpen.value = false;
    else errorMsg.value = "Couldn't save. Please try again.";
    return;
  }

  // POL-157 — the reload cadence, web/dashboard only. A malformed draft (bad amount / no weekday)
  // stops the save with a plain message rather than shipping an invalid body.
  let refresh: ReturnType<typeof policyFromDraft> | undefined;
  if (authPickable.value) {
    refresh = policyFromDraft(draftRefresh.value);
    if (refresh === null) {
      errorMsg.value =
        draftRefresh.value.mode === "interval"
          ? "Set how often to reload — a whole number of minutes, hours, or days."
          : "Pick at least one day and a valid time to reload.";
      return;
    }
  }

  const parsed = CreateContentSourceBody.safeParse({
    name: draftName.value.trim(),
    kind: draftKind.value,
    url: draftUrl.value.trim(),
    // Auth only rides on browser-loaded kinds; "" (None) and a non-authable kind both mean detach.
    credentialProfileId: authPickable.value && draftProfileId.value ? draftProfileId.value : null,
    // POL-18 — the display override, web/dashboard only. "auto" travels explicitly so an edit back
    // to auto actually clears a previously forced mode.
    ...(authPickable.value ? { placementMode: draftPlacement.value } : {}),
    // POL-157 — the reload cadence rides the same web/dashboard-only path; off travels explicitly so
    // an edit that turns it off actually clears a stored cadence.
    ...(refresh ? { refresh } : {}),
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

/**
 * POL-94 — what deleting this source will actually break, named. The old copy said "any screen or
 * video wall currently showing it will be cleared", which is true and useless: it never told you
 * WHICH, and it never mentioned the playlist step or the page embed that would silently vanish.
 * Plain text on purpose, so a dialog component can adopt it verbatim.
 */
function deleteConsequences(s: ContentSource): string {
  const usage = store.statusForSource(s.id)?.usage;
  if (!usage) return `Delete "${s.name}"?`;
  const clauses: string[] = [];
  const named = (ids: string[], resolve: (id: string) => string): string =>
    ids.map(resolve).join(", ");
  if (usage.screenIds.length) {
    clauses.push(
      `clear ${usage.screenIds.length === 1 ? "1 screen" : `${usage.screenIds.length} screens`} ` +
        `(${named(usage.screenIds, (id) => store.screenById(id)?.friendlyName ?? id)})`,
    );
  }
  if (usage.wallIds.length) {
    clauses.push(
      `clear ${usage.wallIds.length === 1 ? "1 video wall" : `${usage.wallIds.length} video walls`} ` +
        `(${named(usage.wallIds, (id) => store.wallName(id))})`,
    );
  }
  if (usage.playlistIds.length) {
    clauses.push(
      `remove a step from ${usage.playlistIds.length === 1 ? "1 playlist" : `${usage.playlistIds.length} playlists`} ` +
        `(${named(usage.playlistIds, (id) => store.sourceById(id)?.name ?? id)})`,
    );
  }
  if (usage.pageIds.length) {
    clauses.push(
      `blank an element on ${usage.pageIds.length === 1 ? "1 page" : `${usage.pageIds.length} pages`} ` +
        `(${named(usage.pageIds, (id) => store.sourceById(id)?.name ?? id)})`,
    );
  }
  if (clauses.length === 0) return `Delete "${s.name}"? It isn't used anywhere.`;
  return `Delete "${s.name}"? This will ${clauses.join(", and ")}.`;
}

async function remove(s: ContentSource) {
  if (window.confirm(deleteConsequences(s))) await store.deleteSource(s.id);
}

/** A compact, scheme-stripped address for the list row (matches the design's "address" read-out). */
function pretty(url: string | undefined): string {
  return (url ?? "").replace(/^https?:\/\//, "");
}

/** The library row's sub-line: the kind, the probed facts (POL-109), then the compact address. */
function rowSub(s: ContentSource): string {
  const facts = mediaFacts(s);
  return facts
    ? `${kindLabel(s.kind)} · ${facts} · ${pretty(s.url ?? "")}`
    : `${kindLabel(s.kind)} · ${pretty(s.url ?? "")}`;
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

/** POL-114 — the document mimes the deck pipeline converts. Kept in step with the server's own table
 *  (`document-convert.ts`); the server is the authority and refuses anything else by name. */
const DOCUMENT_MIMES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.oasis.opendocument.text",
];

/** Whether THIS server can convert documents at all (it advertises it — see D132). With no converter
 *  the picker doesn't offer documents, because the server would (rightly) refuse the upload. */
const canConvertDocuments = computed(() => store.capabilities.documents);

/** What the file picker accepts — documents only when the server said it can convert them. */
const acceptTypes = computed(() =>
  canConvertDocuments.value
    ? `image/*,video/*,${DOCUMENT_MIMES.join(",")}`
    : "image/*,video/*",
);

function isDocument(file: File): boolean {
  return DOCUMENT_MIMES.includes(file.type) || /\.(pdf|pptx?|odp|docx?|odt)$/i.test(file.name);
}

/** Validate locally (type + size) before accepting a file — cheap feedback before any network hop. */
function acceptFile(file: File | null | undefined): void {
  if (!file) return;
  const isMedia = file.type.startsWith("image/") || file.type.startsWith("video/");
  const isDoc = isDocument(file);
  if (isDoc && !canConvertDocuments.value) {
    uploadError.value =
      "This server can't convert documents — no document toolchain is installed. Export your slides " +
      "to PDF or images on a server that can, or upload images instead.";
    uploadFile.value = null;
    return;
  }
  if (!isMedia && !isDoc) {
    uploadError.value = canConvertDocuments.value
      ? "Unsupported file type — choose an image, a video, a PDF or a slide deck."
      : "Unsupported file type — choose an image or video.";
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

// ── document conversion (POL-114) ────────────────────────────────────────────
// A document is not a request/response: the server answers 202 with a JOB and converts it off the
// request, pushing progress on the admin/state broadcast the store already folds in. So the modal
// stays open on the job — pages land one by one — and closes itself when the deck is ready. A failed
// conversion shows the server's sentence in the same place a rejected media upload's does.
const jobId = ref<string | null>(null);
const job = computed(() => (jobId.value ? store.documentJob(jobId.value) : undefined));

const converting = computed(
  () => job.value?.status === "converting" || job.value?.status === "rendering",
);

/** The line under the progress bar while a document converts — real page counts, never a lie. */
const jobLine = computed(() => {
  const j = job.value;
  if (!j) return "";
  if (j.status === "converting") return "Converting the document…";
  if (j.status === "rendering") {
    return j.pageCount
      ? `Rendering pages… ${j.pagesDone} of ${j.pageCount}`
      : `Rendering pages… ${j.pagesDone} so far`;
  }
  if (j.status === "ready") return `Converted — ${j.pageCount ?? j.pagesDone} pages`;
  return "";
});

/** The bar's fill while converting. The rasterizer does not know the page total until it is done, so
 *  an unknown total shows a full-width, muted "working" bar and lets the LABEL carry the real count —
 *  a fake percentage is worse than an honest one. */
const convertFraction = computed(() => {
  const j = job.value;
  if (!j) return 0;
  if (j.pageCount && j.pageCount > 0) return Math.min(1, j.pagesDone / j.pageCount);
  return 1;
});

watch(job, (j) => {
  if (!j) return;
  if (j.status === "ready") {
    jobId.value = null;
    uploading.value = false;
    uploadOpen.value = false; // the deck is in the library now (via admin/state)
  } else if (j.status === "failed") {
    jobId.value = null;
    uploading.value = false;
    uploadError.value = j.error ?? "Converting this document failed.";
  }
});

async function doUpload() {
  if (uploading.value || !uploadFile.value) return;
  uploadError.value = null;
  uploading.value = true;
  uploadProgress.value = 0;
  jobId.value = null;
  const res = await store.uploadSource(uploadFile.value, uploadName.value, (f) => {
    uploadProgress.value = f;
  });
  if (res.ok && res.jobId) {
    // POL-114 — a document: the bytes are up, the conversion has begun. Stay open on the job.
    jobId.value = res.jobId;
    return;
  }
  uploading.value = false;
  if (res.ok) {
    // POL-109 — an accepted-with-a-caveat upload (nothing could be checked) says so ONCE, above the
    // library; a REJECTED one never gets here — its message is the server's, shown in the modal.
    notice.value = res.warning ?? null;
    uploadOpen.value = false; // the new source appears in the library via admin/state
  } else {
    uploadError.value = res.error ?? "Upload failed. Please try again.";
  }
}

/** A deck's library sub-line: what it is, how many pages, and how long each holds the screen. */
function deckSubtitle(s: ContentSource): string {
  const d = s.deck;
  if (!d) return "Deck · converting…";
  const fmt = d.format ? d.format.toUpperCase() : "Document";
  const pages = `${d.pageCount} page${d.pageCount === 1 ? "" : "s"}`;
  return `${fmt} · ${pages} · ${d.dwellSeconds}s per page`;
}

/** Change a deck's per-page dwell. The server re-times the rotation and re-pushes every wall showing
 *  it — the same instant path as any other content edit. */
async function setDwell(s: ContentSource, seconds: number): Promise<void> {
  const dwellSeconds = Math.max(1, Math.min(3600, Math.round(seconds)));
  if (!Number.isFinite(dwellSeconds) || dwellSeconds === s.deck?.dwellSeconds) return;
  await store.updateSource(s.id, { dwellSeconds });
}

// ── ingest read-outs (POL-109) ────────────────────────────────────────────────
// The library now shows what the server PROBED at upload: a real thumbnail/poster for every image and
// video, and the facts (duration · dimensions · codec) on the row. A source with no `media` was never
// probed (a linked URL, or a server with no toolchain) — it falls back to the kind glyph, as before.
const notice = ref<string | null>(null);

/** The picture for a row: the ingest poster/thumbnail, or (for a linked image) the image itself. */
function thumbSrc(s: ContentSource): string | null {
  // POL-114 — a deck's tile is its first slide (the poster route serves page 1).
  if (s.kind === "deck") return s.deck?.posterUrl ?? null;
  const poster = s.media?.posterUrl;
  if (poster) return poster;
  return s.kind === "image" && s.url ? s.url : null;
}

/** mm:ss for a probed duration (a 90-minute video reads 90:00, not 1:30:00 — wall content is short). */
function fmtDuration(seconds: number): string {
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/** The probed facts for a row's sub-line — only what we actually know. */
function mediaFacts(s: ContentSource): string {
  const m = s.media;
  if (!m) return "";
  const bits: string[] = [];
  if (m.durationSeconds !== undefined) bits.push(fmtDuration(m.durationSeconds));
  if (m.width && m.height) bits.push(`${m.width}×${m.height}`);
  if (m.videoCodec) bits.push(m.videoCodec.toUpperCase());
  return bits.join(" · ");
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
        <!-- POL-107: authoring the library is an OPERATOR verb. A viewer reads it and sees no
             Upload / New page / Add / Edit / Delete — and every one of those routes 403s for it. -->
        <div v-if="store.canAuthor" class="head-actions">
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

      <!-- POL-109 — an accepted-but-unchecked upload says so once, here. -->
      <div v-if="notice" class="notice">
        <span>⚠ {{ notice }}</span>
        <button class="notice-x" title="Dismiss" @click="notice = null">✕</button>
      </div>

      <!-- ── search · filter · sort (POL-94) ────────────────────────────────── -->
      <div v-if="sources.length" class="toolbar">
        <div class="search-wrap">
          <span class="search-glyph">⌕</span>
          <input
            v-model="query"
            class="search"
            type="search"
            placeholder="Search by name or address…"
            aria-label="Search content sources"
          />
        </div>
        <div class="filter-row">
          <button
            class="filter-btn"
            :class="{ active: kindFilter === 'all' }"
            @click="kindFilter = 'all'"
          >
            All
          </button>
          <button
            v-for="k in availableKinds"
            :key="k"
            class="filter-btn"
            :class="{ active: kindFilter === k }"
            @click="kindFilter = k"
          >
            <span :style="{ color: `var(${kindColorVar(k)})` }">{{ kindGlyph(k) }}</span>
            {{ kindLabel(k) }}
          </button>
        </div>
        <select v-model="sortBy" class="sort" aria-label="Sort content sources">
          <option value="name">Sort: name</option>
          <option value="kind">Sort: type</option>
          <option value="usage">Sort: most used</option>
        </select>
      </div>

      <!-- list -->
      <div v-if="visibleSources.length" class="list">
        <div v-for="c in visibleSources" :key="c.id" class="row">
          <img
            v-if="thumbSrc(c)"
            class="thumb"
            :class="{ 'is-video': c.kind === 'video' }"
            :src="thumbSrc(c) ?? ''"
            :alt="c.name"
            loading="lazy"
          />
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
              <template v-else-if="c.kind === 'deck'">{{ deckSubtitle(c) }}</template>
              <template v-else>
                {{ rowSub(c) }}
                <template v-if="profileName(c)"> · 🔒 {{ profileName(c) }}</template>
                <template v-if="placementNote(c)"> · ▣ {{ placementNote(c) }}</template>
              </template>
            </div>
            <!-- POL-94 — where this source is used: an inventory, not a pile. -->
            <div class="row-usage">{{ usageLine(c) }}</div>
          </div>
          <!-- POL-94 — the live health badge. What it can and cannot know is in its tooltip. -->
          <span
            class="health-pill"
            :class="store.healthForSource(c.id)"
            :title="healthTitle(c)"
          >
            {{
              store.healthForSource(c.id) === "reachable"
                ? "●"
                : store.healthForSource(c.id) === "unreachable"
                  ? "⚠"
                  : "○"
            }}
            {{ healthLabel(c) }}
          </span>
          <span class="kind-badge">{{ kindLabel(c.kind) }}</span>
          <template v-if="store.canAuthor">
            <!-- POL-114 — a deck has exactly ONE authored setting: how long each page holds the screen. -->
            <label v-if="c.kind === 'deck' && c.deck" class="dwell" title="Seconds each page is shown">
              <input
                class="dwell-input"
                type="number"
                min="1"
                max="3600"
                :value="c.deck.dwellSeconds"
                @change="setDwell(c, Number(($event.target as HTMLInputElement).value))"
              />
              <span class="dwell-unit">s / page</span>
            </label>
            <button v-if="c.kind === 'page'" class="edit-btn" @click="openStudio(c)">Edit in Studio</button>
            <button v-else-if="c.kind === 'deck'" class="edit-btn" @click="openEdit(c)">Rename</button>
            <button v-else class="edit-btn" @click="openEdit(c)">Edit</button>
            <button class="del-btn" title="Delete source" @click="remove(c)">✕</button>
          </template>
        </div>
      </div>

      <!-- nothing matched the search / filter (the library itself is not empty) -->
      <div v-else-if="sources.length" class="empty">
        <span class="empty-glyph">⌕</span>
        <span class="empty-title">No sources match</span>
        <span class="empty-sub">
          Nothing in the library matches that search or filter. Clear them to see all
          {{ sources.length }}.
        </span>
        <div class="empty-actions">
          <button class="add-btn ghost" @click="query = ''; kindFilter = 'all'">Clear filters</button>
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
        <!-- Credential profiles hold content secrets: creating/editing/testing/deleting one is
             ADMIN-only (the server refuses the mutations for anyone else); the redacted list is not. -->
        <div v-if="store.isAdmin" class="head-actions">
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
          <template v-if="store.isAdmin">
            <button class="edit-btn" :disabled="testState[p.id] === 'running'" @click="runTest(p)">
              {{ testState[p.id] === "running" ? "Testing…" : "Test" }}
            </button>
            <button class="edit-btn" @click="openEditProfile(p)">Edit</button>
            <button class="del-btn" title="Delete profile" @click="removeProfile(p)">✕</button>
          </template>
        </div>
      </div>

      <div v-else class="empty">
        <span class="empty-glyph">🔒</span>
        <span class="empty-title">No credential profiles yet</span>
        <span class="empty-sub">
          Showing dashboards that need a sign-in? Register a client at your identity provider, add
          its details here once, and any number of screens share the session.
        </span>
        <div v-if="store.isAdmin" class="empty-actions">
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

        <!-- POL-114 — a deck has no type to pick and no address to type: it is a converted document.
             Only its name (and, on the row, its per-page dwell) is the operator's. -->
        <template v-if="!editingDeck">
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
          :placeholder="urlPlaceholder"
          @keyup.enter="save"
        />

        <!-- POL-108 — the live-stream seam, stated plainly to the operator: HLS in, RTSP restreamed
             outside Polyptic. No product is named; any restreamer works. -->
        <p v-if="isStream" class="field-hint">
          A live feed: point at an HLS playlist (<code>.m3u8</code>). The player reconnects by itself
          if the source drops. RTSP cameras need an RTSP-to-HLS restreamer in front — Polyptic plays
          what the restreamer publishes.
        </p>

        </template>

        <!-- POL-24 — the design's deferred "Authentication" picker. Web/dashboard only: images and
             videos are fetched directly by the player, not loaded as an authenticated page. -->
        <template v-if="authPickable && !editingDeck">
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

          <!-- POL-157 — the reload cadence. Off = the page loads once and stays (the default). Every
               screen showing this source reloads on the schedule set here; the player swaps the fresh
               page in only once it proves reachable, so a reload never blanks the wall. -->
          <label class="field-label">Reload</label>
          <select v-model="draftRefresh.mode" class="field select">
            <option value="off">Off — load once, never reload</option>
            <option value="interval">Every…</option>
            <option value="scheduled">At a set time…</option>
          </select>

          <div v-if="draftRefresh.mode === 'interval'" class="refresh-row">
            <input
              v-model.number="draftRefresh.every"
              class="field refresh-amount"
              type="number"
              min="1"
              step="1"
            />
            <select v-model="draftRefresh.unit" class="field select refresh-unit">
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>

          <template v-if="draftRefresh.mode === 'scheduled'">
            <div class="refresh-row">
              <input v-model="draftRefresh.time" class="field refresh-amount" type="time" />
              <span class="refresh-tz">{{ draftRefresh.timezone }}</span>
            </div>
            <div class="refresh-days">
              <button
                v-for="d in WEEKDAYS"
                :key="d.value"
                type="button"
                class="refresh-day"
                :class="{ active: draftRefresh.days.includes(d.value) }"
                @click="toggleRefreshDay(d.value)"
              >
                {{ d.label }}
              </button>
            </div>
          </template>
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
        <div class="modal-title">
          {{ canConvertDocuments ? "Upload a file" : "Upload image or video" }}
        </div>

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
            :accept="acceptTypes"
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
            <span class="drop-sub">
              <template v-if="canConvertDocuments">
                Images, videos, PDFs and slide decks · up to 200 MB
              </template>
              <template v-else>Images and videos · up to 200 MB</template>
            </span>
          </template>
        </div>

        <label class="field-label">Name <span class="optional">(optional)</span></label>
        <input
          v-model="uploadName"
          class="field"
          placeholder="Defaults to the file name"
          :disabled="uploading"
        />

        <!-- progress: bytes going up, then (POL-114) the server-side conversion, page by page -->
        <div v-if="uploading" class="progress-wrap">
          <div
            class="progress-bar"
            :class="{ indeterminate: converting && !job?.pageCount }"
            :style="{ width: `${Math.round((converting ? convertFraction : uploadProgress) * 100)}%` }"
          ></div>
          <span class="progress-label">
            <template v-if="converting">{{ jobLine }}</template>
            <template v-else>Uploading… {{ Math.round(uploadProgress * 100) }}%</template>
          </span>
        </div>
        <p v-if="converting" class="field-hint">
          Slides are converted to images on the server — a wall never runs an Office viewer. Large
          decks take a little while; you can leave this open.
        </p>

        <div v-if="uploadError" class="error">⚠ {{ uploadError }}</div>

        <div class="modal-actions">
          <button class="btn-secondary" :disabled="uploading" @click="closeUpload">Cancel</button>
          <button class="btn-primary" :disabled="uploading || !uploadFile" @click="doUpload">
            {{ converting ? "Converting…" : uploading ? "Uploading…" : "Upload" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* POL-114 — a deck's per-page dwell, edited in place on its library row. */
.dwell {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.dwell-input {
  width: 54px;
  padding: 5px 6px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
  text-align: right;
}
.dwell-unit {
  font-size: 11.5px;
}
/* An unknown page total shows a muted, full-width "working" bar — an honest unknown, not a fake %. */
.progress-bar.indeterminate {
  opacity: 0.5;
}

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
/* POL-157 — the reload cadence controls. */
.refresh-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.refresh-amount {
  width: 96px;
  flex: 0 0 auto;
}
.refresh-unit {
  flex: 0 0 auto;
  width: auto;
}
.refresh-tz {
  font-size: 12px;
  color: var(--fg2);
  font-variant-numeric: tabular-nums;
}
.refresh-days {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
}
.refresh-day {
  flex: 1;
  padding: 7px 4px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 11.5px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}
.refresh-day:hover {
  background: var(--muted-bg);
}
.refresh-day.active {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-fg);
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

/* image thumbnail / video poster in a list row (replaces the glyph badge — POL-109) */
.thumb {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  border-radius: 9px;
  object-fit: cover;
  background: var(--muted-bg);
  border: 1px solid var(--line);
}
/* a video's poster reads as film, not as a photo */
.thumb.is-video {
  border-color: var(--accent-line, var(--line));
}

/* POL-109 — the accepted-with-a-caveat note above the library */
.notice {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--fg2);
  background: var(--muted-bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.notice span {
  flex: 1;
}
.notice-x {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
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

/* ── search · filter · sort (POL-94) ─────────────────────────────────────────── */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.search-wrap {
  position: relative;
  flex: 1 1 220px;
  min-width: 180px;
}
.search-glyph {
  position: absolute;
  left: 11px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 13px;
  color: var(--muted2);
  pointer-events: none;
}
.search {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 8px 12px 8px 30px;
  font-size: 13px;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.search:focus {
  border-color: var(--accent);
}
.filter-row {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.filter-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 10px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}
.filter-btn:hover {
  background: var(--muted-bg);
}
.filter-btn.active {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.sort {
  appearance: auto;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 9px;
  font-size: 12px;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}

/* ── usage + health (POL-94) ─────────────────────────────────────────────────── */
.row-usage {
  font-size: 11px;
  color: var(--muted2);
  margin-top: 2px;
}
.health-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
  cursor: help;
  color: var(--muted);
  background: var(--muted-bg);
}
.health-pill.reachable {
  color: var(--ok, #1d8a4e);
  background: var(--ok-soft, var(--muted-bg));
}
.health-pill.unreachable {
  color: var(--bad);
  background: var(--bad-soft);
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
