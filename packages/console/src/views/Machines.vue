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

  POL-117 — machines are NAMED here. Every netbooted box reports the hostname
  `localhost.localdomain`, so the hostname is never the identity: the card shows the operator's name
  (editable in place via MachineName.vue, on pending and approved cards alike) or an honest
  "Unnamed box · <id tail>". Pending cards also get an Ident button — the box flashes its holding
  board so the operator knows which physical panel they're approving.

  Every mutation goes through the Pinia store (approveMachine / rejectMachine / identMachine /
  renameMachine, and via ScreenRow: identScreen / renameScreen / inspectScreen). No new endpoints,
  no direct fetch.
-->
<script setup lang="ts">
import { ref, computed, reactive, onMounted, onUnmounted } from "vue";
import type { MachineView } from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";
import { formatLastSeen, countLabel } from "../time";
import ScreenRow from "../components/ScreenRow.vue";
import ColdStartWizard from "../components/ColdStartWizard.vue";
import MachineName from "../components/MachineName.vue";
import MachineStats from "../components/MachineStats.vue";
import MachineTerminal from "../components/MachineTerminal.vue";
import { machineDisplayName, machineIdTail } from "../machine-name";

const store = useConsoleStore();

const pending = computed(() => store.pendingMachines);
const approved = computed(() => store.approvedMachines);
const rejected = computed(() => store.rejectedMachines);
const hasAnyMachine = computed(() => store.machines.length > 0);

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

/** The note strip's subject: "its screen" / "its 3 screens" / "its screens" (none reported yet). */
function pendingScreensPhrase(m: MachineView): string {
  if (m.outputCount === 1) return "its screen";
  if (m.outputCount > 1) return `its ${m.outputCount} screens`;
  return "its screens";
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
    `Reboot "${machineDisplayName(m)}"? ${what} until it boots back up and reconnects — about a minute.`,
  );
  if (!yes) return;
  const error = await store.rebootMachine(m.id);
  showToast(error ?? `Rebooting ${machineDisplayName(m)}…`);
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
              <div class="machine-row pending-row">
                <div class="machine-id">
                  <div class="machine-id-line">
                    <span class="dot" :class="m.online ? 'dot-on' : 'dot-off'"></span>
                    <!-- POL-117 — name it while it queues: pending boxes are exactly when several
                         identical `localhost.localdomain` machines need telling apart. Boxed here
                         (unlike the approved card's ghost input) — naming is part of approving. -->
                    <MachineName :machine="m" boxed />
                    <span class="machine-hex" :title="m.id">{{ machineIdTail(m.id) }}</span>
                  </div>
                </div>
                <div class="pending-actions">
                  <button class="btn-reject-ghost" @click="reject(m)">Reject</button>
                  <!-- POL-117 — flash the box's holding board so the operator knows WHICH physical
                       panel they are approving. Rides the agent channel; needs the box online. -->
                  <button
                    class="btn-ghost-sm"
                    :disabled="!m.online || identing.has(m.id)"
                    :title="
                      m.online
                        ? 'Flashes a badge on every screen this box drives'
                        : `${machineDisplayName(m)} is offline — nothing to flash`
                    "
                    @click="identPending(m)"
                  >
                    <span class="ident-dot"></span>{{ identing.has(m.id) ? "Identing…" : "Ident" }}
                  </button>
                  <button class="btn-approve pending-approve" @click="approve(m)">Approve</button>
                </div>
              </div>
              <div class="pending-note">
                Nothing plays on this box until you approve it. Once you do,
                {{ pendingScreensPhrase(m) }} will show up in the Unplaced tray, ready to place on
                the wall.
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
                <span class="dot" :class="m.online ? 'dot-on' : 'dot-off'"></span>
                <div class="machine-id">
                  <div class="machine-id-line">
                    <!-- POL-117 — the operator's name is the identity; edit in place. -->
                    <MachineName :machine="m" />
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
                      : `${machineDisplayName(m)} is offline — the console rides its agent connection`
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
                        : `${machineDisplayName(m)} is offline — the console rides its agent connection`
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
                        :title="m.online ? 'Power-cycle this machine' : `${machineDisplayName(m)} is offline — nothing to reboot`"
                        @click="reboot(m)"
                      >
                        Reboot
                      </button>
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

              <div v-if="m.screens.length" class="screens">
                <ScreenRow
                  v-for="s in m.screens"
                  :key="s.id"
                  :screen="s"
                  :machine-label="machineDisplayName(m)"
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
                    <!-- POL-117 — honest fallback; never `localhost.localdomain` posing as a name. -->
                    <span class="machine-label">{{ machineDisplayName(m) }}</span>
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

.pending-note {
  margin-top: 12px;
  font-size: 12px;
  color: var(--warn);
  background: var(--warn-soft);
  padding: 8px 11px;
  border-radius: 8px;
  line-height: 1.5;
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
