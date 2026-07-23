<script setup lang="ts">
import { imageDistribution, OperatorRole } from "@polyptic/protocol";
import type { AgentSecurityInfo, EnrollmentTokenView, HttpsInfo, ImageBuild, ImageRing, Operator } from "@polyptic/protocol";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";

import { ApiError } from "../api";
import * as auth from "../auth";
import Toggle from "../components/Toggle.vue";
import { useConsoleStore } from "../stores/console";
import { formatRelativeShort } from "../time";

// Settings (POL-45): one card per concern. "Onboard Screens" is the fleet's front door — the
// bootloader you write once to a USB stick, the builds it streams, and the ⋯ menu that rebuilds or
// force-deploys them. "Update schedule" owns when new images are cut; the rollout window explains
// when boxes take them.
const store = useConsoleStore();
const router = useRouter();

onMounted(() => {
  void store.fetchEnrollment();
  void store.fetchNetboot();
  void store.fetchDisplaySettings();
  void store.fetchBootOrderPolicy();
  void store.fetchImageUpdates();
  void loadHttps();
  void loadOperators();
  void loadAgentSecurity();
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (usbModal.value) usbModal.value = false;
  else if (menuOpen.value) menuOpen.value = false;
  else if (rowMenu.value) rowMenu.value = null;
}

// ── Toast ──────────────────────────────────────────────────────────────────────
const toast = ref("");
let toastTimer: number | undefined;
function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  toast.value = message;
  toastTimer = window.setTimeout(() => (toast.value = ""), 1900);
}

async function copy(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(message);
  } catch {
    // Clipboard is unavailable outside a secure context — Copy is a best-effort convenience.
    showToast("Copy failed because the clipboard is unavailable");
  }
}

// ── Appearance ─────────────────────────────────────────────────────────────────
function setTheme(theme: "light" | "dark"): void {
  if (store.theme !== theme) store.toggleTheme();
}

// ── On-screen badges (POL-6) ───────────────────────────────────────────────────
const badgesSaving = ref(false);

async function setBadges(show: boolean): Promise<void> {
  if (badgesSaving.value || store.showBadges === show) return;
  badgesSaving.value = true;
  try {
    await store.setShowBadges(show);
  } catch {
    /* the store already reverted the optimistic value; the switch reflects the true state */
  } finally {
    badgesSaving.value = false;
  }
}

// ── UEFI boot order (POL-115) ──────────────────────────────────────────────────
// Opt-in, and deliberately worded as one: the box writes a firmware boot variable. Off means a box
// that finds its entry displaced REPORTS the drift and writes nothing.
const bootOrderSaving = ref(false);

async function setBootOrderReassert(reassert: boolean): Promise<void> {
  if (bootOrderSaving.value || store.bootOrder?.reassert === reassert) return;
  bootOrderSaving.value = true;
  try {
    await store.setBootOrderReassert(reassert);
    showToast(
      reassert
        ? "Boxes may now re-assert their own boot order"
        : "Boxes will only report boot-order drift",
    );
  } catch {
    /* the store already reverted the optimistic value; the switch reflects the true state */
  } finally {
    bootOrderSaving.value = false;
  }
}

// ── Enrolment tokens (POL-104) ─────────────────────────────────────────────────
//
// One flat token baked into every stick is a fleet credential: a stick that walks out compromises
// enrolment for the whole estate, and rotating it meant re-flashing every medium. The card is now a
// TABLE of named, scoped, individually revocable tokens. Exactly one is BAKED into new boot media.
const busyToken = ref<string | null>(null);
const showNewToken = ref(false);
const newTokenName = ref("");
const newTokenExpiryDays = ref<string>("");
const newTokenMax = ref<string>("");
const newTokenBake = ref(false);

/** A token's state, in the operator's language. `live` is the only one that enrols anything. */
type TokenState = "live" | "expired" | "revoked" | "used-up";

function tokenState(token: EnrollmentTokenView): TokenState {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) return "expired";
  if (token.maxEnrollments !== null && token.uses >= token.maxEnrollments) return "used-up";
  return "live";
}

function tokenScope(token: EnrollmentTokenView): string {
  const parts: string[] = [];
  parts.push(
    token.maxEnrollments === null
      ? `${token.uses} enrolled · no limit`
      : `${token.uses} / ${token.maxEnrollments} enrolled`,
  );
  if (token.expiresAt) {
    const when = new Date(token.expiresAt);
    parts.push(
      when.getTime() <= Date.now()
        ? `expired ${when.toLocaleDateString()}`
        : `expires ${when.toLocaleDateString()}`,
    );
  } else {
    parts.push("never expires");
  }
  return parts.join(" · ");
}

async function createToken(): Promise<void> {
  const name = newTokenName.value.trim();
  if (!name || busyToken.value) return;
  busyToken.value = "new";
  const days = Number.parseInt(newTokenExpiryDays.value, 10);
  const max = Number.parseInt(newTokenMax.value, 10);
  const ok = await store.createEnrollmentToken({
    name,
    ...(Number.isFinite(days) && days > 0 ? { expiresInDays: days } : {}),
    ...(Number.isFinite(max) && max > 0 ? { maxEnrollments: max } : {}),
    bake: newTokenBake.value,
  });
  busyToken.value = null;
  if (!ok) {
    showToast("Could not create the token");
    return;
  }
  showNewToken.value = false;
  newTokenName.value = "";
  newTokenExpiryDays.value = "";
  newTokenMax.value = "";
  newTokenBake.value = false;
  showToast(`Token "${name}" created`);
}

async function rotateToken(token: EnrollmentTokenView): Promise<void> {
  if (busyToken.value) return;
  const yes = window.confirm(
    `Rotate "${token.name}"?\n\nA new secret is cut and baked into future boot media. The OLD secret keeps ` +
      `enrolling for 24 more hours (the grace window), so boots in flight and media not yet re-flashed are ` +
      `not stranded. Re-bake your boot media before the window closes.`,
  );
  if (!yes) return;
  busyToken.value = token.id;
  const ok = await store.rotateEnrollmentToken(token.id, 24);
  busyToken.value = null;
  showToast(ok ? "Token rotated. Old secret valid for 24 h" : "Could not rotate the token");
}

async function revokeToken(token: EnrollmentTokenView): Promise<void> {
  if (busyToken.value) return;
  const yes = window.confirm(
    `Revoke "${token.name}"?\n\nNo NEW machine can enrol with it, including a box booting from a stick that ` +
      `carries it. The ${token.uses} machine(s) already enrolled on it hold their own per-machine credential ` +
      `and KEEP RUNNING. To take one of those off the wall, reject it in Machines.`,
  );
  if (!yes) return;
  busyToken.value = token.id;
  const ok = await store.revokeEnrollmentToken(token.id);
  busyToken.value = null;
  showToast(ok ? `"${token.name}" revoked. Running machines untouched` : "Could not revoke the token");
}

async function bakeToken(token: EnrollmentTokenView): Promise<void> {
  if (busyToken.value) return;
  busyToken.value = token.id;
  const ok = await store.bakeEnrollmentToken(token.id);
  busyToken.value = null;
  showToast(ok ? `New boot media will carry "${token.name}"` : "Could not select the token");
}

async function deleteToken(token: EnrollmentTokenView): Promise<void> {
  if (busyToken.value) return;
  const last = store.enrollmentTokens.length === 1;
  const yes = window.confirm(
    last
      ? `Delete the LAST enrolment token?\n\nEnrolment goes back to OPEN mode. Every agent that connects is ` +
          `auto-registered and auto-approved, with no token at all.`
      : `Delete "${token.name}"? Machines already enrolled on it keep running.`,
  );
  if (!yes) return;
  busyToken.value = token.id;
  const ok = await store.deleteEnrollmentToken(token.id);
  busyToken.value = null;
  showToast(ok ? "Token deleted" : "Could not delete the token");
}

// ── HTTPS (POL-70/D89) ─────────────────────────────────────────────────────────
// Only meaningful when THIS listener terminates TLS (native provided/self-signed). Behind a
// TLS-terminating ingress the server sees plain HTTP ("off") and the card stays hidden — the
// certificate story lives with the ingress / cert-manager there, not here.
const https = ref<HttpsInfo | null>(null);
const trustOpen = ref(false);
const caDownloading = ref(false);

/** Non-throwing, like fetchNetboot — a failed load just leaves the card hidden. */
async function loadHttps(): Promise<void> {
  try {
    https.value = await auth.getHttpsInfo();
  } catch (err) {
    console.error("[console] loadHttps failed", err);
  }
}

async function downloadCa(): Promise<void> {
  if (!https.value?.ca || caDownloading.value) return;
  caDownloading.value = true;
  try {
    const blob = await auth.downloadHttpsCa();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "polyptic-ca.crt";
    a.click();
    URL.revokeObjectURL(url);
    showToast("CA certificate downloaded");
  } catch (err) {
    console.error("[console] CA download failed", err);
    showToast("Download failed");
  } finally {
    caDownloading.value = false;
  }
}

// ── Agent security (POL-134) ───────────────────────────────────────────────────
// The mTLS posture of the agent channel, in operator words. Loaded non-throwing like the HTTPS
// card: a failed fetch leaves the card in its loading state rather than breaking Settings.
const agentSec = ref<AgentSecurityInfo | null>(null);

async function loadAgentSecurity(): Promise<void> {
  try {
    agentSec.value = await auth.getAgentSecurity();
  } catch (err) {
    console.error("[console] loadAgentSecurity failed", err);
  }
}

/** How many machines have proven they hold a working cert (connected over mTLS at least once). */
const mtlsMigrated = computed(() => (agentSec.value?.machines ?? []).filter((m) => m.mtlsSeenAt).length);

/** One plain-words state per machine, for the card's list. */
function machineCertState(m: AgentSecurityInfo["machines"][number]): { label: string; cls: string } {
  if (m.online && m.agentChannel === "mtls") return { label: "Secure channel", cls: "asec-ok" };
  // POL-143 — the box holds a cert but reports it can't reach the mTLS door. This BEATS the
  // "moves over on next connection" promise: the migration is stalled, not pending, and the card
  // must say so (the address it tried is shown on the sub-line below).
  if (m.mtlsDialError) return { label: "Can't reach the secure port", cls: "asec-bad" };
  if (m.mtlsSeenAt) return { label: "Has certificate", cls: "asec-ok" };
  if (m.mtlsCertIssuedAt) return { label: "Certificate issued", cls: "asec-warn" };
  return { label: "No certificate yet", cls: "asec-warn" };
}

// ── Onboard Screens: the ⋯ build menu ──────────────────────────────────────────
const menuOpen = ref(false);
const imgSaving = ref(false);

const rebuilding = computed(() => store.imageUpdates?.lastBuild?.status === "running");

async function rebuildNow(kind: "refresh" | "full"): Promise<void> {
  menuOpen.value = false;
  if (imgSaving.value) return;
  imgSaving.value = true;
  try {
    store.imageUpdates = await auth.rebuildImageNow(kind);
    showToast(kind === "full" ? "Full rebuild queued" : "Build update queued");
  } catch (err) {
    console.error("[console] rebuild trigger failed", err);
    showToast("Could not start the rebuild");
  } finally {
    imgSaving.value = false;
  }
}

/** The urgent switch, framed as what it does: skip the nightly window and reboot the fleet now. */
async function setUrgent(urgent: boolean): Promise<void> {
  menuOpen.value = false;
  if (
    urgent &&
    !window.confirm(
      "Deploy the latest image to the whole fleet now? Every netbooted box on a different image reboots within minutes.",
    )
  ) {
    return;
  }
  await applyImageSettings({ urgent });
  if (store.imageUpdates?.urgent === urgent) {
    showToast(urgent ? "Deploying latest to fleet" : "Immediate deployment stopped");
  }
}

// ── Onboard Screens: the bootloader + retained builds ──────────────────────────
const usbModal = ref(false);
const advOpen = ref(false);

/** The newest published image across arches — what a freshly written stick will stream on boot. */
const latestImage = computed(() => {
  const images = store.imageUpdates?.images ?? [];
  return [...images].sort((a, b) => b.builtAt.localeCompare(a.builtAt))[0] ?? null;
});

/** Nothing published in the depot: the fleet cannot netboot AT ALL (POL-121). */
const noImage = computed(() => (store.imageUpdates?.images.length ?? 0) === 0);

/**
 * The empty-depot notice (POL-121). A fresh install used to say nothing at all while its depot sat
 * empty — and the boot medium it handed out was the silently-LEAN one baked against that empty depot.
 * Now the card says, in its own words, what is happening and why it matters.
 */
const netbootNotice = computed<{ tone: "busy" | "warn"; text: string } | null>(() => {
  const info = store.imageUpdates;
  if (!info || !noImage.value) return null;
  if (info.lastBuild?.status === "running") {
    return {
      tone: "busy",
      text: "Building the first OS image…",
    };
  }
  if (!info.fullRebuildConfigured) {
    return {
      tone: "warn",
      text: "No OS image, and this deployment has no image-build hook, so screens cannot netboot until an image is put in the depot.",
    };
  }
  return {
    tone: "warn",
    text: "No OS image yet, so screens cannot netboot. Build one from the ⋯ menu above (Full rebuild).",
  };
});

/** `20260709T110917Z-1bdb6281` → `20260709T110917Z · 1bdb6281`, the design's two-part id. */
function formatImageId(imageId: string): string {
  const cut = imageId.lastIndexOf("-");
  return cut > 0 ? `${imageId.slice(0, cut)} · ${imageId.slice(cut + 1)}` : imageId;
}

const nowMs = ref(Date.now());
const clock = window.setInterval(() => (nowMs.value = Date.now()), 30_000);
onBeforeUnmount(() => window.clearInterval(clock));

/**
 * The status CHIP on the Network boot loader row — the only status element (POL-68 §4): while a
 * build runs it becomes "Rebuilding"/"Updating" with a spinner, the detail lives in its hover
 * tooltip; a failed build shows red; otherwise null and the idle "auto-updates" chip renders.
 */
const buildChip = computed<{ label: string; title: string; tone: "busy" | "bad" } | null>(() => {
  const b = store.imageUpdates?.lastBuild;
  if (!b) return null;
  if (b.status === "running") {
    // POL-121: the FIRST build is a different event to a rebuild — until it lands, no screen in the
    // fleet can netboot at all. Say that, rather than the routine "Rebuilding".
    if (noImage.value) {
      return {
        label: "Building first image",
        title: `Building the first OS image. Started ${new Date(b.startedAt).toLocaleString()}. A full build takes roughly 15 minutes.`,
        tone: "busy",
      };
    }
    const kind = b.kind === "full" ? "Full rebuild" : "Image update";
    return {
      label: b.kind === "full" ? "Rebuilding" : "Updating",
      title: `${kind} running, started ${new Date(b.startedAt).toLocaleString()}`,
      tone: "busy",
    };
  }
  if (b.status === "failure") {
    return {
      label: "Build failed",
      title: `Last build failed at ${new Date(b.finishedAt ?? b.startedAt).toLocaleString()}`,
      tone: "bad",
    };
  }
  return null;
});

/** ISO downloads bake the enrolment token — said at the point of download, not in a footer (POL-68). */
const ISO_CREDENTIAL_NOTE = "bakes the current enrolment token, so treat the file as a credential";

/**
 * What the bootloader download REALLY is right now (POL-122). "A file exists" was the old test, and
 * it lied twice over: a fresh install published a LEAN (wired-only) medium under the same filename,
 * and the button offered it as if it would boot anything. Four honest states:
 *   full     — the real universal medium: download it.
 *   lean     — a wired-only medium (an older deploy left one on the depot): downloadable, but say so.
 *   building — no medium, an image build is in flight: the medium is baked from it. Wait.
 *   none     — no medium, no image: build one.
 */
const mediumState = computed<"full" | "lean" | "building" | "none" | null>(() => {
  if (!store.netboot) return null; // not loaded yet — the UI shows nothing rather than a wrong thing
  const m = store.netboot.bootMedium;
  if (m) return m.lean ? "lean" : "full";
  return store.imageUpdates?.lastBuild?.status === "running" ? "building" : "none";
});

function onDownloadBootloader(): void {
  // The design opens the how-to modal; the download itself is the point, so do both. The anchor's
  // own navigation starts the transfer — we only add the instructions the operator needs next.
  usbModal.value = true;
}

const activating = ref<string | null>(null);
/** Which build row has its overflow menu open, by `<arch>-<imageId>` (ids repeat across arches). */
const rowMenu = ref<string | null>(null);
const rowKey = (b: ImageBuild): string => `${b.arch}-${b.imageId}`;

async function activate(build: ImageBuild): Promise<void> {
  rowMenu.value = null;
  if (activating.value || build.active) return;
  if (
    !window.confirm(
      `Serve ${formatImageId(build.imageId)} (${build.arch}) to the fleet? Boxes on a different image will reboot into it.`,
    )
  ) {
    return;
  }
  activating.value = build.imageId;
  try {
    store.imageUpdates = await auth.activateImage(build.arch, build.imageId);
    showToast(`Now serving ${build.arch} · ${build.imageId.split("-").pop()}`);
  } catch (err) {
    console.error("[console] activate failed", err);
    showToast("Could not activate that build");
  } finally {
    activating.value = null;
  }
}

// ── Staged roll-outs + the version distribution (POL-105) ──────────────────────
//
// The distribution is computed from the LIVE admin state (`store.machines`, pushed over the WS on
// every change) joined against the depot's retained builds — so "which boxes are on which build"
// updates itself as boxes come back on a new image, with no polling and no second source of truth.
// `imageDistribution` is the shared protocol function; the server's tests pin the same one.

const distribution = computed(() =>
  imageDistribution(store.machines, store.imageUpdates?.builds ?? []),
);

/** The roll-out rings, indexed by the build they pin — the build rows render their own canary state. */
const ringsByBuild = computed(() => {
  const map = new Map<string, ImageRing[]>();
  for (const ring of store.imageUpdates?.rings ?? []) {
    const key = `${ring.arch}-${ring.imageId}`;
    map.set(key, [...(map.get(key) ?? []), ring]);
  }
  return map;
});

const ringBusy = ref(false);

async function saveRings(rings: ImageRing[], message: string): Promise<void> {
  if (ringBusy.value) return;
  ringBusy.value = true;
  try {
    store.imageUpdates = await auth.setImageRings(rings);
    showToast(message);
  } catch (err) {
    console.error("[console] rings update failed", err);
    showToast(err instanceof Error ? err.message : "Could not save the roll-out rings");
  } finally {
    ringBusy.value = false;
  }
}

/** Pin a build to a tag: every machine carrying that tag boots THIS build, the rest of the fleet
 *  stays on the active one. The tag is POL-103's — the same chips the Machines view edits. */
async function canary(build: ImageBuild): Promise<void> {
  rowMenu.value = null;
  const raw = window.prompt(
    `Which tag should boot ${formatImageId(build.imageId)} (${build.arch})?\n\nMachines carrying this tag boot this build, and every other machine stays on the fleet build. Tag machines in the Machines view.`,
    "canary",
  );
  if (raw === null) return;
  const tag = raw.trim().toLowerCase();
  if (!tag) return;

  const selector = `tag=${tag}`;
  const urgent = window.confirm(
    `Reboot the ${selector} machines into this build within minutes?\n\nOK = now (splayed). Cancel = they take it in the nightly window.`,
  );
  const rings = (store.imageUpdates?.rings ?? []).filter(
    (r) => !(r.arch === build.arch && r.selector === selector),
  );
  await saveRings(
    [...rings, { selector, arch: build.arch, imageId: build.imageId, urgent }],
    `${selector} → ${build.arch} · ${build.imageId.split("-").pop()}`,
  );
}

/** Drop a ring: its machines rejoin the fleet build on their next poll. */
async function dropRing(ring: ImageRing): Promise<void> {
  rowMenu.value = null;
  if (!window.confirm(`Stop pinning ${ring.selector} to this build? Those machines rejoin the fleet build.`)) return;
  await saveRings(
    (store.imageUpdates?.rings ?? []).filter((r) => r !== ring),
    `${ring.selector} rejoins the fleet build`,
  );
}

/** Promote a canary to the whole fleet: activate its build AND drop the ring, in one action. */
async function promote(ring: ImageRing): Promise<void> {
  rowMenu.value = null;
  if (ringBusy.value) return;
  if (
    !window.confirm(
      `Promote ${formatImageId(ring.imageId)} (${ring.arch}) from ${ring.selector} to the WHOLE fleet?\n\nEvery box on another image reboots into it, and ${ring.selector} stops being a canary.`,
    )
  ) {
    return;
  }
  const urgent = window.confirm("Roll it out within minutes?\n\nOK = now (splayed). Cancel = the nightly window.");
  ringBusy.value = true;
  try {
    store.imageUpdates = await auth.promoteImageRing(ring.arch, ring.selector, urgent);
    showToast(`Promoted ${ring.arch} · ${ring.imageId.split("-").pop()} to the fleet`);
  } catch (err) {
    console.error("[console] promote failed", err);
    showToast("Could not promote that build");
  } finally {
    ringBusy.value = false;
  }
}

// ── Update schedule (POL-41 nightly refresh + POL-43 weekly full rebuild) ───────
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function applyImageSettings(patch: {
  scheduleEnabled?: boolean;
  scheduleTime?: string;
  fullScheduleEnabled?: boolean;
  fullScheduleDay?: number;
  fullScheduleTime?: string;
  urgent?: boolean;
}): Promise<void> {
  if (imgSaving.value) return;
  imgSaving.value = true;
  try {
    store.imageUpdates = await auth.updateImageSettings(patch);
  } catch (err) {
    console.error("[console] image settings update failed", err);
    showToast("Could not save image settings");
  } finally {
    imgSaving.value = false;
  }
}

function saveTime(value: string, field: "scheduleTime" | "fullScheduleTime"): void {
  const t = value.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return;
  void applyImageSettings(field === "scheduleTime" ? { scheduleTime: t } : { fullScheduleTime: t });
}

function goToOnboard(): void {
  document.getElementById("sec-netboot")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── Operators (POL-107) ────────────────────────────────────────────────────────
// Admin-only. The card is hidden for other roles, and the SERVER refuses every one of these calls
// with a 403 for them anyway — the hiding is a courtesy, the 403 is the permission system.
const operators = ref<Operator[]>([]);
const opsError = ref<string | null>(null);
const opsBusy = ref<string | null>(null);
const opsCreating = ref(false);
const newOp = reactive<{ email: string; password: string; role: OperatorRole }>({
  email: "",
  password: "",
  role: "operator",
});

async function loadOperators(): Promise<void> {
  if (!store.isAdmin) return;
  try {
    operators.value = await auth.listOperators();
  } catch {
    // A non-admin never gets here (the card is hidden); a transport failure just leaves the list empty.
    operators.value = [];
  }
}

async function onCreateOperator(): Promise<void> {
  if (opsCreating.value) return;
  opsError.value = null;
  if (!newOp.email.includes("@")) {
    opsError.value = "Enter a valid email address.";
    return;
  }
  if (newOp.password.length < 8) {
    opsError.value = "The password must be at least 8 characters.";
    return;
  }
  opsCreating.value = true;
  try {
    await auth.createOperator({ email: newOp.email, password: newOp.password, role: newOp.role });
    newOp.email = "";
    newOp.password = "";
    newOp.role = "operator";
    await loadOperators();
    showToast("Operator added");
  } catch (err) {
    opsError.value =
      err instanceof ApiError && err.status === 409
        ? "An operator with that email already exists."
        : "Could not add that operator.";
  } finally {
    opsCreating.value = false;
  }
}

async function onRoleChange(op: Operator, raw: string): Promise<void> {
  const parsed = OperatorRole.safeParse(raw);
  if (!parsed.success || parsed.data === op.role) return;
  opsError.value = null;
  opsBusy.value = op.id;
  try {
    await auth.updateOperator(op.id, { role: parsed.data });
    await loadOperators();
    showToast(`${op.email} is now ${parsed.data}`);
  } catch (err) {
    // 409 = the last-admin guard. Reload so the <select> snaps back to the truth on the server.
    opsError.value =
      err instanceof ApiError && err.status === 409
        ? "That change would leave the deployment with no admin."
        : "Could not change that role.";
    await loadOperators();
  } finally {
    opsBusy.value = null;
  }
}

async function onRemoveOperator(op: Operator): Promise<void> {
  if (!window.confirm(`Remove ${op.email}? Their sessions end immediately.`)) return;
  opsError.value = null;
  opsBusy.value = op.id;
  try {
    await auth.deleteOperator(op.id);
    await loadOperators();
    showToast("Operator removed");
  } catch (err) {
    opsError.value =
      err instanceof ApiError && err.status === 409
        ? "The last admin cannot be removed."
        : "Could not remove that operator.";
  } finally {
    opsBusy.value = null;
  }
}

// ── Change password ────────────────────────────────────────────────────────────
const pw = reactive({ current: "", next: "", confirm: "" });
const pwError = ref<string | null>(null);
const pwSuccess = ref(false);
const pwSaving = ref(false);

async function onChangePassword(): Promise<void> {
  if (pwSaving.value) return;
  pwError.value = null;
  pwSuccess.value = false;
  if (!pw.current) {
    pwError.value = "Enter your current password.";
    return;
  }
  if (pw.next.length < 8) {
    pwError.value = "New password must be at least 8 characters.";
    return;
  }
  if (pw.next !== pw.confirm) {
    pwError.value = "New passwords do not match.";
    return;
  }
  pwSaving.value = true;
  try {
    await store.changePassword({ currentPassword: pw.current, newPassword: pw.next });
    pwSuccess.value = true;
    pw.current = "";
    pw.next = "";
    pw.confirm = "";
  } catch {
    // Generic message — never reveal which field was at fault beyond "current password wrong".
    pwError.value = "Could not change password. Check your current password.";
  } finally {
    pwSaving.value = false;
  }
}

/** The signed-in operator's role, title-cased for the Account card ("Admin" / "Operator" / "Viewer"). */
const roleLabel = computed(() => store.role.charAt(0).toUpperCase() + store.role.slice(1));

// ── Logout ─────────────────────────────────────────────────────────────────────
const loggingOut = ref(false);
async function onSignOut(): Promise<void> {
  if (loggingOut.value) return;
  loggingOut.value = true;
  await store.logout();
  await router.replace({ name: "signin" });
}
</script>

<template>
  <div class="page">
    <div class="inner">
      <h1 class="page-title">Settings</h1>
      <p class="page-sub">Console preferences, fleet enrolment, and the live-image lifecycle.</p>

      <!-- Appearance ---------------------------------------------------------- -->
      <section class="card row-card">
        <div>
          <h2 class="card-title">Appearance</h2>
          <p class="card-sub">Theme for the operator console.</p>
        </div>
        <div class="pill-group">
          <button type="button" class="pill" :class="{ active: store.theme === 'light' }" @click="setTheme('light')">
            ☼&nbsp; Light
          </button>
          <button type="button" class="pill" :class="{ active: store.theme === 'dark' }" @click="setTheme('dark')">
            ☾&nbsp; Dark
          </button>
        </div>
      </section>

      <!-- Onboard Screens (POL-33 netboot + POL-45 builds) --------------------- -->
      <!-- POL-107: the fleet cards below are ADMIN-only. The server 403s every route behind them
           (deny-by-default in roles.ts), so hiding them is honesty, not security. -->
      <section v-if="store.isAdmin" id="sec-netboot" class="card pad-lg">
        <div class="title-row">
          <h2 class="card-title">Onboard Screens</h2>
          <div class="spacer" />
          <div class="menu-wrap">
            <button
              type="button"
              class="menu-btn"
              :class="{ open: menuOpen }"
              aria-label="Build actions"
              :aria-expanded="menuOpen"
              @click="menuOpen = !menuOpen"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
              </svg>
            </button>
            <template v-if="menuOpen">
              <div class="menu-scrim" @click="menuOpen = false" />
              <div class="menu">
                <button
                  type="button"
                  class="menu-item"
                  :disabled="imgSaving || rebuilding || !store.imageUpdates?.rebuildConfigured"
                  @click="rebuildNow('refresh')"
                >
                  <svg
                    width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="menu-icon"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" /><polyline points="21 3 21 8 16 8" />
                  </svg>
                  <span class="menu-text">
                    <span class="menu-title">Update image now</span>
                    <span class="menu-sub">In-place, userspace only.</span>
                  </span>
                </button>
                <button
                  type="button"
                  class="menu-item"
                  :disabled="imgSaving || rebuilding || !store.imageUpdates?.fullRebuildConfigured"
                  @click="rebuildNow('full')"
                >
                  <svg
                    width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="menu-icon"
                  >
                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
                    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
                  </svg>
                  <span class="menu-text">
                    <span class="menu-title">Full rebuild now</span>
                    <span class="menu-sub">From the base ISO, kernel included.</span>
                  </span>
                </button>
                <div class="menu-sep" />
                <button
                  type="button"
                  class="menu-item danger"
                  :disabled="imgSaving"
                  @click="setUrgent(!store.imageUpdates?.urgent)"
                >
                  <svg
                    width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="menu-icon warn"
                  >
                    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
                  </svg>
                  <span class="menu-text">
                    <template v-if="store.imageUpdates?.urgent">
                      <span class="menu-title">Stop immediate deployment</span>
                      <span class="menu-sub">Let stale boxes wait for their nightly window.</span>
                    </template>
                    <template v-else>
                      <span class="menu-title">Deploy latest to fleet immediately</span>
                      <span class="menu-sub">Skip the nightly window, so boxes reboot now.</span>
                    </template>
                  </span>
                </button>
              </div>
            </template>
          </div>
        </div>
        <p class="card-sub wrap gap">
          Enrol a machine straight into Polyptic over the network (no OS install, no disk). Write the bootloader to a
          USB stick and it streams the current image into RAM. The control-plane URL
          and enrolment token are baked into the image.
        </p>

        <!-- Network boot loader ---------------------------------------------- -->
        <div class="sub-card">
          <div class="sub-head">
            <span class="icon-tile">
              <svg
                width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="var(--fg2)" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <line x1="22" x2="2" y1="12" y2="12" />
                <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                <line x1="6" x2="6.01" y1="16" y2="16" />
              </svg>
            </span>
            <div class="min-w-0 sub-text">
              <div class="sub-title">Network boot loader</div>
              <div class="sub-sub">Write once to USB. Screens boot from it and pull the latest image automatically.</div>
            </div>
            <!-- The status chip is the ONLY status element on this row (POL-68 §4): it animates
                 while a build runs and carries the detail in its tooltip. -->
            <span
              v-if="buildChip"
              class="chip"
              :class="buildChip.tone === 'busy' ? 'chip-accent' : 'chip-bad'"
              :title="buildChip.title"
            >
              <span v-if="buildChip.tone === 'busy'" class="spinner" />
              {{ buildChip.label }}
            </span>
            <span v-else class="chip chip-accent" title="The bootloader always pulls the newest published image">
              <svg
                width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
              </svg>
              auto-updates
            </span>
          </div>

          <div class="dl-row">
            <div class="latest">
              <span class="latest-label">Latest</span>
              <span v-if="latestImage" class="latest-id">{{ formatImageId(latestImage.imageId) }}</span>
              <span v-else class="latest-id none">No image published yet</span>
            </div>
            <a
              v-if="store.netboot?.bootMediumUrl && (mediumState === 'full' || mediumState === 'lean')"
              class="btn btn-primary dl-btn"
              :href="store.netboot.bootMediumUrl"
              download
              :title="
                mediumState === 'lean'
                  ? 'Wired-only medium. It cannot boot a Wi-Fi-only screen.'
                  : `The bootloader ${ISO_CREDENTIAL_NOTE}`
              "
              @click="onDownloadBootloader"
            >
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" />
                <line x1="12" x2="12" y1="15" y2="3" />
              </svg>
              {{ mediumState === "lean" ? "Download (wired-only)" : "Download bootloader" }}
            </a>
            <button v-else-if="mediumState === 'building'" type="button" class="btn btn-primary dl-btn" disabled>
              <span class="spinner" />
              Building the first OS image…
            </button>
            <button v-else type="button" class="btn btn-primary dl-btn" disabled>No bootloader yet</button>
          </div>

          <!-- POL-122: never imply a stick can boot a screen it can't. The empty/building depot is already
               spoken for by POL-121's notice below, so these two cover only what IT doesn't: a medium that
               is missing even though an image exists, and a medium that is present but WIRED-ONLY. -->
          <p v-if="mediumState === 'none' && !netbootNotice" class="hint gap-sm">
            No bootloader is published, though this deployment has an OS image to bake one from. Run a
            <b>Full rebuild</b> from the ⋯ menu above, or build one into <code class="code">BOOT_DIST_DIR</code>
            with <code class="code">deploy/build-boot-medium.sh</code>.
          </p>
          <p v-else-if="mediumState === 'lean'" class="hint gap-sm hint-warn">
            This bootloader is <b>wired-only</b> and cannot support machines with Wi-Fi. Run a
            <b>Full rebuild</b> to publish the full Wi-Fi capable medium.
          </p>

          <!-- POL-121: an empty depot is not a footnote — it is the difference between a fleet that
               can boot and one that cannot. Say so on the card, unprompted. -->
          <p v-if="netbootNotice" class="notice gap-sm" :class="`notice-${netbootNotice.tone}`" data-testid="netboot-notice">
            <span v-if="netbootNotice.tone === 'busy'" class="spinner" />
            {{ netbootNotice.text }}
          </p>
        </div>

        <!-- Recent builds ------------------------------------------------------ -->
        <div class="field-label">Recent builds</div>
        <div v-if="(store.imageUpdates?.builds.length ?? 0) > 0" class="builds">
          <div v-for="b in store.imageUpdates!.builds" :key="`${b.arch}-${b.imageId}`" class="build-row" :class="{ active: b.active }">
            <span class="arch">{{ b.arch }}</span>
            <span class="build-id">{{ formatImageId(b.imageId) }}</span>
            <!-- The active row's accent tint IS its status — no age, no chip (POL-68 §4). -->
            <template v-if="!b.active">
              <span class="build-when">{{ formatRelativeShort(b.builtAt, nowMs) }}</span>
              <span class="tag tag-muted">Superseded</span>
            </template>

            <!-- POL-105 — the roll-out rings pinned to this build: `tag=canary` boots THIS build
                 while the fleet stays on the active one. -->
            <span
              v-for="ring in ringsByBuild.get(rowKey(b)) ?? []"
              :key="ring.selector"
              class="tag tag-ring"
              :title="`Machines matching ${ring.selector} boot this build${ring.urgent ? ' within minutes' : ' in the nightly window'}`"
            >
              {{ ring.selector }}{{ ring.urgent ? " · now" : "" }}
            </span>

            <!-- The active build has nothing to activate, so its single action stays a plain icon.
                 Every other row folds Download + Activate into an overflow menu. -->
            <template v-if="b.active">
              <a
                v-if="b.liveIsoUrl"
                class="row-btn"
                :href="b.liveIsoUrl"
                download
                :title="`Download the bootable live ISO for ${b.imageId}. It ${ISO_CREDENTIAL_NOTE}`"
              >
                <svg
                  width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
                  stroke-linecap="round" stroke-linejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" />
                  <line x1="12" x2="12" y1="15" y2="3" />
                </svg>
              </a>
              <span v-else class="row-btn empty" title="This build has no standalone live ISO" />
            </template>

            <div v-else class="menu-wrap">
              <button
                type="button"
                class="row-btn"
                :class="{ open: rowMenu === rowKey(b) }"
                :aria-label="`Actions for build ${b.imageId}`"
                :aria-expanded="rowMenu === rowKey(b)"
                :disabled="activating !== null"
                @click="rowMenu = rowMenu === rowKey(b) ? null : rowKey(b)"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
                </svg>
              </button>
              <template v-if="rowMenu === rowKey(b)">
                <div class="menu-scrim" @click="rowMenu = null" />
                <div class="menu menu-row">
                  <a
                    v-if="b.liveIsoUrl"
                    class="menu-item"
                    :href="b.liveIsoUrl"
                    download
                    :title="`This ISO ${ISO_CREDENTIAL_NOTE}`"
                    @click="rowMenu = null"
                  >
                    <svg
                      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                      stroke-linecap="round" stroke-linejoin="round" class="menu-icon"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" />
                      <line x1="12" x2="12" y1="15" y2="3" />
                    </svg>
                    <span class="menu-text"><span class="menu-title">Download live ISO</span></span>
                  </a>
                  <button type="button" class="menu-item" :disabled="activating !== null" @click="activate(b)">
                    <svg
                      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                      stroke-linecap="round" stroke-linejoin="round" class="menu-icon"
                    >
                      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
                      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
                    </svg>
                    <span class="menu-text">
                      <span class="menu-title">
                        {{ activating === b.imageId ? "Rolling back…" : "Roll fleet back to this build" }}
                      </span>
                      <span class="menu-sub">Serve this build to the fleet.</span>
                    </span>
                  </button>

                  <!-- POL-105 — the staged roll-out. A ring pins this build to the machines a tag
                       matches; promoting it makes it the fleet's build and retires the ring. -->
                  <div class="menu-sep"></div>
                  <button type="button" class="menu-item" :disabled="ringBusy" @click="canary(b)">
                    <svg
                      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                      stroke-linecap="round" stroke-linejoin="round" class="menu-icon"
                    >
                      <path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
                      <circle cx="7" cy="7" r="1.2" fill="currentColor" />
                    </svg>
                    <span class="menu-text">
                      <span class="menu-title">Canary this build to a tag…</span>
                      <span class="menu-sub">Only tagged machines boot it. The fleet stays put.</span>
                    </span>
                  </button>
                  <template v-for="ring in ringsByBuild.get(rowKey(b)) ?? []" :key="ring.selector">
                    <button type="button" class="menu-item" :disabled="ringBusy" @click="promote(ring)">
                      <svg
                        width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                        stroke-linecap="round" stroke-linejoin="round" class="menu-icon"
                      >
                        <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
                      </svg>
                      <span class="menu-text">
                        <span class="menu-title">Promote {{ ring.selector }} to the whole fleet</span>
                        <span class="menu-sub">Serve it to everyone and retire the canary.</span>
                      </span>
                    </button>
                    <button type="button" class="menu-item danger" :disabled="ringBusy" @click="dropRing(ring)">
                      <span class="menu-text">
                        <span class="menu-title">Stop the {{ ring.selector }} canary</span>
                        <span class="menu-sub">Those machines rejoin the fleet build.</span>
                      </span>
                    </button>
                  </template>
                </div>
              </template>
            </div>
          </div>
        </div>
        <p v-else class="hint">
          No builds retained yet. Run a build from the ⋯ menu, or with
          <code class="code">deploy/build-live-image.sh</code>.
        </p>

        <!-- What the fleet is ACTUALLY running (POL-105) ------------------------ -->
        <!-- Live: every box reports the image id it booted on hello + every heartbeat, and the
             control plane persists it — so an OFFLINE box still shows the build it is stuck on,
             which is exactly the box a roll-out has stranded. -->
        <div class="field-label field-label-spaced">Fleet versions</div>
        <div v-if="distribution.length > 0" class="versions">
          <div
            v-for="bucket in distribution"
            :key="bucket.imageId ?? 'unknown'"
            class="version-row"
            :class="{ active: bucket.active, stale: bucket.imageId !== null && !bucket.active, unknown: bucket.imageId === null }"
          >
            <div class="version-head">
              <span class="build-id">
                {{ bucket.imageId ? formatImageId(bucket.imageId) : "Not reported" }}
              </span>
              <span v-if="bucket.arch" class="arch">{{ bucket.arch }}</span>
              <span v-if="bucket.active" class="tag tag-accent">Fleet build</span>
              <span
                v-else-if="bucket.imageId && !bucket.retained"
                class="tag tag-muted"
                title="The depot no longer has this build, so these boxes are running something the depot cannot re-serve."
              >
                Pruned
              </span>
              <span v-else-if="bucket.imageId" class="tag tag-muted">Superseded</span>
              <span class="version-count">
                {{ bucket.machines.length }} {{ bucket.machines.length === 1 ? "machine" : "machines" }}
              </span>
            </div>
            <div class="version-machines">
              <span
                v-for="m in bucket.machines"
                :key="m.id"
                class="chip-machine"
                :class="{ offline: !m.online }"
                :title="
                  m.online
                    ? `${m.label} is online${m.tags.length ? `, tagged ${m.tags.join(', ')}` : ''}`
                    : `${m.label} is offline, and the build shown is the last one it reported`
                "
              >
                {{ m.label }}<span v-if="m.tags.length" class="chip-machine-tags">{{ m.tags.join(" · ") }}</span>
              </span>
            </div>
          </div>
        </div>
        <p v-else class="hint">
          No machines have reported an image yet.
        </p>
        <!-- Boot without a USB stick (secondary) -------------------------------- -->
        <button type="button" class="disclosure" :class="{ open: advOpen }" @click="advOpen = !advOpen">
          <span class="caret">›</span>Boot without a USB stick
        </button>
        <div v-if="advOpen && store.netboot" class="adv">
          <div>
            <div class="adv-label"><b>Boot URI</b></div>
            <div class="field-row">
              <div class="mono-field muted ellipsis">{{ store.netboot.baseUrl }}/dist/boot/shimx64.efi</div>
              <button
                type="button"
                class="btn-ghost-sm"
                @click="copy(`${store.netboot.baseUrl}/dist/boot/shimx64.efi`, 'Boot URI copied')"
              >
                Copy
              </button>
            </div>
            <p class="adv-note">Type this into the box's UEFI setup as the HTTP Boot URI (arm64: shimaa64.efi).</p>
          </div>
          <div>
            <div class="adv-label"><b>Control-plane URL</b></div>
            <div class="field-row">
              <div class="mono-field muted ellipsis">{{ store.netboot.baseUrl }}</div>
              <button type="button" class="btn-ghost-sm" @click="copy(store.netboot.baseUrl, 'Control-plane URL copied')">
                Copy
              </button>
            </div>
            <p class="adv-note">The base the bootloader dials. Also what a DHCP option-67 rule hands out.</p>
          </div>
        </div>
      </section>

      <!-- On-screen badges ----------------------------------------------------- -->
      <section v-if="store.isAdmin" class="card">
        <div class="card-head">
          <div class="min-w-0">
            <h2 class="card-title">On-screen badges</h2>
            <p class="card-sub wrap">
              The status badge shown in the corner of every screen. Off in production, on in development.
            </p>
          </div>
          <Toggle
            label="Show on-screen badges"
            :model-value="store.showBadges"
            :disabled="badgesSaving"
            @update:model-value="setBadges"
          />
        </div>
        <div class="badge-preview">
          <div class="badge-chip"><span class="badge-dot" />live · screen-3 · rev</div>
          <span class="hint">
            {{ store.showBadges ? "Shown on every connected screen." : "Hidden on every connected screen." }}
          </span>
        </div>
      </section>

      <!-- UEFI boot order (POL-115) --------------------------------------------- -->
      <section class="card">
        <div class="card-head">
          <div class="min-w-0">
            <h2 class="card-title">Boot order</h2>
            <p class="card-sub wrap">
              Firmware re-prepends its own OS after updates and reflashes, and the box quietly boots the
              wrong thing on its next power-on. Every box watches its own UEFI boot order and reports
              drift here. It only puts itself back at the front if you let it.
            </p>
          </div>
          <Toggle
            label="Re-assert boot order"
            :model-value="store.bootOrder?.reassert ?? false"
            :disabled="bootOrderSaving || store.bootOrder === null"
            @update:model-value="setBootOrderReassert"
          />
        </div>
        <p class="hint">
          {{
            store.bootOrder?.reassert
              ? "Boxes put their own UEFI entry back at the head of the boot order, keep every other entry, and report what the firmware accepted."
              : "Report only. No box writes a firmware boot variable. Drift shows up in Live Activity."
          }}
        </p>
      </section>

      <!-- Enrolment tokens (POL-104) — admin-only (POL-107) ---------------------- -->
      <section v-if="store.isAdmin" class="card">
        <h2 class="card-title">Enrolment tokens</h2>
        <p class="card-sub gap">
          The secrets a new machine presents when it first dials in. Cut one per batch or site, scope it with an
          expiry and a cap, and revoke it on its own, so a lost stick costs you one batch rather than the estate.
        </p>

        <div v-if="store.enrollment === null" class="hint">Loading…</div>

        <template v-else-if="store.enrollmentOpen">
          <div class="open-note">
            <span class="badge-ok">Open mode</span>
            <span>
              Any agent that connects is auto-registered <em>and auto-approved</em>, with no token and no approval. Fine
              on a dev box, never on a real fleet.
            </span>
          </div>
          <button type="button" class="btn-ghost-sm gap-sm" :disabled="busyToken === 'new'" @click="showNewToken = true">
            Gate enrolment with a token
          </button>
        </template>

        <template v-else>
          <ul class="token-list">
            <li v-for="token in store.enrollmentTokens" :key="token.id" class="token" :class="tokenState(token)">
              <div class="token-head">
                <span class="token-name">{{ token.name }}</span>
                <span v-if="token.bake" class="chip chip-bake" title="Baked into /boot/grub.cfg and the next boot medium">
                  On new media
                </span>
                <span v-if="token.legacy" class="chip" title="The original bootstrap token, carried by every medium already flashed">
                  Original
                </span>
                <span class="chip" :class="`chip-${tokenState(token)}`">
                  {{
                    tokenState(token) === "live"
                      ? "Live"
                      : tokenState(token) === "revoked"
                        ? "Revoked"
                        : tokenState(token) === "expired"
                          ? "Expired"
                          : "Used up"
                  }}
                </span>
              </div>
              <div class="token-secret">
                <code class="mono-field">{{ token.secret }}</code>
                <button type="button" class="btn-ghost-sm" @click="copy(token.secret, 'Token copied')">Copy</button>
              </div>
              <p class="hint">{{ tokenScope(token) }}</p>
              <div class="token-actions">
                <button
                  v-if="!token.bake && tokenState(token) === 'live'"
                  type="button"
                  class="btn-ghost-sm"
                  :disabled="busyToken !== null"
                  @click="bakeToken(token)"
                >
                  Bake into new media
                </button>
                <button
                  v-if="tokenState(token) !== 'revoked'"
                  type="button"
                  class="btn-ghost-sm"
                  :disabled="busyToken !== null"
                  @click="rotateToken(token)"
                >
                  Rotate
                </button>
                <button
                  v-if="tokenState(token) !== 'revoked'"
                  type="button"
                  class="btn-ghost-sm danger"
                  :disabled="busyToken !== null"
                  @click="revokeToken(token)"
                >
                  Revoke
                </button>
                <button type="button" class="btn-ghost-sm danger" :disabled="busyToken !== null" @click="deleteToken(token)">
                  Delete
                </button>
              </div>
            </li>
          </ul>

          <p class="hint gap-sm">
            Revoking blocks NEW enrolments only, because a machine that already enrolled holds its own per-machine
            credential and keeps running. Rotating leaves the old secret alive for 24 hours, so media already flashed
            (and boots in flight) still land. Re-bake your boot medium inside that window.
          </p>

          <button type="button" class="btn-ghost-sm gap-sm" @click="showNewToken = !showNewToken">
            {{ showNewToken ? "Cancel" : "New token" }}
          </button>
        </template>

        <form v-if="showNewToken" class="token-form" @submit.prevent="createToken">
          <label class="token-field">
            <span>Name</span>
            <input v-model="newTokenName" type="text" placeholder="Floor 3 rollout" required />
          </label>
          <label class="token-field">
            <span>Expires in (days)</span>
            <input v-model="newTokenExpiryDays" type="number" min="1" placeholder="never" />
          </label>
          <label class="token-field">
            <span>Max machines</span>
            <input v-model="newTokenMax" type="number" min="1" placeholder="unlimited" />
          </label>
          <label class="token-check">
            <input v-model="newTokenBake" type="checkbox" />
            <span>Bake into new boot media</span>
          </label>
          <button type="submit" class="btn-ghost-sm" :disabled="busyToken === 'new' || !newTokenName.trim()">
            {{ busyToken === "new" ? "Creating…" : "Create token" }}
          </button>
        </form>
      </section>

      <!-- HTTPS (POL-70/D89) ----------------------------------------------------- -->
      <!-- Rendered only when THIS listener terminates TLS; behind a TLS-terminating ingress the
           server sees plain HTTP and the certificate story belongs to the ingress/cert-manager. -->
      <section v-if="store.isAdmin && https && https.mode !== 'off'" class="card">
        <h2 class="card-title">HTTPS</h2>

        <template v-if="https.mode === 'provided'">
          <p class="card-sub gap">
            <span class="badge-ok">Native TLS</span>
            Serving HTTPS with the certificate you provided (TLS_CERT_FILE / TLS_KEY_FILE). Nothing to trust here
            because browsers already know your issuer.
          </p>
        </template>

        <template v-else>
          <p class="card-sub gap">
            Serving HTTPS with this deployment's own self-signed certificate. Browsers warn until the Polyptic CA is
            trusted <em>once per device</em>. The certificate persists across restarts, so devices stay green after
            trusting it.
          </p>

          <div class="field-row">
            <code class="mono-field" :title="https.ca?.fingerprintSha256">SHA-256 {{ https.ca?.fingerprintSha256 }}</code>
            <button type="button" class="btn-ghost-sm" :disabled="caDownloading" @click="downloadCa">
              {{ caDownloading ? "Downloading…" : "Download CA certificate" }}
            </button>
          </div>
          <p class="hint gap-sm">Certificate covers: {{ https.sans.join(", ") }}</p>

          <button type="button" class="btn-ghost-sm gap" @click="trustOpen = !trustOpen">
            {{ trustOpen ? "Hide trust instructions" : "How to trust it on your devices" }}
          </button>
          <ul v-if="trustOpen" class="trust-list">
            <li>
              <strong>macOS</strong>: double-click <code>polyptic-ca.crt</code>, add it to the <em>System</em> keychain
              in Keychain Access, open it and set Trust ▸ "Always Trust". Terminal:
              <code>sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain polyptic-ca.crt</code>
            </li>
            <li>
              <strong>Windows</strong>: double-click ▸ Install Certificate ▸ Local Machine ▸ place in
              <em>Trusted Root Certification Authorities</em> (or import there via <code>certmgr.msc</code>).
            </li>
            <li>
              <strong>Linux</strong>:
              <code>sudo cp polyptic-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates</code>.
              Firefox keeps its own store: Settings ▸ Privacy &amp; Security ▸ Certificates ▸ View Certificates ▸ Import.
            </li>
            <li>
              <strong>iOS</strong>: open the file (AirDrop/Mail), install the profile under Settings ▸ General ▸ VPN &amp;
              Device Management, then enable full trust in Settings ▸ General ▸ About ▸ Certificate Trust Settings.
            </li>
            <li>
              <strong>Android</strong>: Settings ▸ Security &amp; privacy ▸ More ▸ Encryption &amp; credentials ▸
              Install a certificate ▸ CA certificate.
            </li>
          </ul>
        </template>
      </section>

      <!-- Agent security (POL-134) ---------------------------------------------- -->
      <section id="sec-agent-security" class="card">
        <h2 class="card-title">Agent security</h2>
        <p class="card-sub wrap gap">
          Machines talk to the control plane over the <strong>agent channel</strong>, which carries the remote shell,
          browser DevTools, screen previews and window placement. Each machine is issued its own certificate
          automatically when it enrols, so only your machines can open that channel. Screens (players) and the boot
          flow have their own separate gates.
        </p>

        <div v-if="agentSec === null" class="hint">Loading…</div>

        <template v-else>
          <div v-if="agentSec.mode === 'off'" class="open-note">
            <span class="asec-badge asec-warn">Off</span>
            <span>
              The certificate channel is not running{{ agentSec.detail ? ` (${agentSec.detail})` : "" }}. Machines
              still authenticate with their enrolment credentials, but the transport is not mutually authenticated.
            </span>
          </div>

          <div v-else-if="agentSec.mode === 'required'" class="open-note">
            <span class="asec-badge asec-ok">Secured</span>
            <span>
              Every live machine connection is certificate-authenticated{{ agentSec.requiredSince ? ` (since ${new Date(agentSec.requiredSince).toLocaleDateString()})` : "" }}.
              New machines still enrol with the enrolment token and are handed a certificate on first contact.
            </span>
          </div>

          <div v-else class="open-note">
            <span class="asec-badge asec-warn">Migrating</span>
            <span>
              Certificates are being handed out. <strong>{{ mtlsMigrated }} of {{ agentSec.machines.length }}</strong>
              machines are on the secure channel, and the rest move over by themselves the next time they connect. Once
              every machine is on the secure channel, it becomes <em>required</em> automatically.
            </span>
          </div>

          <p v-if="agentSec.pinned && agentSec.mode !== 'off'" class="hint gap-sm">
            This posture is pinned by the server's configuration (AGENT_MTLS_REQUIRE) and will not change by itself.
          </p>

          <ul v-if="agentSec.mode !== 'off' && agentSec.machines.length > 0" class="asec-list">
            <li v-for="m in agentSec.machines" :key="m.id" class="asec-row">
              <span class="asec-name">{{ m.label }}</span>
              <!-- POL-143 — when the box reports the mTLS door is unreachable, name the address it
                   tried so the operator can fix the routing, instead of "next connection" forever. -->
              <span v-if="m.mtlsDialError" class="asec-detail">tried {{ m.mtlsDialError.url }}</span>
              <span class="asec-badge" :class="machineCertState(m).cls">{{ machineCertState(m).label }}</span>
            </li>
          </ul>
          <p v-else-if="agentSec.mode !== 'off'" class="hint gap-sm">
            No machines yet. The first box to enrol gets a certificate on its first hello.
          </p>
        </template>
      </section>

      <!-- Update schedule ------------------------------------------------------ -->
      <section v-if="store.isAdmin" id="sec-image" class="card pad-lg">
        <h2 class="card-title">Update schedule</h2>
        <p class="card-sub wrap gap">
          When the live image is refreshed. A nightly in-place refresh picks up userspace fixes, and a weekly full
          rebuild from the base ISO picks up kernel fixes. Netbooted boxes re-pull whenever the published image changes.
        </p>

        <div v-if="store.imageUpdates === null" class="hint">Loading image-update state…</div>

        <template v-else>
          <div class="sched">
            <div class="sched-row">
              <Toggle
                label="Nightly refresh"
                :model-value="store.imageUpdates.scheduleEnabled"
                :disabled="imgSaving"
                @update:model-value="applyImageSettings({ scheduleEnabled: $event })"
              />
              <div class="min-w-0 sched-text">
                <div class="sched-title">Nightly refresh</div>
                <div class="sched-sub">Userspace bug &amp; security fixes, in place.</div>
              </div>
              <input
                class="time-input"
                type="time"
                aria-label="Nightly refresh time"
                :value="store.imageUpdates.scheduleTime"
                :disabled="imgSaving"
                @change="saveTime(($event.target as HTMLInputElement).value, 'scheduleTime')"
              />
            </div>
            <div class="sched-row">
              <Toggle
                label="Weekly full rebuild"
                :model-value="store.imageUpdates.fullScheduleEnabled"
                :disabled="imgSaving"
                @update:model-value="applyImageSettings({ fullScheduleEnabled: $event })"
              />
              <div class="min-w-0 sched-text">
                <div class="sched-title">Full rebuild <span class="sched-title-note">(kernel)</span></div>
                <div class="sched-sub">Weekly rebuild from the base ISO.</div>
              </div>
              <select
                class="select-input"
                aria-label="Full rebuild day"
                :value="store.imageUpdates.fullScheduleDay"
                :disabled="imgSaving"
                @change="applyImageSettings({ fullScheduleDay: Number(($event.target as HTMLSelectElement).value) })"
              >
                <option v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</option>
              </select>
              <input
                class="time-input"
                type="time"
                aria-label="Full rebuild time"
                :value="store.imageUpdates.fullScheduleTime"
                :disabled="imgSaving"
                @change="saveTime(($event.target as HTMLInputElement).value, 'fullScheduleTime')"
              />
            </div>
          </div>

          <div class="rollout" :class="{ urgent: store.imageUpdates.urgent }">
            <svg
              v-if="!store.imageUpdates.urgent"
              width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round" class="rollout-icon"
            >
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            <span v-else class="rollout-icon warn">⚡</span>
            <span v-if="store.imageUpdates.urgent">
              <b>Deploying to the fleet immediately.</b> Every netbooted box on a different image reboots within
              minutes, splayed. Stop it from the ⋯ menu in
              <button type="button" class="link-btn" @click="goToOnboard">Onboard Screens</button>.
            </span>
            <span v-else>
              Boxes roll over to a new image during their local nightly window (03:00–05:00), splayed to avoid a
              fleet-wide reboot. To push a release out faster, use <b>Deploy latest to fleet immediately</b> in
              <button type="button" class="link-btn" @click="goToOnboard">Onboard Screens</button>.
            </span>
          </div>

          <p v-if="!store.imageUpdates.rebuildConfigured" class="hint gap-sm">
            This server has no refresh hook (<code class="code">IMAGE_REBUILD_CMD</code>), so the nightly schedule and
            “Build update” cannot build from here. Set it to e.g.
            <code class="code">deploy/rebuild-image-docker.sh arm64</code>.
          </p>
          <p v-if="!store.imageUpdates.fullRebuildConfigured" class="hint gap-sm">
            The nightly refresh holds the kernel, so kernel fixes need the weekly full rebuild. Configure
            <code class="code">IMAGE_FULL_REBUILD_CMD</code> to enable it.
          </p>
        </template>
      </section>

      <!-- Operators (POL-107) --------------------------------------------------- -->
      <!-- ADMIN-only, and the server agrees: /api/v1/operators** is admin-by-deny-default. -->
      <section v-if="store.isAdmin" id="sec-operators" class="card">
        <h2 class="card-title">Operators</h2>
        <p class="card-sub gap">
          Who can sign in, and what they may do.
          <strong>Admin</strong> runs the fleet (machines, enrolment, image builds, settings).
          <strong>Operator</strong> authors content and layout. <strong>Viewer</strong> reads the
          console and can recall a saved scene. Nothing else.
        </p>

        <div v-if="opsError" class="callout callout-bad"><span class="callout-icon">⚠</span>{{ opsError }}</div>

        <table class="ops-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th class="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="op in operators" :key="op.id">
              <td class="ops-email">
                {{ op.email }}
                <span v-if="op.id === store.currentUser?.id" class="ops-you">you</span>
              </td>
              <td>
                <select
                  class="input ops-role"
                  :value="op.role"
                  :disabled="opsBusy === op.id || op.id === store.currentUser?.id"
                  :title="op.id === store.currentUser?.id ? 'You cannot change your own role' : ''"
                  @change="onRoleChange(op, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="admin">Admin</option>
                  <option value="operator">Operator</option>
                  <option value="viewer">Viewer</option>
                </select>
              </td>
              <td class="right">
                <button
                  type="button"
                  class="btn-ghost-sm"
                  :disabled="opsBusy === op.id || op.id === store.currentUser?.id"
                  :title="op.id === store.currentUser?.id ? 'You cannot remove your own account' : ''"
                  @click="onRemoveOperator(op)"
                >
                  Remove
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="ops-new">
          <div>
            <label class="field-label" for="op-email">Email</label>
            <input id="op-email" v-model="newOp.email" class="input" type="email" autocomplete="off" :disabled="opsCreating" />
          </div>
          <div>
            <label class="field-label" for="op-password">Password</label>
            <input id="op-password" v-model="newOp.password" class="input" type="password" autocomplete="new-password" :disabled="opsCreating" />
          </div>
          <div>
            <label class="field-label" for="op-role">Role</label>
            <select id="op-role" v-model="newOp.role" class="input" :disabled="opsCreating">
              <option value="admin">Admin</option>
              <option value="operator">Operator</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <button type="button" class="btn btn-primary" :disabled="opsCreating" @click="onCreateOperator">
            {{ opsCreating ? "Adding…" : "Add operator" }}
          </button>
        </div>
      </section>

      <!-- Change password ------------------------------------------------------ -->
      <section id="sec-security" class="card">
        <h2 class="card-title">Change password</h2>
        <p class="card-sub gap">Use at least 8 characters.</p>

        <div class="pw-grid">
          <div class="pw-full">
            <label class="field-label" for="pw-current">Current password</label>
            <input
              id="pw-current" v-model="pw.current" class="input" type="password" autocomplete="current-password"
              :disabled="pwSaving" @keyup.enter="onChangePassword"
            />
          </div>
          <div>
            <label class="field-label" for="pw-next">New password</label>
            <input
              id="pw-next" v-model="pw.next" class="input" type="password" autocomplete="new-password"
              :disabled="pwSaving" @keyup.enter="onChangePassword"
            />
          </div>
          <div>
            <label class="field-label" for="pw-confirm">Confirm new password</label>
            <input
              id="pw-confirm" v-model="pw.confirm" class="input" type="password" autocomplete="new-password"
              :disabled="pwSaving" @keyup.enter="onChangePassword"
            />
          </div>
        </div>

        <div v-if="pwError" class="callout callout-bad"><span class="callout-icon">⚠</span>{{ pwError }}</div>
        <div v-if="pwSuccess" class="callout callout-ok"><span class="callout-icon">✓</span>Password changed.</div>

        <button type="button" class="btn btn-primary" :disabled="pwSaving" @click="onChangePassword">
          {{ pwSaving ? "Saving…" : "Change password" }}
        </button>
      </section>

      <!-- Account --------------------------------------------------------------- -->
      <section class="card">
        <h2 class="card-title gap">Account</h2>
        <div class="account">
          <div class="avatar">{{ store.accountInitials }}</div>
          <div class="min-w-0 who">
            <div class="who-name">{{ roleLabel }}</div>
            <div class="who-email">{{ store.currentEmail || "—" }}</div>
          </div>
          <button type="button" class="btn-ghost-sm" :disabled="loggingOut" @click="onSignOut">
            {{ loggingOut ? "Signing out…" : "Sign out" }}
          </button>
        </div>
      </section>
    </div>

    <!-- Make a bootable USB ---------------------------------------------------- -->
    <Transition name="fade">
      <div v-if="usbModal" class="scrim" @click="usbModal = false">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="usb-title" @click.stop>
          <div class="modal-head">
            <span class="icon-tile lg">
              <svg
                width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--fg2)" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <line x1="22" x2="2" y1="12" y2="12" />
                <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                <line x1="6" x2="6.01" y1="16" y2="16" />
              </svg>
            </span>
            <div class="min-w-0 modal-titles">
              <div id="usb-title" class="modal-title">Make a bootable USB</div>
              <div class="modal-sub">
                The bootloader fetches the latest Polyptic image every reboot. Keep the USB inserted, or install the
                bootloader to the screen so it boots on its own.
              </div>
            </div>
            <button type="button" class="icon-btn" aria-label="Close" @click="usbModal = false">
              <svg
                width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <ol class="modal-steps">
            <li class="step">
              <div class="step-gutter"><span class="step-num">1</span><span class="step-line" /></div>
              <div class="step-body">
                <div class="step-title">Insert a USB stick</div>
                <div class="step-text">4 GB or larger. <b>Everything on it will be erased.</b></div>
              </div>
            </li>
            <li class="step">
              <div class="step-gutter"><span class="step-num">2</span><span class="step-line" /></div>
              <div class="step-body">
                <div class="step-title">Flash the bootloader onto it</div>
                <div class="step-text">
                  Open <b>Balena Etcher</b> (free, all platforms), pick
                  <code class="code">polyptic-boot.img</code> and your USB drive, then Flash.
                </div>
                <div class="step-aside">
                  On Windows <b>Rufus</b> works too. Select the image and your drive, leave the defaults, and Start.
                </div>
              </div>
            </li>
            <li class="step">
              <div class="step-gutter"><span class="step-num">3</span><span class="step-line" /></div>
              <div class="step-body">
                <div class="step-title">Wi-Fi screens: add the network credentials</div>
                <div class="step-text">
                  Re-open the flashed stick in your file manager and edit
                  <code class="code">polyptic/wifi.conf</code>, setting <code class="code">WIFI_SSID</code> and
                  <code class="code">WIFI_PSK</code> (the WPA-Enterprise username/password fields are explained
                  inside the file). Screens with a network cable ignore the file, so <b>one stick serves the
                  whole fleet</b>.
                </div>
                <div class="step-aside">
                  Without a cable the screen boots the copy from the USB, joins your Wi-Fi, and streams everything
                  else. The file holds the Wi-Fi password in plain text, so treat the USB like a key to the network.
                </div>
              </div>
            </li>
            <li class="step">
              <div class="step-gutter"><span class="step-num">4</span><span class="step-line" /></div>
              <div class="step-body">
                <div class="step-title">Boot the screen from USB</div>
                <div class="step-text">
                  The screen streams the latest image and appears in <b>Machines</b> to approve.
                </div>
              </div>
            </li>
            <li class="step">
              <div class="step-gutter"><span class="step-num">5</span></div>
              <div class="step-body">
                <div class="step-title">Optional: install Polyptic to the screen's disk</div>
                <div class="step-text">
                  Once the screen is approved, open <b>Machines</b> — a screen booted from the stick wears a
                  <b>Live boot</b> chip. Choose <b>Install</b> on its card to put Polyptic on the internal disk.
                  The screen then boots on its own, and the same stick can walk down the rack.
                </div>
                <div class="step-aside">
                  <b>Installing erases the disk you pick.</b> The dialog names the disk and asks you to confirm it.
                  An installed screen stages updates in the background and applies them on reboot.
                </div>
              </div>
            </li>
          </ol>

          <div class="modal-foot">
            <button type="button" class="btn btn-primary" @click="usbModal = false">Done</button>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scroll-behavior: smooth;
}
.inner {
  max-width: 720px;
  margin: 0 auto;
  padding: 36px 40px 90px;
}
.min-w-0 {
  min-width: 0;
}
.spacer {
  flex: 1;
}
.page-title {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 4px;
}
.page-sub {
  font-size: 13px;
  color: var(--muted);
  margin: 0 0 30px;
}

/* ── Cards ─────────────────────────────────────────────────────────────────── */
.card {
  border-radius: 14px;
  padding: 20px 22px;
  margin-bottom: 16px;
}
.card:last-of-type {
  margin-bottom: 0;
}
/* The two dense cards the design pads a touch taller than the rest. */
.card.pad-lg {
  padding: 22px;
}
.row-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 22px;
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.card-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}
.card-sub {
  font-size: 12.5px;
  color: var(--muted);
  margin: 4px 0 0;
}
.card-sub.wrap {
  max-width: 520px;
  line-height: 1.55;
}
.gap {
  margin-bottom: 16px;
}
.gap-sm {
  margin-top: 10px;
}
.hint {
  font-size: 11.5px;
  color: var(--muted2);
  line-height: 1.55;
  margin: 0;
}

/* The empty-depot notice (POL-121) — louder than a hint, because a fleet that cannot netboot is not
   a detail. Busy while the first image builds; warn-toned while there is no image and none coming. */
.notice {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  line-height: 1.55;
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
}
.notice-busy {
  color: var(--accent-fg);
  background: var(--accent-soft);
}
.notice-warn {
  color: var(--warn);
  background: var(--warn-soft);
}

/* A published medium that cannot boot half the fleet is a warning, not a footnote (POL-122). */
.hint-warn {
  color: var(--warn);
}

/* HTTPS card (POL-70/D89): the per-OS trust steps. Hint-toned so the card stays calm. */
.trust-list {
  margin: 12px 0 0;
  padding-left: 18px;
  display: grid;
  gap: 10px;
  font-size: 12px;
  color: var(--muted2);
  line-height: 1.6;
  max-width: 640px;
}
.trust-list strong {
  color: var(--fg2);
}
.trust-list code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  background: var(--muted-bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 5px;
  overflow-wrap: anywhere;
}
.pill {
  border: none;
  background: transparent;
  font-family: inherit;
}

/* ── ⋯ build menu ──────────────────────────────────────────────────────────── */
.menu-wrap {
  position: relative;
  flex: 0 0 auto;
}
.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.menu-btn:hover,
.menu-btn.open {
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
  top: 38px;
  right: 0;
  z-index: 31;
  min-width: 246px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 11px;
  box-shadow: var(--shadow-lg);
  padding: 6px;
  animation: fadein 0.14s ease;
}
.menu-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: 8px;
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.menu-item:hover:not(:disabled) {
  background: var(--muted-bg);
}
.menu-item.danger:hover:not(:disabled) {
  background: var(--warn-soft);
}
.menu-item:disabled {
  opacity: 0.45;
  cursor: default;
}
.menu-icon {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--muted);
}
.menu-icon.warn {
  color: var(--warn);
}
.menu-text {
  flex: 1;
  min-width: 0;
}
.menu-title {
  display: block;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg);
}
.menu-sub {
  display: block;
  font-size: 11px;
  color: var(--muted2);
  margin-top: 1px;
}
.menu-sep {
  height: 1px;
  background: var(--line);
  margin: 5px 6px;
}

/* ── Network boot loader sub-card ──────────────────────────────────────────── */
.sub-card {
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
  background: var(--surface);
  padding: 18px 20px;
  margin-bottom: 16px;
}
.sub-head {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  margin-bottom: 16px;
}
.icon-tile {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--muted-bg);
}
.icon-tile.lg {
  width: 40px;
  height: 40px;
  border-radius: 11px;
}
.sub-text {
  flex: 1;
}
.sub-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}
.sub-sub {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.45;
}
.dl-row {
  display: flex;
  align-items: stretch;
  gap: 10px;
}
.latest {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  padding: 11px 14px;
  background: var(--muted-bg);
  border-radius: 10px;
}
.latest-label {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted2);
}
.latest-id {
  flex: 1;
  min-width: 0;
  font-family: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: var(--fg2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.latest-id.none {
  color: var(--muted2);
}
.dl-btn {
  flex: 0 0 auto;
  gap: 8px;
  padding: 10px 16px;
  font-size: 12.5px;
  text-decoration: none;
  white-space: nowrap;
}
.dl-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.spinner {
  width: 11px;
  height: 11px;
  border: 2px solid currentcolor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

/* ── Recent builds ─────────────────────────────────────────────────────────── */
.builds {
  border: 1px solid var(--line);
  border-radius: 11px;
  /* NOT overflow:hidden — a row's overflow menu has to escape this box. The rows round their own
     outer corners instead, so the active row's tint still stops at the border radius. */
}
.build-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 14px;
}
.build-row + .build-row {
  border-top: 1px solid var(--line);
}
.build-row:first-child {
  border-radius: 10px 10px 0 0;
}
.build-row:last-child {
  border-radius: 0 0 10px 10px;
}
.build-row:only-child {
  border-radius: 10px;
}
.build-row.active {
  background: var(--accent-soft);
}
.arch {
  flex: 0 0 auto;
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 10.5px;
  font-weight: 600;
  background: var(--muted-bg);
  border: 1px solid var(--line);
  padding: 1px 7px;
  border-radius: 5px;
  color: var(--muted);
}
.build-id {
  flex: 1;
  min-width: 0;
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 12px;
  color: var(--fg2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.build-when {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--muted2);
}
.tag {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 20px;
}
.tag-muted {
  color: var(--muted);
  background: var(--muted-bg);
}
.tag-accent {
  color: var(--accent);
  background: var(--accent-soft);
}

/* ── POL-105: roll-out rings + the fleet's version distribution ───────────────── */
.tag-ring {
  font-family: "Geist Mono", ui-monospace, monospace;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--line);
}
.versions {
  border: 1px solid var(--line);
  border-radius: 11px;
  overflow: hidden;
}
.version-row {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px 14px;
}
.version-row + .version-row {
  border-top: 1px solid var(--line);
}
.version-row.active {
  background: var(--accent-soft);
}
.version-head {
  display: flex;
  align-items: center;
  gap: 9px;
}
.version-count {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--muted2);
}
.version-machines {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip-machine {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 20px;
  border: 1px solid var(--line);
  background: var(--muted-bg);
  color: var(--fg2);
}
/* An offline box is the point of this view, not a footnote: it is the box a roll-out stranded. */
.chip-machine.offline {
  color: var(--muted2);
  border-style: dashed;
}
.chip-machine-tags {
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 10px;
  color: var(--muted);
}
.row-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.row-btn:hover:not(:disabled) {
  background: var(--muted-bg);
  color: var(--fg);
}
.row-btn.open {
  background: var(--muted-bg);
  color: var(--fg);
}
.build-row.active .row-btn:hover {
  /* --muted-bg over the row's accent tint is muddy; the card behind it reads cleaner. */
  background: var(--card);
}
.row-btn.empty {
  cursor: default;
}
.row-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* A row's menu is narrower than the card's, and hangs just under its trigger. */
.menu.menu-row {
  top: 32px;
  min-width: 208px;
}
.menu-row .menu-item {
  align-items: center;
  text-decoration: none;
}
.menu-row .menu-title {
  font-size: 12.5px;
}

/* ── Disclosure: boot without a USB stick ──────────────────────────────────── */
.disclosure {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  margin-top: 20px;
  padding: 16px 0 0;
  border: none;
  border-top: 1px solid var(--line);
  background: none;
  font: inherit;
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
}
.disclosure:hover {
  color: var(--fg2);
}
.caret {
  display: inline-block;
  font-size: 15px;
  transition: transform 0.18s ease;
}
.disclosure.open .caret {
  transform: rotate(90deg);
}
.adv {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 14px;
  animation: fadein 0.2s ease;
}
.adv-label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}
.adv-note {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  margin: 6px 0 0;
}

/* ── Fields, chips, buttons ────────────────────────────────────────────────── */
.field-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.field-label {
  display: block;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 10px;
}
/* A label that follows a bordered list (POL-105's Fleet versions, under Recent builds) needs the
   breathing room the card's own stack does not give it. */
.field-label-spaced {
  margin-top: 20px;
}
.mono-field {
  flex: 1;
  min-width: 0;
  font-family: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12.5px;
  color: var(--fg2);
  background: var(--muted-bg);
  border: 1px solid var(--line);
  padding: 9px 12px;
  border-radius: 9px;
  overflow: hidden;
}
.mono-field.muted {
  font-size: 12px;
  color: var(--muted);
}
.ellipsis {
  white-space: nowrap;
  text-overflow: ellipsis;
}
.code {
  font-family: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11.5px;
  background: var(--muted-bg);
  border: 1px solid var(--line);
  padding: 1px 6px;
  border-radius: 5px;
  white-space: nowrap;
}
.btn-ghost-sm {
  flex: 0 0 auto;
  padding: 9px 14px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  white-space: nowrap;
}
.btn-ghost-sm:hover:not(:disabled) {
  background: var(--muted-bg);
}
.btn-ghost-sm:disabled {
  opacity: 0.55;
  cursor: default;
}
.link-btn {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--accent-fg);
  cursor: pointer;
  text-decoration: underline;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 600;
  padding: 4px 9px;
  border-radius: 20px;
}
.chip-accent {
  color: var(--accent-fg);
  background: var(--accent-soft);
}
.chip-bad {
  color: var(--bad);
  background: var(--bad-soft);
}
.badge-ok {
  flex: 0 0 auto;
  background: var(--ok-soft);
  color: var(--ok);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
}
.open-note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}

/* ── Enrolment tokens (POL-104) ────────────────────────────────────────────── */
.token-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.token {
  border: 1px solid var(--line);
  border-radius: 11px;
  padding: 12px 14px;
  background: var(--surface);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.token.revoked,
.token.expired,
.token.used-up {
  opacity: 0.72;
}
.token-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.token-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.token-secret {
  display: flex;
  align-items: center;
  gap: 8px;
}
.token-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.btn-ghost-sm.danger {
  color: var(--bad);
}
.chip-live {
  color: var(--ok);
  background: var(--ok-soft);
}
.chip-revoked,
.chip-expired,
.chip-used-up {
  color: var(--bad);
  background: var(--bad-soft);
}
.chip-bake {
  color: var(--accent-fg);
  background: var(--accent-soft);
}
.token-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.token-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
}
.token-field input {
  font: inherit;
  font-weight: 400;
  font-size: 12.5px;
  color: var(--fg2);
  background: var(--muted-bg);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 8px 10px;
  min-width: 130px;
}
.token-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  padding-bottom: 9px;
}

/* ── Badges ────────────────────────────────────────────────────────────────── */
.badge-preview {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}
.badge-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 11.5px;
  background: #0d0d10;
  color: #e4e4e7;
  padding: 5px 9px;
  border-radius: 7px;
}
.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
}

/* ── Agent security (POL-134) ──────────────────────────────────────────────── */
.asec-list {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.asec-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  font-size: 12.5px;
}
.asec-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asec-badge {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
}
.asec-ok {
  background: var(--ok-soft);
  color: var(--ok);
}
.asec-warn {
  background: var(--warn-soft);
  color: var(--warn);
}
.asec-bad {
  background: var(--bad-soft);
  color: var(--bad);
}
/* POL-143 — the address a stalled box tried to reach the mTLS door on. */
.asec-detail {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  color: var(--muted);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Update schedule ───────────────────────────────────────────────────────── */
.sched {
  border: 1px solid var(--line);
  border-radius: 11px;
  overflow: hidden;
}
.sched-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
}
.sched-row + .sched-row {
  border-top: 1px solid var(--line);
}
.sched-text {
  flex: 1;
}
.sched-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.sched-title-note {
  font-weight: 400;
  color: var(--muted);
}
.sched-sub {
  font-size: 11.5px;
  color: var(--muted);
  margin-top: 1px;
}
.time-input,
.select-input {
  flex: 0 0 auto;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--fg);
  font-family: inherit;
  font-size: 12.5px;
}
.time-input {
  padding: 7px 9px;
  font-family: "Geist Mono", ui-monospace, monospace;
}
.time-input::-webkit-calendar-picker-indicator {
  filter: var(--pick-filter, none);
  opacity: 0.55;
  cursor: pointer;
}
.select-input {
  -webkit-appearance: none;
  appearance: none;
  padding: 7px 26px 7px 10px;
  cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2371717a' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
}
.time-input:disabled,
.select-input:disabled {
  opacity: 0.55;
}
.rollout {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 16px;
  padding: 12px 16px;
  border-radius: 11px;
  background: var(--muted-bg);
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
}
.rollout.urgent {
  background: var(--warn-soft);
}
.rollout b {
  color: var(--fg2);
  font-weight: 600;
}
.rollout-icon {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--muted2);
}
.rollout-icon.warn {
  color: var(--warn);
  font-size: 13px;
}

/* ── Callouts ──────────────────────────────────────────────────────────────── */
.callout {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.6;
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.callout-icon {
  flex: 0 0 auto;
  font-size: 13px;
}
.callout-bad {
  color: var(--bad);
  background: var(--bad-soft);
}
.callout-ok {
  color: var(--ok);
  background: var(--ok-soft);
}

/* ── Password ──────────────────────────────────────────────────────────────── */
.pw-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 16px;
}
.pw-full {
  grid-column: 1 / -1;
  max-width: 340px;
}
.pw-grid .input {
  padding: 10px 12px;
  font-size: 13.5px;
}
.pw-grid .field-label {
  color: var(--fg2);
  margin-bottom: 6px;
}

/* ── Operators (POL-107) ───────────────────────────────────────────────────── */
.ops-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 18px;
}
.ops-table th {
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
  padding: 0 10px 8px 0;
  border-bottom: 1px solid var(--line);
}
.ops-table td {
  padding: 10px 10px 10px 0;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
  font-size: 13px;
}
.ops-table th.right,
.ops-table td.right {
  text-align: right;
  padding-right: 0;
}
.ops-email {
  font-weight: 500;
}
.ops-you {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  font-size: 10px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.ops-role {
  min-width: 130px;
  padding-top: 6px;
  padding-bottom: 6px;
}
.ops-new {
  display: grid;
  grid-template-columns: 1.6fr 1.2fr 1fr auto;
  gap: 12px;
  align-items: end;
}
@media (max-width: 720px) {
  .ops-new {
    grid-template-columns: 1fr;
  }
}

/* ── Account ───────────────────────────────────────────────────────────────── */
.account {
  display: flex;
  align-items: center;
  gap: 14px;
}
.avatar {
  flex: 0 0 auto;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-fg);
}
.who {
  flex: 1;
}
.who-name {
  font-size: 14px;
  font-weight: 600;
}
.who-email {
  font-size: 12.5px;
  color: var(--muted);
}

/* ── USB modal ─────────────────────────────────────────────────────────────── */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(9, 9, 11, 0.5);
  backdrop-filter: blur(3px);
}
.modal {
  width: 100%;
  max-width: 540px;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
}
.modal-head {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  padding: 22px 24px 0;
}
.modal-titles {
  flex: 1;
}
.modal-title {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.modal-sub {
  font-size: 12.5px;
  color: var(--muted);
  margin-top: 2px;
  line-height: 1.5;
}
.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--muted-bg);
  color: var(--fg);
}
.modal-steps {
  list-style: none;
  margin: 0;
  padding: 20px 24px 4px;
}
.step {
  display: flex;
  gap: 14px;
}
.step-gutter {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 0 0 auto;
}
.step-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 12px;
  font-weight: 600;
}
.step-line {
  flex: 1;
  width: 2px;
  background: var(--line);
  margin: 4px 0;
}
.step-body {
  flex: 1;
  min-width: 0;
  padding-bottom: 18px;
}
.step:last-child .step-body {
  padding-bottom: 0;
}
.step-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 2px;
}
.step-text {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.step-text b,
.step-aside b {
  color: var(--fg2);
  font-weight: 600;
}
.step-aside {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--muted-bg);
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
  padding: 16px 24px 22px;
  border-top: 1px solid var(--line);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.16s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ── Toast ─────────────────────────────────────────────────────────────────── */
.toast {
  position: fixed;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 12.5px;
  font-weight: 500;
  padding: 10px 16px;
  border-radius: 9px;
  box-shadow: var(--shadow-lg);
  z-index: 70;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
