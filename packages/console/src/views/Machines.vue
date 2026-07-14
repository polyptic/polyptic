<!--
  Machines.vue — the operator MACHINES view (Phase 3e, decluttered in POL-68). Mirrors the
  "Polyptych Console v2" design's MACHINES VIEW.

  Machines are grouped by enrollment status:
    • Pending  — newly dialed-in boxes awaiting a decision: Approve (admits their screens) or Reject
                 (with an optional reason). Surfaced first, with a warning treatment.
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

  Every mutation goes through the Pinia store (approveMachine / rejectMachine / identMachine /
  setMachineTags / bulkAction, and via ScreenRow: identScreen / renameScreen / inspectScreen). No
  direct fetch.
-->
<script setup lang="ts">
import { ref, computed, reactive, onMounted, onUnmounted } from "vue";
import type { BulkMachineResult, MachineView } from "@polyptic/protocol";
import { MachineTag, matchesSelector, normalizeTag, parseSelector } from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";
import { formatLastSeen, countLabel } from "../time";
import ScreenRow from "../components/ScreenRow.vue";
import ColdStartWizard from "../components/ColdStartWizard.vue";
import MachineStats from "../components/MachineStats.vue";
import MachineTerminal from "../components/MachineTerminal.vue";

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
  reboot: (n) => `Reboot ${n}? Their screens go dark until they boot back up — about a minute.`,
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
    `Tags for "${m.label}" — comma-separated (e.g. atrium, floor:2, canary). Empty clears them.`,
    (m.tags ?? []).join(", "),
  );
  if (answer === null) return;

  const tags: string[] = [];
  for (const raw of answer.split(",")) {
    const tag = normalizeTag(raw);
    if (tag === "") continue;
    if (!MachineTag.safeParse(tag).success) {
      showToast(`"${tag}" is not a valid tag — use a–z, 0–9, and . _ : - (max 32 chars).`);
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
});
onUnmounted(() => {
  if (clock) clearInterval(clock);
  window.clearTimeout(toastTimer);
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

function reject(m: MachineView): void {
  const reason = window.prompt(`Reject "${m.label}"? Optionally add a reason (sent to the agent):`);
  // Cancel (null) aborts; an empty string rejects without a reason.
  if (reason === null) return;
  void store.rejectMachine(m.id, reason);
}

function revoke(m: MachineView): void {
  menuFor.value = null;
  const yes = window.confirm(
    `Revoke "${m.label}"? Its screens go dark until it is approved again.`,
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
    `Remove "${m.label}"? This permanently forgets the machine and deletes ${what} from the console. ` +
      `If it reconnects it will have to be set up again.`,
  );
  if (yes) void store.removeMachine(m.id);
}

function identAll(m: MachineView): void {
  void store.identMachine(m.id);
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
    `Reboot "${m.label}"? ${what} until it boots back up and reconnects — about a minute.`,
  );
  if (!yes) return;
  const error = await store.rebootMachine(m.id);
  showToast(error ?? `Rebooting ${m.label}…`);
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
    `Enable the console on "${m.label}"? While enabled, an operator can open an unprivileged ` +
      `terminal on this box. It cannot change what the screen displays. Sessions are logged to the ` +
      `activity feed. Disable it when you're done.`,
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
  return `Console enabled ${mins < 1 ? "just now" : `${mins} min ago`} — auto-disables when idle`;
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
        <button class="connect-btn" @click="wizardOpen = true">Connect a machine</button>
      </header>

      <!-- first-run empty state -->
      <div v-if="!hasAnyMachine" class="empty">
        <span class="empty-glyph">▤</span>
        <span class="empty-title">No machines yet</span>
        <span class="empty-sub">
          Boot a PC behind your screens from the Polyptic bootloader and it appears here for
          approval. The guided first-run setup walks you through it.
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
            placeholder="Filter by name, or a selector — tag=atrium · tag=floor:2,tag=canary"
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
          <button class="connect-btn ghost" @click="wizardOpen = true">Guided setup →</button>
        </div>

        <!-- pending -->
        <section v-if="pending.length" class="section">
          <div class="section-head">
            Pending approval
            <span class="count-badge warn">{{ pending.length }}</span>
          </div>
          <div class="stack">
            <div v-for="m in pending" :key="m.id" class="machine pending">
              <div class="machine-row">
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
                    <span class="machine-label">{{ m.label }}</span>
                    <span class="machine-uuid">{{ m.id }}</span>
                  </div>
                  <div class="machine-meta">
                    {{ m.online ? "Online" : "Offline" }} · reports
                    {{ countLabel(m.outputCount, "screen") }} · {{ lastSeen(m) }}
                  </div>
                </div>
                <button class="btn-remove" @click="remove(m)">Remove</button>
                <button class="btn-reject" @click="reject(m)">Reject</button>
                <button class="btn-approve" @click="approve(m)">Approve</button>
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

              <div class="pending-note">
                Not yet admitted — shows nothing until you approve it. Its
                {{ countLabel(m.outputCount, "screen") }} will land in the Unplaced tray.
              </div>
            </div>
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
                    <span class="machine-label">{{ m.label }}</span>
                    <span class="machine-uuid">{{ m.id }}</span>
                  </div>
                </div>

                <!-- status chips: Shell armed is a passive security indicator, always visible while
                     armed, independent of the console button state (POL-68 §2). -->
                <span v-if="m.shellEnabled" class="chip-armed" :title="shellArmedHint(m)">Shell armed</span>
                <span class="status-badge" :class="m.online ? 'online' : 'offline'">
                  {{ m.online ? "Online" : "Offline" }}
                </span>
                <span class="last-seen">{{ lastSeen(m) }}</span>

                <!-- cluster 1: Ident all -->
                <button v-if="m.screens.length" class="btn-ghost-sm" @click="identAll(m)">
                  <span class="ident-dot"></span>Ident all
                </button>

                <!-- cluster 2: the stateful console button (POL-68 §3) -->
                <button
                  v-if="!m.shellEnabled"
                  class="btn-ghost-sm"
                  :disabled="!m.online || enabling.has(m.id)"
                  :title="
                    m.online
                      ? 'Enables an unprivileged debug shell on this box — sessions are logged to the activity feed'
                      : `${m.label} is offline — the console rides its agent connection`
                  "
                  @click="enableConsole(m)"
                >
                  <template v-if="enabling.has(m.id)">
                    <span class="spinner"></span>Enabling…
                  </template>
                  <template v-else>Enable console</template>
                </button>
                <div v-else class="split">
                  <button
                    class="split-main"
                    :disabled="!m.online"
                    :title="
                      m.online
                        ? 'Open a terminal on this machine'
                        : `${m.label} is offline — the console rides its agent connection`
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
                <div class="menu-wrap">
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
                        class="menu-item"
                        :disabled="!m.online"
                        :title="m.online ? 'Power-cycle this machine' : `${m.label} is offline — nothing to reboot`"
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

              <!-- POL-92 — host vitals, live from the heartbeat (CPU/memory/disk, overload, and the
                   software-render tell). Offline machines get the "unavailable" line instead. -->
              <MachineStats :machine="m" />

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

              <div v-if="m.screens.length" class="screens">
                <ScreenRow
                  v-for="s in m.screens"
                  :key="s.id"
                  :screen="s"
                  :machine-label="m.label"
                  :machine-online="m.online"
                  :browser="m.browser"
                  @notify="showToast"
                />
              </div>
              <div v-else class="no-screens">
                Approved — waiting for the agent to report its screens…
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
                    <span class="machine-label">{{ m.label }}</span>
                    <span class="machine-uuid">{{ m.id }}</span>
                  </div>
                  <div class="machine-meta">
                    Access denied · {{ formatLastSeen(m.lastSeen, now) }}
                  </div>
                </div>
                <button class="btn-remove" @click="remove(m)">Remove</button>
                <button class="btn-approve" @click="reapprove(m)">Re-approve</button>
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

    <!-- cold-start wizard overlay -->
    <ColdStartWizard :open="wizardOpen" :now="now" @close="wizardOpen = false" />

    <!-- full-screen console (POL-59 shell, POL-68 view) -->
    <MachineTerminal
      v-if="terminalFor"
      :key="terminalFor.id"
      :machine-id="terminalFor.id"
      :machine-label="terminalFor.label"
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
.machine.pending {
  border-color: var(--warn-soft);
  border-left: 3px solid var(--warn);
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
.machine-uuid {
  font-size: 11px;
  color: var(--muted2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
.btn-reject {
  padding: 9px 15px;
  border-radius: 9px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 13px;
  font-weight: 500;
  color: var(--bad);
  cursor: pointer;
  font-family: inherit;
}
.btn-reject:hover {
  background: var(--bad-soft);
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

.pending-note {
  margin-top: 11px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-soft);
  padding: 8px 11px;
  border-radius: 8px;
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
