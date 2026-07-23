<!--
  Machines.vue — the operator MACHINES view (Phase 3e, decluttered in POL-68). Mirrors the
  "Polyptych Console v2" design's MACHINES VIEW.

  Machines are grouped by enrollment status:
    • Pending  — newly dialed-in boxes awaiting a decision: Approve (admits their screens) or Reject
                 (with an optional reason). Surfaced first, with the v2 mock's full amber treatment
                 (POL-139): a pulsing warn border, a boxed "Name this box" input, a short monospace
                 id tail, ghost Reject → outlined Ident → primary Approve, and an amber note strip.
    • Approved — admitted machines, online first. Each card shows exactly three action clusters
                 (POL-68): [Ident all] · [console button] · [⋯ overflow]. The ⋯ menu holds Reboot and
                 the destructive actions (Revoke access / Remove machine); status chips (Online pill +
                 an amber "Shell armed" security indicator) sit between the name and the actions.
                 Screens are listed below each card (connectivity dot, inline rename, per-screen Ident).
    • Rejected — denied/revoked boxes, kept listed so access can be restored (Re-approve).

  The console button is stateful (POL-68 §3): "Enable console" (bordered) → "Enabling…" while the
  arm round-trips → a split button "Launch console ▾ / Disable console". Launch opens the full-screen
  console view (MachineTerminal); sessions and enable/disable land in the activity feed. Enabling is
  the per-machine shell arm from POL-59 — deliberately NOT fleet-wide, and immediate (no image
  rebuild: the unprivileged shell is always in the image; arming is what gates it).

  Each approved card also carries the POL-92 stats strip (MachineStats.vue): live CPU/memory/disk
  meters from the agent's heartbeat, an overload banner, and the software-rendering tell — the health
  data that previously required a remote shell and `top`.

  A "Connect a machine" button (and a first-run empty state) opens the cold-start wizard. Screens are
  first-class and named; machines are plumbing — so the rich, per-screen affordances live here.

  POL-103 adds GROUPING, because at fifty boxes every fleet action is fifty clicks: tag chips on each
  card (click one to filter to it), a filter box that takes a name OR a selector (`tag=atrium`,
  `tag=floor:2,tag=canary` = AND), checkboxes, and a bulk bar over whichever is active — ident,
  approve, enable/disable console, reboot. Each verb confirms with the blast radius spelled out
  ("Reboot 12 machines?") and reports back what landed ("reboot: 9 of 12 machines · 3 offline"): an
  offline box is an outcome, never a failed call.

  POL-117 — machines are NAMED here. Every netbooted box reports the hostname
  `localhost.localdomain`, so the hostname is never the identity: the card shows the operator's name
  (editable in place via MachineName.vue, on pending and approved cards alike) or an honest
  "Unnamed box · <id tail>". Pending cards also get an Ident button — the box flashes its holding
  board so the operator knows which physical panel they're approving.

  Every mutation goes through the Pinia store (approveMachine / rejectMachine / identMachine /
  setMachineTags / bulkAction / renameMachine, and via ScreenRow: identScreen / renameScreen /
  inspectScreen). No direct fetch.
-->
<script setup lang="ts">
import { ref, computed, reactive, onMounted, onUnmounted } from "vue";
import type { BulkMachineResult, MachineView, PreRegistration } from "@polyptic/protocol";
import { MachineTag, matchesSelector, normalizeTag, parseSelector } from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";
import { formatLastSeen, countLabel } from "../time";
import ScreenRow from "../components/ScreenRow.vue";
import ColdStartWizard from "../components/ColdStartWizard.vue";
import MachineName from "../components/MachineName.vue";
import MachineStats from "../components/MachineStats.vue";
import MachineTerminal from "../components/MachineTerminal.vue";
import { machineCardName, machineDisplayName, machineIdTail } from "../machine-name";
import {
  activeInstall,
  formatDiskSize,
  formatImageId,
  installProgressText,
  installTargets,
  updateReady,
} from "../install";

const store = useConsoleStore();

const hasAnyMachine = computed(() => store.machines.length > 0);

// ── Tags, the filter, and bulk targeting (POL-103) ───────────────────────────
// The filter box takes EITHER a selector (`tag=atrium`, or an AND: `tag=floor:2,tag=canary`) or plain
// text (matched against a machine's name, id, or tags). A selector is also what a bulk verb TARGETS,
// so the same string the operator narrowed the list with is the one the server fans out over.
const filterText = ref("");
const parsed = computed(() =>
  filterText.value.trim() === "" ? null : parseSelector(filterText.value),
);
/** The active selector, when the filter is one AND it parses. */
const selector = computed(() => (parsed.value?.ok ? parsed.value.selector : null));
/** A selector that was clearly INTENDED (starts with `tag`) but doesn't parse — say why, don't guess. */
const selectorError = computed(() =>
  parsed.value && !parsed.value.ok && /^\s*tag\b/i.test(filterText.value) ? parsed.value.error : null,
);

function matchesFilter(m: MachineView): boolean {
  const sel = selector.value;
  if (sel) return matchesSelector(m.tags, sel);
  const q = filterText.value.trim().toLowerCase();
  if (q === "" || selectorError.value) return q === "" ? true : false;
  return (
    m.label.toLowerCase().includes(q) ||
    m.id.toLowerCase().includes(q) ||
    (m.tags ?? []).some((t) => t.includes(q))
  );
}

const pending = computed(() => store.pendingMachines.filter(matchesFilter));
const approved = computed(() => store.approvedMachines.filter(matchesFilter));
const rejected = computed(() => store.rejectedMachines.filter(matchesFilter));
const shown = computed(() => [...pending.value, ...approved.value, ...rejected.value]);
const filtering = computed(() => filterText.value.trim() !== "");

/** Hand-picked machines (the checkboxes). Wins over the selector when non-empty. */
const picked = reactive(new Set<string>());

function togglePick(id: string): void {
  if (picked.has(id)) picked.delete(id);
  else picked.add(id);
}
function pickAllShown(): void {
  for (const m of shown.value) picked.add(m.id);
}
function clearPicks(): void {
  picked.clear();
}

/**
 * The blast radius: exactly the machines a bulk verb would touch. Hand-picked boxes if there are
 * any; otherwise everything the ACTIVE SELECTOR matches. A plain-text filter targets nothing — you
 * cannot reboot a substring search, only a set you named (a selector) or a set you saw (checkboxes).
 */
const targeted = computed<MachineView[]>(() => {
  if (picked.size > 0) return store.machines.filter((m) => picked.has(m.id));
  if (selector.value) return store.machines.filter((m) => matchesSelector(m.tags, selector.value!));
  return [];
});
const targetLabel = computed(() =>
  picked.size > 0 ? `${countLabel(picked.size, "machine")} selected` : (selector.value?.source ?? ""),
);
/** What goes on the wire: the checkbox set, or the selector the operator typed. */
function bulkTarget(): { machineIds: string[] } | { selector: string } {
  if (picked.size > 0) return { machineIds: targeted.value.map((m) => m.id) };
  return { selector: selector.value?.source ?? "" };
}

const BULK_PROMPT: Record<string, (n: string) => string> = {
  reboot: (n) => `Reboot ${n}?`,
  arm: (n) => `Enable the console on ${n}? While enabled, an operator can open an unprivileged terminal on each. Sessions are logged.`,
  disarm: (n) => `Disable the console on ${n}? Any open terminal is closed.`,
  ident: (n) => `Flash the ident overlay on every screen of ${n}?`,
  approve: (n) => `Approve ${n}? Their screens are admitted and land in the Unplaced tray.`,
};

/** One line of truth after a fan-out: what landed, and what did not (offline boxes are NOT a failure). */
function summarize(action: string, results: BulkMachineResult[]): string {
  const applied = results.filter((r) => r.outcome === "applied").length;
  const parts = [`${action}: ${applied} of ${countLabel(results.length, "machine")}`];
  const offline = results.filter((r) => r.outcome === "offline").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  if (offline) parts.push(`${offline} offline`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

async function bulk(action: "reboot" | "arm" | "disarm" | "ident" | "approve"): Promise<void> {
  const machines = targeted.value;
  if (machines.length === 0) return;
  // The confirm NAMES the blast radius — "Reboot 12 machines?" — before anything is sent.
  const yes = window.confirm(BULK_PROMPT[action]!(countLabel(machines.length, "machine")));
  if (!yes) return;

  const result = await store.bulkAction(action, bulkTarget());
  if (typeof result === "string") {
    showToast(result);
    return;
  }
  showToast(summarize(action, result.results));
  clearPicks();
}

/** How many of the targeted machines are still pending — the bulk Approve button's own blast radius. */
const targetedPending = computed(() => targeted.value.filter((m) => m.status === "pending").length);

/**
 * Edit a machine's tags. Free-form and flat ("atrium", "floor:2", "canary"): the selector matches a
 * tag, it never parses one, so `:` is a convention and not a key/value model.
 */
async function editTags(m: MachineView): Promise<void> {
  menuFor.value = null;
  const answer = window.prompt(
    `Tags for "${m.label}", comma-separated (e.g. atrium, floor:2, canary). Empty clears them.`,
    (m.tags ?? []).join(", "),
  );
  if (answer === null) return;

  const tags: string[] = [];
  for (const raw of answer.split(",")) {
    const tag = normalizeTag(raw);
    if (tag === "") continue;
    if (!MachineTag.safeParse(tag).success) {
      showToast(`"${tag}" is not a valid tag. Use a–z, 0–9, and . _ : - (max 32 chars).`);
      return;
    }
    if (!tags.includes(tag)) tags.push(tag);
  }

  const error = await store.setMachineTags(m.id, tags);
  showToast(error ?? (tags.length ? `${m.label} tagged ${tags.join(", ")}` : `${m.label} untagged`));
}

/** Clicking a chip filters to that tag — the one-click path from "I see it" to "I can target it". */
function filterByTag(tag: string): void {
  filterText.value = `tag=${tag}`;
  clearPicks();
}

const wizardOpen = ref(false);

// A ticking clock so "last seen" relative strings stay fresh without a per-row timer.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 1000);
  // POL-104 — pre-registrations ride REST, not admin/state (they are operator-facing config, not
  // desired state the fleet reconciles against).
  void store.fetchPreRegistrations();
});
onUnmounted(() => {
  if (clock) clearInterval(clock);
  window.clearTimeout(toastTimer);
  for (const t of identTimers) window.clearTimeout(t);
});

/** "just now" while online, "rebooting…" while an operator reboot is in flight, else relative. */
function lastSeen(m: MachineView): string {
  if (m.online) return "just now";
  if (m.rebooting) return "rebooting…";
  return formatLastSeen(m.lastSeen, now.value);
}

function approve(m: MachineView): void {
  void store.approveMachine(m.id);
}

// ── POL-104: informative pending cards, bulk approve, pre-registration ─────────

/**
 * The facts an operator needs to tell THIS pending box from the 49 identical ones next to it: where it
 * is dialling from, what it is, and which stick it came in on. All reported by the box (descriptive,
 * never a credential — the enrolment token is what authenticated it). Absent facts are OMITTED, never
 * rendered as a blank or a zero: an older agent reports less, and a card that says nothing beats one
 * that says something untrue.
 */
function hardwareFacts(m: MachineView): { label: string; value: string; mono?: boolean }[] {
  const facts: { label: string; value: string; mono?: boolean }[] = [];
  if (m.ip) facts.push({ label: "IP", value: m.ip, mono: true });
  const macs = m.hardware?.macs ?? [];
  if (macs.length) facts.push({ label: macs.length > 1 ? "MACs" : "MAC", value: macs.join(", "), mono: true });
  if (m.hardware?.dmiSerial) facts.push({ label: "Serial", value: m.hardware.dmiSerial, mono: true });
  const model = [m.hardware?.dmiVendor, m.hardware?.dmiProduct].filter(Boolean).join(" ");
  if (model) facts.push({ label: "Model", value: model });
  if (m.hardware?.arch) facts.push({ label: "Arch", value: m.hardware.arch });
  if (m.enrolledVia) {
    facts.push({
      label: "Enrolled via",
      value: m.enrolledVia.revoked ? `${m.enrolledVia.name} (revoked)` : m.enrolledVia.name,
    });
  }
  return facts;
}

const approvingAll = ref(false);

/** Approve every pending machine. Sequential on purpose: each approval creates screens and bumps the
 *  revision, and a burst of parallel writes buys nothing on a list an operator is watching. */
async function approveAll(): Promise<void> {
  if (approvingAll.value) return;
  const machines = [...pending.value];
  const yes = window.confirm(
    `Approve all ${machines.length} pending machines? Their screens land in the Unplaced tray.`,
  );
  if (!yes) return;
  approvingAll.value = true;
  for (const m of machines) await store.approveMachine(m.id);
  approvingAll.value = false;
}

const showImport = ref(false);
const importCsv = ref("");
const importAutoApprove = ref(true);
const importing = ref(false);
const importErrors = ref<{ line: number; text: string; reason: string }[]>([]);

async function doImport(): Promise<void> {
  if (importing.value || !importCsv.value.trim()) return;
  importing.value = true;
  const result = await store.importPreRegistrations(importCsv.value, importAutoApprove.value);
  importing.value = false;
  if (!result) return;
  importErrors.value = result.errors;
  // Keep the paste on screen when some lines were bad — the operator has to fix THOSE, not retype all.
  if (result.errors.length === 0) {
    importCsv.value = "";
    showImport.value = false;
  }
}

function removePreReg(record: PreRegistration): void {
  const yes = window.confirm(
    record.matchedMachineId
      ? `Remove the pre-registration for "${record.label ?? record.id}"? The machine it already claimed keeps its name and approval.`
      : `Remove the pre-registration for "${record.label ?? record.id}"?`,
  );
  if (yes) void store.removePreRegistration(record.id);
}

function reject(m: MachineView): void {
  const reason = window.prompt(`Reject "${machineDisplayName(m)}"? Optionally add a reason (sent to the agent):`);
  // Cancel (null) aborts; an empty string rejects without a reason.
  if (reason === null) return;
  void store.rejectMachine(m.id, reason);
}

function revoke(m: MachineView): void {
  menuFor.value = null;
  const yes = window.confirm(
    `Revoke "${machineDisplayName(m)}"? Its screens go dark until it is approved again.`,
  );
  if (yes) void store.rejectMachine(m.id);
}

function reapprove(m: MachineView): void {
  void store.approveMachine(m.id);
}

/**
 * Permanently forget a machine (POL-14) — deletes it, its screens, layout + content. Distinct from
 * Revoke (a remembered "rejected" state): a removed machine must be set up again to return.
 */
function remove(m: MachineView): void {
  menuFor.value = null;
  const n = m.screens.length;
  const what = n > 0 ? `its ${countLabel(n, "screen")} plus their layout and content` : "it";
  const yes = window.confirm(
    `Remove "${machineDisplayName(m)}"? This permanently forgets the machine and deletes ${what} from the console. ` +
      `If it reconnects it will have to be set up again.`,
  );
  if (yes) void store.removeMachine(m.id);
}

function identAll(m: MachineView): void {
  void store.identMachine(m.id);
}

// While a pending box's holding board flashes, its Ident button reads "Identing…" and won't
// re-fire. The store flashes a pending box for 12 s (identMachine's pending TTL) — mirror that.
const PENDING_IDENT_MS = 12000;
const identing = reactive(new Set<string>());
const identTimers = new Set<number>();

function identPending(m: MachineView): void {
  if (identing.has(m.id)) return;
  identing.add(m.id);
  void store.identMachine(m.id);
  const timer = window.setTimeout(() => {
    identing.delete(m.id);
    identTimers.delete(timer);
  }, PENDING_IDENT_MS);
  identTimers.add(timer);
}

/**
 * Power-cycle a wedged box (POL-55). Offered only while the machine is online, because the reboot
 * rides its live agent socket — an offline box has nothing to receive it. While it's down the card
 * reads "rebooting…" (the server tracks the in-flight reboot) until the box dials back in.
 */
async function reboot(m: MachineView): Promise<void> {
  menuFor.value = null;
  const n = m.screens.length;
  const what = n > 0 ? `Its ${countLabel(n, "screen")} go dark` : "It goes dark";
  const yes = window.confirm(
    `Reboot "${machineDisplayName(m)}"?`,
  );
  if (!yes) return;
  const error = await store.rebootMachine(m.id);
  showToast(error ?? `Rebooting ${machineDisplayName(m)}…`);
}

/**
 * Sleep or wake EVERY panel a box drives (POL-101). Offered only while the box is online and only if
 * it reported the capability, because panel power rides its live agent socket.
 *
 * Deliberately NOT a confirm-dialog on wake, and a light one on sleep: sleeping a wall is reversible,
 * instant, and non-destructive — the players keep running underneath, so waking puts the content
 * straight back with no reload. What it is NOT is a reboot, and the copy says so.
 */
async function powerAll(m: MachineView, on: boolean): Promise<void> {
  menuFor.value = null;
  if (!on) {
    const n = m.screens.length;
    const yes = window.confirm(
      `Sleep ${m.label}'s ${countLabel(n, "panel")}?` +
        (m.power?.cec
          ? "\n\nThis box has HDMI-CEC, so the displays themselves will power down."
          : "\n\nThis box has no HDMI-CEC, so the outputs go dark but the panels may stay lit."),
    );
    if (!yes) return;
  }
  const error = await store.setMachinePower(m.id, on);
  showToast(error ?? `${on ? "Waking" : "Sleeping"} ${m.label}'s panels…`);
}

/** Do ALL of this box's panels currently read asleep? Drives the single Sleep/Wake menu item. */
function allAsleep(m: MachineView): boolean {
  return m.screens.length > 0 && m.screens.every((s) => s.asleep === true);
}

// ── Install to disk (POL-176) ────────────────────────────────────────────────
// A live-booted box re-streams its whole OS into RAM at every power-cycle. INSTALL puts the OS on
// an internal disk instead — a destructive verb, so the confirm lives INSIDE the dialog: the
// primary button stays disabled until the operator ticks a line that NAMES the disk and the box.
const installFor = ref<MachineView | null>(null);
const installDevice = ref<string | null>(null);
const installAck = ref(false);
const installBusy = ref(false);

const installDisks = computed(() => installTargets(installFor.value?.disks));
const installDisk = computed(
  () => installDisks.value.find((d) => d.device === installDevice.value) ?? null,
);

function openInstall(m: MachineView): void {
  installFor.value = m;
  const targets = installTargets(m.disks);
  // One suitable disk = preselected; several = the operator picks.
  installDevice.value = targets.length === 1 ? targets[0]!.device : null;
  installAck.value = false;
  installBusy.value = false;
}

/** Picking a different disk voids the acknowledgement — it named the OLD disk. */
function pickInstallDisk(device: string): void {
  installDevice.value = device;
  installAck.value = false;
}

function closeInstall(): void {
  installFor.value = null;
}

async function confirmInstall(): Promise<void> {
  const m = installFor.value;
  const disk = installDisk.value;
  if (!m || !disk || !installAck.value || installBusy.value) return;
  installBusy.value = true;
  const error = await store.installMachine(m.id, disk.device);
  installBusy.value = false;
  if (error) {
    showToast(error);
    return;
  }
  installFor.value = null;
  showToast("Installing — progress shows on the machine card");
}

/** Reboot into the STAGED image (POL-176). The reboot itself is the ordinary lifecycle reboot —
 *  the box's loader boots the freshly staged slot — so only the confirm differs from `reboot()`. */
async function applyStaged(m: MachineView): Promise<void> {
  const staged = m.stagedImageId;
  if (!staged) return;
  const yes = window.confirm(
    `Reboot "${machineDisplayName(m)}" into the staged image ${formatImageId(staged)}?`,
  );
  if (!yes) return;
  const error = await store.rebootMachine(m.id);
  showToast(error ?? `Rebooting ${machineDisplayName(m)} into ${formatImageId(staged)}…`);
}

// ── Console lifecycle (POL-59 arm/disarm, POL-68 UI) ─────────────────────────
// A box's console must be ENABLED before an operator can launch a terminal; it is off by default so
// a console compromise can't silently reach a shell on the fleet. The terminal is a full-screen view.
const terminalFor = ref<MachineView | null>(null);
/** Machines whose enable round-trip is in flight — drives the "Enabling…" button state. */
const enabling = reactive(new Set<string>());

async function enableConsole(m: MachineView): Promise<void> {
  if (enabling.has(m.id)) return;
  const yes = window.confirm(
    `Enable the console on "${machineDisplayName(m)}"? While enabled, an operator can open an unprivileged ` +
      `terminal on this box.`,
  );
  if (!yes) return;
  enabling.add(m.id);
  try {
    await store.setMachineShell(m.id, true);
  } finally {
    enabling.delete(m.id);
  }
}

async function disableConsole(m: MachineView): Promise<void> {
  consoleMenuFor.value = null;
  await store.setMachineShell(m.id, false);
  if (terminalFor.value?.id === m.id) terminalFor.value = null;
}

function openTerminal(m: MachineView): void {
  terminalFor.value = m;
}

// ── Menus (⋯ overflow + the console split-button dropdown) ───────────────────
// One of each may be open at a time; a fixed scrim closes them on any outside click.
const menuFor = ref<string | null>(null);
const consoleMenuFor = ref<string | null>(null);

function toggleMenu(id: string): void {
  menuFor.value = menuFor.value === id ? null : id;
  consoleMenuFor.value = null;
}

function toggleConsoleMenu(id: string): void {
  consoleMenuFor.value = consoleMenuFor.value === id ? null : id;
  menuFor.value = null;
}

function closeMenus(): void {
  menuFor.value = null;
  consoleMenuFor.value = null;
}

// The auto-disarm TTL is enforced server-side (SHELL_ARM_TTL_MS, default 60 min); the console can't
// read it, so the hint just reassures the operator that arming is not permanent. `now` keeps it live.
function shellArmedHint(m: MachineView): string {
  if (!m.shellArmedAt) return "The console is enabled on this box";
  const mins = Math.round((now.value - new Date(m.shellArmedAt).getTime()) / 60000);
  return `Console enabled ${mins < 1 ? "just now" : `${mins} min ago`}. Auto-disables when idle`;
}

const toast = ref("");
let toastTimer: number | undefined;
function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  toast.value = message;
  toastTimer = window.setTimeout(() => (toast.value = ""), 2600);
}
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <!-- header -->
      <header class="head">
        <div class="head-text">
          <h1 class="title">Machines</h1>
          <p class="subtitle">
            The physical PCs driving your screens. New machines must be approved before they can show
            anything.
          </p>
        </div>
        <!-- Enrolling a box is an ADMIN flow (approve + the enrolment token are admin-only). -->
        <button v-if="store.isAdmin" class="connect-btn" @click="wizardOpen = true">Connect a machine</button>
      </header>

      <!-- first-run empty state -->
      <div v-if="!hasAnyMachine" class="empty">
        <span class="empty-glyph">▤</span>
        <span class="empty-title">No machines yet</span>
        <span class="empty-sub">
          Boot a machine from the Polyptic bootloader and it appears here for approval.
        </span>
        <button class="connect-btn ghost" @click="wizardOpen = true">Start first-run setup →</button>
      </div>

      <template v-else>
        <!-- filter / selector (POL-103) — a name, or a selector the bulk bar can target -->
        <div class="filter-bar">
          <input
            v-model="filterText"
            class="filter-input"
            type="search"
            placeholder="Filter by name, or a selector (tag=atrium · tag=floor:2,tag=canary)"
            aria-label="Filter machines by name or tag selector"
          />
          <span v-if="selector" class="filter-hint">
            {{ countLabel(shown.length, "machine") }} match {{ selector.source }}
          </span>
          <span v-else-if="filtering" class="filter-hint">
            {{ countLabel(shown.length, "machine") }} match
          </span>
          <button v-if="filtering" class="btn-ghost-sm" @click="filterText = ''">Clear</button>
          <button v-if="shown.length && picked.size < shown.length" class="btn-ghost-sm" @click="pickAllShown">
            Select {{ shown.length }}
          </button>
        </div>
        <div v-if="selectorError" class="selector-error">{{ selectorError }}</div>

        <!-- enrolment guidance -->
        <div class="card enrol">
          <div class="enrol-text">
            <div class="enrol-title">Enrolling a machine</div>
            <div class="enrol-sub">
              Boot a box from the Polyptic bootloader and it streams the live image into RAM then
              dials in and appears below as Pending. Approve it to admit its screens.
            </div>
          </div>
          <button v-if="store.isAdmin" class="connect-btn ghost" @click="wizardOpen = true">Guided setup →</button>
        </div>

        <!-- pending -->
        <section v-if="pending.length" class="section">
          <div class="section-head">
            Pending approval
            <span class="count-badge warn">{{ pending.length }}</span>
            <!-- POL-104 — commissioning a rack was N blind clicks. One click, once you can SEE what
                 you are approving (the facts row below). -->
            <button v-if="pending.length > 1" class="btn-approve-all" :disabled="approvingAll" @click="approveAll">
              {{ approvingAll ? "Approving…" : `Approve all ${pending.length}` }}
            </button>
          </div>
          <div class="stack">
            <div v-for="m in pending" :key="m.id" class="machine pending">
              <div class="machine-row pending-row">
                <input
                  class="pick"
                  type="checkbox"
                  :checked="picked.has(m.id)"
                  :aria-label="`Select ${m.label}`"
                  @change="togglePick(m.id)"
                />
                <div class="machine-id">
                  <div class="machine-id-line">
                    <span class="dot" :class="m.online ? 'dot-on' : 'dot-off'"></span>
                    <!-- POL-117 — name it while it queues: pending boxes are exactly when several
                         identical `localhost.localdomain` machines need telling apart. Boxed here
                         (unlike the approved card's ghost input) — naming is part of approving. -->
                    <MachineName :machine="m" boxed />
                    <span class="machine-hex" :title="m.id">{{ machineIdTail(m.id) }}</span>
                    <!-- POL-104 — a box that named/approved itself from a pre-registration. -->
                    <span v-if="m.preRegistered" class="chip chip-accent" title="Matched a pre-registration">
                      Pre-registered
                    </span>
                  </div>
                </div>
                <!-- POL-107: enrolment is an ADMIN verb (the server 403s these routes for anyone
                     else) — a non-admin sees the pending box, and no way to admit it. -->
                <div v-if="store.isAdmin" class="pending-actions">
                  <button class="btn-reject-ghost" @click="reject(m)">Reject</button>
                  <!-- POL-117 — flash the box's holding board so the operator knows WHICH physical
                       panel they are approving. Rides the agent channel; needs the box online. -->
                  <button
                    class="btn-ghost-sm"
                    :disabled="!m.online || identing.has(m.id)"
                    :title="
                      m.online
                        ? 'Flashes a badge on every screen this box drives'
                        : `${machineDisplayName(m)} is offline. Nothing to flash`
                    "
                    @click="identPending(m)"
                  >
                    <span class="ident-dot"></span>{{ identing.has(m.id) ? "Identing…" : "Ident" }}
                  </button>
                  <button class="btn-approve pending-approve" @click="approve(m)">Approve</button>
                </div>
              </div>
              <!-- tags (POL-103): chips that double as a one-click filter into a selector -->
              <div class="tags">
                <button
                  v-for="t in m.tags"
                  :key="t"
                  class="chip-tag"
                  :title="`Filter to tag=${t}`"
                  @click="filterByTag(t)"
                >
                  {{ t }}
                </button>
                <button class="chip-add" @click="editTags(m)">
                  {{ m.tags.length ? "Edit tags" : "+ Tag" }}
                </button>
              </div>

              <!-- POL-104 — the facts an operator needs to tell THIS box from the 49 next to it.
                   Everything here is reported by the box and is descriptive, never a credential. -->
              <dl v-if="hardwareFacts(m).length" class="facts">
                <div v-for="fact in hardwareFacts(m)" :key="fact.label" class="fact">
                  <dt>{{ fact.label }}</dt>
                  <dd :class="{ mono: fact.mono }">{{ fact.value }}</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <!-- pre-registration (POL-104) -->
        <section class="section">
          <div class="section-head">
            Pre-registered
            <span v-if="store.preRegistrations.length" class="count-muted">
              · {{ store.preRegistrations.length }}
            </span>
            <button class="btn-approve-all ghost" @click="showImport = !showImport">
              {{ showImport ? "Cancel" : "Add boxes" }}
            </button>
          </div>

          <div v-if="showImport" class="card prereg-form">
            <p class="prereg-help">
              One box per line: <code>label, identifier, tag, tag…</code> The identifier is a MAC, a chassis serial,
              or a machine id. A pre-registered box that dials in with a valid enrolment token names itself, takes its
              tags and (below) approves itself, with no clicks. A pre-registration is <strong>not</strong> a credential
              because a box still has to present a valid token to get anywhere.
            </p>
            <textarea
              v-model="importCsv"
              class="prereg-csv"
              rows="5"
              placeholder="Lobby left, aa:bb:cc:dd:ee:01, floor-1, lobby&#10;Lobby right, SN-1234567, floor-1"
            ></textarea>
            <label class="prereg-check">
              <input v-model="importAutoApprove" type="checkbox" />
              <span>Approve these boxes automatically when they enrol</span>
            </label>
            <div class="prereg-actions">
              <button class="btn-approve" :disabled="importing || !importCsv.trim()" @click="doImport">
                {{ importing ? "Adding…" : "Add" }}
              </button>
            </div>
            <ul v-if="importErrors.length" class="prereg-errors">
              <li v-for="e in importErrors" :key="e.line">Line {{ e.line }}: {{ e.reason }} (“{{ e.text }}”)</li>
            </ul>
          </div>

          <div v-if="store.preRegistrations.length" class="stack">
            <div v-for="r in store.preRegistrations" :key="r.id" class="machine prereg">
              <div class="machine-row">
                <div class="machine-id">
                  <div class="machine-id-line">
                    <span class="machine-label">{{ r.label ?? "(unnamed)" }}</span>
                    <span class="machine-uuid">{{ r.mac ?? r.dmiSerial ?? r.machineId }}</span>
                    <span v-if="r.matchedMachineId" class="chip chip-ok" :title="`Matched on ${r.matchedOn}`">
                      Enrolled
                    </span>
                    <span v-else-if="r.autoApprove" class="chip chip-accent">Auto-approve</span>
                    <span v-else class="chip">Manual approval</span>
                  </div>
                  <div class="machine-meta">
                    <template v-if="r.tags.length">{{ r.tags.join(" · ") }} · </template>
                    <template v-if="r.matchedMachineId">claimed by {{ r.matchedMachineId }}</template>
                    <template v-else>waiting for the box to boot</template>
                  </div>
                </div>
                <button class="btn-remove" @click="removePreReg(r)">Remove</button>
              </div>
            </div>
          </div>
          <div v-else class="muted-line">
            No boxes pre-registered.
          </div>
        </section>

        <!-- approved -->
        <section class="section">
          <div class="section-head">
            Approved <span class="count-muted">· {{ approved.length }}</span>
          </div>
          <div v-if="approved.length" class="stack">
            <div v-for="m in approved" :key="m.id" class="machine">
              <div class="machine-row">
                <input
                  class="pick"
                  type="checkbox"
                  :checked="picked.has(m.id)"
                  :aria-label="`Select ${m.label}`"
                  @change="togglePick(m.id)"
                />
                <span class="dot" :class="m.online ? 'dot-on' : 'dot-off'"></span>
                <div class="machine-id">
                  <div class="machine-id-line">
                    <!-- POL-117 — the operator's name is the identity; edit in place. -->
                    <MachineName :machine="m" />
                  </div>
                </div>

                <!-- status chips: Shell armed is a passive security indicator, always visible while
                     armed, independent of the console button state (POL-68 §2). -->
                <span v-if="m.shellEnabled" class="chip-armed" :title="shellArmedHint(m)">Shell armed</span>
                <!-- POL-171 — a wireless box on the local chain is its NORMAL path: a neutral
                     marker, never a warning (the warning strip below is for wired boxes only). -->
                <span
                  v-if="m.bootPath === 'local-wifi'"
                  class="chip-localboot"
                  title="This box boots from its local medium and streams the OS over Wi-Fi — its normal path"
                >Wi-Fi boot</span>
                <!-- POL-176 — HOW the box runs its OS. `live` wears an amber chip (the state the
                     Install button retires); `installed` a quiet neutral one. A box that reports
                     neither (a dev box, an older agent) wears nothing. -->
                <span
                  v-if="m.bootMode === 'live'"
                  class="chip-live"
                  title="This box streams its OS into RAM at every boot. Install to move it onto the internal disk"
                >Live boot</span>
                <span
                  v-else-if="m.bootMode === 'installed'"
                  class="chip-localboot"
                  title="This box boots Polyptic from its internal disk"
                >Installed</span>
                <!-- POL-141 — the id tail, left of the Online pill: uniqueness stays checkable
                     without the full dmi-… UUID (which is on hover). -->
                <span class="id-tail" :title="m.id">{{ machineIdTail(m.id) }}</span>
                <span class="status-badge" :class="m.online ? 'online' : 'offline'">
                  {{ m.online ? "Online" : "Offline" }}
                </span>
                <span class="last-seen">{{ lastSeen(m) }}</span>

                <!-- cluster 1: Ident all — an operator may flash panels; a viewer may not. -->
                <button v-if="m.screens.length && store.canAuthor" class="btn-ghost-sm" @click="identAll(m)">
                  <span class="ident-dot"></span>Ident all
                </button>

                <!-- POL-176 — the INSTALL affordance: only on a live-booted box that is online and
                     has inventoried its disks, and admin-only like the rest of the lifecycle verbs.
                     The destructive confirm lives inside the dialog, not here. Hidden while an
                     install is in flight (the strip below owns the card; the server also 409s a
                     second install, but the button must not invite one). -->
                <button
                  v-if="store.isAdmin && m.bootMode === 'live' && m.online && m.disks?.length && !activeInstall(m)"
                  class="btn-ghost-sm"
                  title="Install Polyptic to this box's internal disk"
                  @click="openInstall(m)"
                >
                  Install
                </button>

                <!-- cluster 2: the stateful console button (POL-68 §3). ADMIN-only (POL-107): a root
                     PTY on a wall box is the most powerful thing this console can do, and the /admin
                     WS refuses the shell frames for any other role. -->
                <button
                  v-if="!m.shellEnabled && store.isAdmin"
                  class="btn-ghost-sm"
                  :disabled="!m.online || enabling.has(m.id)"
                  :title="
                    m.online
                      ? 'Enables an unprivileged debug shell on this box. Sessions are logged to the activity feed'
                      : `${machineDisplayName(m)} is offline, so the console is unavailable`
                  "
                  @click="enableConsole(m)"
                >
                  <template v-if="enabling.has(m.id)">
                    <span class="spinner"></span>Enabling…
                  </template>
                  <template v-else>Enable console</template>
                </button>
                <div v-else-if="store.isAdmin" class="split">
                  <button
                    class="split-main"
                    :disabled="!m.online"
                    :title="
                      m.online
                        ? 'Open a terminal on this machine'
                        : `${machineDisplayName(m)} is offline, so the console is unavailable`
                    "
                    @click="openTerminal(m)"
                  >
                    Launch console
                  </button>
                  <div class="menu-wrap">
                    <button
                      class="split-chev"
                      :class="{ open: consoleMenuFor === m.id }"
                      aria-label="Console actions"
                      :aria-expanded="consoleMenuFor === m.id"
                      @click="toggleConsoleMenu(m.id)"
                    >
                      <svg
                        width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    <template v-if="consoleMenuFor === m.id">
                      <div class="menu-scrim" @click="closeMenus" />
                      <div class="menu menu-console">
                        <button class="menu-item danger" @click="disableConsole(m)">
                          Disable console
                        </button>
                      </div>
                    </template>
                  </div>
                </div>

                <!-- cluster 3: ⋯ overflow (Reboot · Revoke access · Remove machine) -->
                <!-- POL-107 — reboot / revoke / remove are ADMIN verbs. A marketing viewer cannot
                     reboot a box: the button is gone here, and the route 403s regardless. -->
                <div v-if="store.isAdmin" class="menu-wrap">
                  <button
                    class="kebab"
                    :class="{ open: menuFor === m.id }"
                    title="More actions"
                    aria-label="More actions"
                    :aria-expanded="menuFor === m.id"
                    @click="toggleMenu(m.id)"
                  >
                    ⋯
                  </button>
                  <template v-if="menuFor === m.id">
                    <div class="menu-scrim" @click="closeMenus" />
                    <div class="menu">
                      <button
                        v-if="m.power?.dpms"
                        class="menu-item"
                        :disabled="!m.online || !m.screens.length"
                        :title="
                          !m.online
                            ? `${m.label} is offline, so panel power is unavailable`
                            : allAsleep(m)
                              ? 'Wake every panel this machine drives'
                              : m.power?.cec
                                ? 'Sleep every panel. Outputs go dark and the displays power down (HDMI-CEC)'
                                : 'Sleep every panel. Outputs go dark (DPMS; no HDMI-CEC on this box)'
                        "
                        @click="powerAll(m, allAsleep(m))"
                      >
                        {{ allAsleep(m) ? "Wake panels" : "Sleep panels" }}
                      </button>
                      <button
                        class="menu-item"
                        :disabled="!m.online"
                        :title="m.online ? 'Power-cycle this machine' : `${machineDisplayName(m)} is offline. Nothing to reboot`"
                        @click="reboot(m)"
                      >
                        Reboot
                      </button>
                      <div class="menu-sep"></div>
                      <button class="menu-item" @click="editTags(m)">Edit tags</button>
                      <div class="menu-sep"></div>
                      <button class="menu-item danger" @click="revoke(m)">Revoke access</button>
                      <button class="menu-item danger" @click="remove(m)">Remove machine</button>
                    </div>
                  </template>
                </div>
              </div>

              <!-- POL-171 — a wired-capable box that booted via the LOCAL fallback chain. Loud and
                   persistent, not a feed line that scrolls away: the local menu PINS the image, so
                   rebuilds stop reaching this box until its wired chain is fixed. The strip clears
                   itself on the box's next wired-chain boot — no manual dismissal. -->
              <div v-if="m.bootPath === 'local-fallback'" class="fallback-strip">
                <strong>Booted via local fallback</strong> — the wired boot chain failed.
                {{ m.bootPathDetail || "The image this box renders is pinned by the local menu." }}
                Rebuilds are not reaching this box.
              </div>

              <!-- POL-176 — an install running RIGHT NOW: the latest phase line the agent forwarded
                   from the root installer, plus a bar when the phase carries a percentage. `failed`
                   and `done` get their own strips; the server drops the state after ~a minute. -->
              <div v-if="activeInstall(m)" class="install-strip">
                <div>
                  <strong>{{ installProgressText(m.installing!) }}</strong>
                  <span v-if="m.installing!.detail" class="install-detail">{{ m.installing!.detail }}</span>
                </div>
                <div v-if="m.installing!.percent != null" class="install-bar">
                  <div class="install-bar-fill" :style="{ width: `${m.installing!.percent}%` }" />
                </div>
              </div>
              <div v-else-if="m.installing?.phase === 'failed'" class="install-strip failed">
                <strong>Install failed</strong><template v-if="m.installing.detail"> — {{ m.installing.detail }}</template>
              </div>
              <div v-else-if="m.installing?.phase === 'done'" class="install-strip done">
                <strong>Installed</strong> — reboot begins the disk boot.
              </div>

              <!-- POL-176 — the box's own poll staged an image to its inactive slot. Applying it is
                   the ordinary reboot; only the confirm names the staged image. -->
              <div v-if="updateReady(m)" class="install-strip update">
                <span class="update-text">
                  Update ready — image {{ formatImageId(m.stagedImageId!) }} is staged.
                </span>
                <button
                  v-if="store.isAdmin"
                  class="btn-ghost-sm"
                  :disabled="!m.online"
                  :title="m.online ? 'Reboot this box into the staged image' : `${machineDisplayName(m)} is offline. Nothing to reboot`"
                  @click="applyStaged(m)"
                >
                  Reboot to apply
                </button>
              </div>

              <!-- tags (POL-103): chips that double as a one-click filter into a selector -->
              <div v-if="m.tags.length" class="tags">
                <button
                  v-for="t in m.tags"
                  :key="t"
                  class="chip-tag"
                  :title="`Filter to tag=${t}`"
                  @click="filterByTag(t)"
                >
                  {{ t }}
                </button>
              </div>
              <!-- POL-92 — host vitals, live from the heartbeat (CPU/memory/disk, overload, and the
                   software-render tell). Offline machines get the "unavailable" line instead. -->
              <MachineStats :machine="m" />

              <div v-if="m.screens.length" class="screens">
                <ScreenRow
                  v-for="s in m.screens"
                  :key="s.id"
                  :screen="s"
                  :machine-label="machineDisplayName(m)"
                  :machine-online="m.online"
                  :browser="m.browser"
                  :power="m.power"
                  @notify="showToast"
                />
              </div>
              <div v-else class="no-screens">
                Approved, waiting for the agent to report its screens…
              </div>
            </div>
          </div>
          <div v-else class="muted-line">No approved machines yet.</div>
        </section>

        <!-- rejected -->
        <section v-if="rejected.length" class="section">
          <div class="section-head">
            Rejected <span class="count-muted">· {{ rejected.length }}</span>
          </div>
          <div class="stack">
            <div v-for="m in rejected" :key="m.id" class="machine rejected">
              <div class="machine-row">
                <span class="dot dot-off"></span>
                <div class="machine-id">
                  <div class="machine-id-line">
                    <!-- POL-117 — honest fallback; never `localhost.localdomain` posing as a name.
                         POL-141 — the tail lives in the badge, so the card name is badge-aware. -->
                    <span class="machine-label">{{ machineCardName(m) }}</span>
                  </div>
                  <div class="machine-meta">
                    Access denied · {{ formatLastSeen(m.lastSeen, now) }}
                  </div>
                </div>
                <!-- POL-141 — the id tail as a badge, visible to everyone (identity, not a verb). -->
                <span class="id-tail" :title="m.id">{{ machineIdTail(m.id) }}</span>
                <!-- POL-107 — Remove / Re-approve are admin verbs (server 403s otherwise). -->
                <template v-if="store.isAdmin">
                  <button class="btn-remove" @click="remove(m)">Remove</button>
                  <button class="btn-approve" @click="reapprove(m)">Re-approve</button>
                </template>
              </div>
            </div>
          </div>
        </section>
      </template>
    </div>

    <!-- bulk-action bar (POL-103) — visible whenever a selection OR a selector names machines.
         Every verb confirms with the blast radius spelled out ("Reboot 12 machines?") first. -->
    <Transition name="bulkbar">
      <div v-if="targeted.length" class="bulkbar">
        <span class="bulkbar-count">{{ countLabel(targeted.length, "machine") }}</span>
        <span class="bulkbar-target">{{ targetLabel }}</span>
        <div class="bulkbar-actions">
          <button class="bulk-btn" @click="bulk('ident')">Ident all</button>
          <button v-if="targetedPending" class="bulk-btn" @click="bulk('approve')">
            Approve {{ targetedPending }}
          </button>
          <button class="bulk-btn" @click="bulk('arm')">Enable console</button>
          <button class="bulk-btn" @click="bulk('disarm')">Disable console</button>
          <button class="bulk-btn danger" @click="bulk('reboot')">Reboot</button>
        </div>
        <button v-if="picked.size" class="bulk-clear" @click="clearPicks">Clear selection</button>
      </div>
    </Transition>

    <!-- install-to-disk dialog (POL-176) — the disk picker + the in-dialog destructive confirm -->
    <div v-if="installFor" class="scrim" @mousedown.self="closeInstall">
      <div class="modal install-modal" role="dialog" aria-modal="true">
        <div class="modal-title">Install Polyptic to disk</div>
        <p class="install-sub">
          "{{ machineDisplayName(installFor) }}" streams its OS into RAM at every boot. Installing
          puts the OS on the disk picked below; every boot after that starts from the disk, and
          updates are staged in the background and applied on reboot.
        </p>

        <div v-if="installDisks.length" class="disk-list">
          <label
            v-for="d in installDisks"
            :key="d.device"
            class="disk-row"
            :class="{ on: installDevice === d.device }"
          >
            <input
              type="radio"
              name="install-disk"
              :value="d.device"
              :checked="installDevice === d.device"
              @change="pickInstallDisk(d.device)"
            />
            <span class="disk-main">
              <span class="disk-device">{{ d.device }}</span>
              <span class="disk-size">{{ formatDiskSize(d.sizeBytes) }}</span>
              <span v-if="d.model" class="disk-model">{{ d.model }}</span>
            </span>
            <span v-if="d.contents" class="disk-contents">{{ d.contents }}</span>
          </label>
        </div>
        <div v-else class="disk-empty">This box reported no internal disk to install to.</div>

        <label v-if="installDisk" class="install-ack">
          <input v-model="installAck" type="checkbox" />
          <span>
            Erase {{ installDisk.device }} ({{ formatDiskSize(installDisk.sizeBytes) }}) completely
            and install Polyptic on "{{ machineDisplayName(installFor) }}"
          </span>
        </label>

        <div class="modal-actions">
          <button class="btn-secondary" @click="closeInstall">Cancel</button>
          <button
            class="btn-danger"
            :disabled="!installDisk || !installAck || installBusy"
            @click="confirmInstall"
          >
            {{ installBusy ? "Starting…" : "Erase disk and install" }}
          </button>
        </div>
      </div>
    </div>

    <!-- cold-start wizard overlay -->
    <ColdStartWizard :open="wizardOpen" :now="now" @close="wizardOpen = false" />

    <!-- full-screen console (POL-59 shell, POL-68 view) -->
    <MachineTerminal
      v-if="terminalFor"
      :key="terminalFor.id"
      :machine-id="terminalFor.id"
      :machine-label="machineDisplayName(terminalFor)"
      @close="terminalFor = null"
    />

    <Transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.page {
  position: relative;
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.page-inner {
  max-width: 840px;
  margin: 0 auto;
  padding: 30px 32px 60px;
}

/* header */
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
.connect-btn {
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
.connect-btn:hover {
  opacity: 0.92;
}
.connect-btn.ghost {
  background: var(--surface);
  border: 1px solid var(--line2);
  color: var(--fg2);
  box-shadow: var(--shadow-sm);
}
.connect-btn.ghost:hover {
  background: var(--muted-bg);
  opacity: 1;
}

/* empty state */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  padding: 48px 20px;
  border: 1.5px dashed var(--line2);
  border-radius: 13px;
  text-align: center;
}
.empty-glyph {
  font-size: 28px;
  color: var(--muted2);
}
.empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg2);
}
.empty-sub {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.55;
  max-width: 48ch;
}

/* enrolment guidance card */
.enrol {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 18px;
  margin-bottom: 26px;
}
.enrol-text {
  flex: 1;
}
.enrol-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
}
.enrol-sub {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.55;
}

/* sections */
.section {
  margin-bottom: 28px;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
}
.count-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 20px;
}
.count-badge.warn {
  background: var(--warn-soft);
  color: var(--warn);
}
.count-muted {
  color: var(--muted2);
  font-weight: 500;
}
.muted-line {
  font-size: 12.5px;
  color: var(--muted2);
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* machine card */
.machine {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px 16px;
  background: var(--card);
  box-shadow: var(--shadow-sm);
}
/* POL-139 — the v2 mock's pending treatment: a full amber border whose colour and 3px soft glow
   breathe on a 2s cycle. All the card's urgency comes from this pulse + the amber palette. */
.machine.pending {
  border-color: var(--warn);
  padding: 16px 18px;
  animation: pendingPulse 2s ease-in-out infinite;
}
@keyframes pendingPulse {
  0%,
  100% {
    border-color: var(--warn);
    box-shadow: 0 0 0 3px var(--warn-soft);
  }
  50% {
    border-color: var(--warn-soft);
    box-shadow: 0 0 0 0 transparent;
  }
}
@media (prefers-reduced-motion: reduce) {
  .machine.pending {
    animation: none;
  }
}
.pending-row {
  gap: 14px;
}
.pending-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.machine-hex {
  font-size: 11.5px;
  color: var(--muted2);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  white-space: nowrap;
}
/* Boxed name input (MachineName's `boxed` variant) + the pending row's button weights: ghost
   Reject → outlined Ident → primary Approve, escalating left to right per the mock. */
.pending .btn-ghost-sm {
  padding: 8px 13px;
  font-size: 12.5px;
  border-color: var(--line);
  background: transparent;
  box-shadow: none;
}
.pending-approve {
  padding: 8px 18px;
  border-radius: 8px;
  font-size: 12.5px;
}
.machine.rejected {
  opacity: 0.7;
}
.machine-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.machine-id {
  flex: 1;
  min-width: 0;
}
.machine-id-line {
  display: flex;
  align-items: center;
  gap: 9px;
}
.machine-label {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
/* POL-104 — the pre-registration import list still prints a full mac/serial/id in-line. */
.machine-uuid {
  font-size: 11px;
  color: var(--muted2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* POL-141 — the id tail, a small mono badge beside the status pill. The full dmi-… UUID came off
   the name row; hovering the badge still reveals it. */
.id-tail {
  font-size: 10.5px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--muted);
  background: var(--muted-bg);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 2px 7px;
  white-space: nowrap;
  cursor: default;
  flex: 0 0 auto;
}
.machine-meta {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.dot-on {
  background: var(--ok);
}
.dot-off {
  background: var(--muted2);
}

/* status chips */
.chip-armed {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  color: var(--warn);
  background: var(--warn-soft);
  white-space: nowrap;
  flex: 0 0 auto;
}
.chip-localboot {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  color: var(--muted);
  background: var(--muted-bg);
  white-space: nowrap;
  flex: 0 0 auto;
}
/* POL-171 — the local-fallback warning strip: a full-width band in the warn palette, matching the
   pending card's warn accents. Deliberately a strip, not a chip: this state means the box is
   quietly running a stale image, and it must read at a glance across the room. */
.fallback-strip {
  margin-top: 10px;
  padding: 9px 13px;
  border-radius: 9px;
  border: 1px solid var(--warn);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 12.5px;
  line-height: 1.45;
}
/* POL-176 — the amber "Live boot" chip: attention, not alarm. Same warn palette as Shell armed,
   because both mark a state the operator may want to retire (there, disarm; here, Install). The
   "Installed" chip reuses .chip-localboot's neutral look. */
.chip-live {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  color: var(--warn);
  background: var(--warn-soft);
  white-space: nowrap;
  flex: 0 0 auto;
}
/* POL-176 — the install strips: neutral while running, bad on failure, ok when done, and the
   accent-tinted "update ready" band. Strips (not chips) for the same reason the fallback strip is
   one: this state must read at a glance across the room. */
.install-strip {
  margin-top: 10px;
  padding: 9px 13px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--muted-bg);
  color: var(--fg2);
  font-size: 12.5px;
  line-height: 1.45;
}
.install-strip.failed {
  border-color: var(--bad);
  background: var(--bad-soft);
  color: var(--bad);
}
.install-strip.done {
  border-color: var(--ok);
  background: var(--ok-soft);
  color: var(--ok);
}
.install-strip.update {
  display: flex;
  align-items: center;
  gap: 10px;
}
.update-text {
  flex: 1;
  min-width: 0;
}
.install-detail {
  color: var(--muted);
  margin-left: 8px;
}
.install-bar {
  margin-top: 7px;
  height: 5px;
  border-radius: 3px;
  background: var(--line);
  overflow: hidden;
}
.install-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.4s ease;
}

.status-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
  flex: 0 0 auto;
}
.status-badge.online {
  background: var(--ok-soft);
  color: var(--ok);
}
.status-badge.offline {
  background: var(--muted-bg);
  color: var(--muted);
}
.last-seen {
  font-size: 11.5px;
  color: var(--muted2);
  white-space: nowrap;
}

/* buttons */
.btn-approve {
  padding: 9px 17px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.btn-approve:hover {
  opacity: 0.92;
}
/* Reject is a ghost button — quiet until hovered, when it turns destructive. */
.btn-reject-ghost {
  padding: 8px 13px;
  border-radius: 8px;
  border: none;
  background: none;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}
.btn-reject-ghost:hover {
  background: var(--bad-soft);
  color: var(--bad);
}
.btn-ghost-sm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
  box-shadow: var(--shadow-sm);
}
.btn-ghost-sm:hover:not(:disabled) {
  background: var(--muted-bg);
}
.btn-ghost-sm:disabled {
  opacity: 0.55;
  cursor: default;
}
.ident-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.btn-remove {
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid var(--bad-line, var(--line2));
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--bad);
  cursor: pointer;
  font-family: inherit;
}
.btn-remove:hover {
  background: var(--bad-soft);
  border-color: var(--bad);
}

/* the console split button (POL-68 §3) */
.split {
  display: flex;
  flex: 0 0 auto;
}
.split-main {
  padding: 7px 12px;
  border-radius: 8px 0 0 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
  box-shadow: var(--shadow-sm);
}
.split-main:hover:not(:disabled) {
  background: var(--muted-bg);
}
.split-main:disabled {
  opacity: 0.55;
  cursor: default;
}
.split-chev {
  width: 26px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0 8px 8px 0;
  border: 1px solid var(--line2);
  border-left: none;
  background: var(--surface);
  font-size: 9px;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
  box-shadow: var(--shadow-sm);
}
.split-chev:hover,
.split-chev.open {
  background: var(--muted-bg);
  color: var(--fg);
}

/* the spinner inside "Enabling…" */
.spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid currentcolor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ⋯ overflow + dropdown menus */
.menu-wrap {
  position: relative;
  flex: 0 0 auto;
  display: flex;
}
.kebab {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 14px;
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
  top: 36px;
  right: 0;
  z-index: 31;
  width: 190px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 5px;
  animation: fadein 0.12s ease;
}
.menu.menu-console {
  top: 34px;
  width: 170px;
}
.menu-item {
  display: block;
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
.menu-item.danger {
  color: var(--bad);
}
.menu-item.danger:hover:not(:disabled) {
  background: var(--bad-soft);
}
.menu-sep {
  height: 1px;
  background: var(--line);
  margin: 5px 4px;
}
@keyframes fadein {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ── POL-104: pending hardware facts + pre-registration ─────────────────────── */
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  margin: 12px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--muted-bg);
}
.fact {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}
.fact dt {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--muted2);
}
.fact dd {
  margin: 0;
  font-size: 12px;
  color: var(--fg2);
  overflow-wrap: anywhere;
}
.fact dd.mono {
  font-family: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11.5px;
}
.btn-approve-all {
  margin-left: auto;
  padding: 5px 12px;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.btn-approve-all.ghost {
  border-color: var(--line);
  background: var(--surface);
  color: var(--fg2);
  font-weight: 500;
}
.btn-approve-all:disabled {
  opacity: 0.55;
  cursor: default;
}
.machine.prereg {
  border-left: 3px solid var(--line);
}
.prereg-form {
  padding: 14px 16px;
  margin-bottom: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.prereg-help {
  margin: 0;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.55;
}
.prereg-csv {
  font-family: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: var(--fg2);
  background: var(--muted-bg);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 10px 12px;
  resize: vertical;
}
.prereg-check {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--muted);
}
.prereg-actions {
  display: flex;
  gap: 8px;
}
.prereg-errors {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--bad);
}
.chip {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  background: var(--muted-bg);
  color: var(--muted);
}
.chip-accent {
  color: var(--accent-fg);
  background: var(--accent-soft);
}
.chip-ok {
  color: var(--ok);
  background: var(--ok-soft);
}

/* screens under an approved machine */
.screens {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 13px;
  padding-top: 13px;
  border-top: 1px solid var(--line);
}
.no-screens {
  margin-top: 12px;
  font-size: 12px;
  color: var(--muted2);
}

/* filter / selector (POL-103) */
.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.filter-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border-radius: 9px;
  border: 1px solid var(--line2);
  background: var(--surface);
  color: var(--fg);
  font-size: 12.5px;
  font-family: inherit;
}
.filter-input:focus {
  outline: none;
  border-color: var(--primary);
}
.filter-hint {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.selector-error {
  font-size: 12px;
  color: var(--bad);
  background: var(--bad-soft);
  padding: 7px 11px;
  border-radius: 8px;
  margin: -6px 0 14px;
}

/* per-card selection checkbox */
.pick {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  accent-color: var(--primary);
  cursor: pointer;
}

/* tag chips */
.tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.chip-tag,
.chip-add {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  border: 1px solid var(--line2);
  background: var(--muted-bg);
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}
.chip-tag:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.chip-add {
  background: none;
  border-style: dashed;
  color: var(--muted);
  font-weight: 500;
}
.chip-add:hover {
  color: var(--fg2);
}

/* bulk-action bar */
.bulkbar {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px 9px 16px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: var(--card);
  box-shadow: var(--shadow-lg);
  max-width: min(92vw, 860px);
}
.bulkbar-count {
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
}
.bulkbar-target {
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bulkbar-actions {
  display: flex;
  gap: 6px;
}
.bulk-btn {
  padding: 7px 11px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
}
.bulk-btn:hover {
  background: var(--muted-bg);
}
.bulk-btn.danger {
  color: var(--bad);
}
.bulk-btn.danger:hover {
  background: var(--bad-soft);
  border-color: var(--bad);
}
.bulk-clear {
  border: none;
  background: none;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
  white-space: nowrap;
}
.bulk-clear:hover {
  color: var(--fg2);
}
.bulkbar-enter-active,
.bulkbar-leave-active {
  transition: opacity 0.18s ease;
}
.bulkbar-enter-from,
.bulkbar-leave-to {
  opacity: 0;
}

/* ── POL-176: the install-to-disk dialog ────────────────────────────────────── */
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
.install-modal {
  width: 480px;
}
.install-sub {
  margin: -10px 0 16px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.55;
}
.disk-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}
.disk-row {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 10px;
  row-gap: 3px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  cursor: pointer;
}
.disk-row.on {
  border-color: var(--primary);
}
.disk-row input {
  grid-row: 1 / span 2;
  accent-color: var(--primary);
  cursor: pointer;
}
.disk-main {
  display: flex;
  align-items: baseline;
  gap: 9px;
  min-width: 0;
}
.disk-device {
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
  font-weight: 600;
}
.disk-size {
  font-size: 12px;
  color: var(--fg2);
  white-space: nowrap;
}
.disk-model {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.disk-contents {
  grid-column: 2;
  font-size: 11.5px;
  color: var(--muted2);
  overflow-wrap: anywhere;
}
.disk-empty {
  font-size: 12.5px;
  color: var(--muted2);
  margin-bottom: 16px;
}
/* The in-dialog destructive confirm: ticking it is what arms the primary button. */
.install-ack {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12.5px;
  color: var(--fg2);
  line-height: 1.5;
  margin-bottom: 18px;
  cursor: pointer;
}
.install-ack input {
  margin-top: 2px;
  flex: 0 0 auto;
  accent-color: var(--bad);
  cursor: pointer;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.btn-secondary {
  padding: 9px 15px;
  border-radius: 9px;
  border: 1px solid var(--line2);
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
.btn-danger {
  padding: 9px 17px;
  border-radius: 9px;
  border: none;
  background: var(--bad);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.btn-danger:hover:not(:disabled) {
  opacity: 0.92;
}
.btn-danger:disabled {
  opacity: 0.45;
  cursor: default;
}

/* toast (reboot feedback) */
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
  /* Above the install dialog's scrim (300): the dialog's error toasts must be readable over it. */
  z-index: 400;
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
