<!--
  Machines.vue — the operator MACHINES view (Phase 3e), ported from the retired SolidJS admin into
  the Vue console. Mirrors docs/design/console.dc.html's MACHINES VIEW.

  Machines are grouped by enrollment status:
    • Pending  — newly dialed-in boxes awaiting a decision: Approve (admits their screens) or Reject
                 (with an optional reason). Surfaced first, with a warning treatment.
    • Approved — admitted machines, online first. Each shows its screens (connectivity dot, inline
                 rename, connector, "Driven by {machine}", per-screen Ident) plus a per-machine
                 "Ident all" and a Revoke. (Revoke reuses the reject endpoint.)
    • Rejected — denied/revoked boxes, kept listed so access can be restored (Re-approve).

  A "Connect a machine" button (and a first-run empty state) opens the cold-start wizard. Screens are
  first-class and named; machines are plumbing — so the rich, per-screen affordances live here.

  Every mutation goes through the Pinia store (approveMachine / rejectMachine / identMachine, and via
  ScreenRow: identScreen / renameScreen). No new endpoints, no direct fetch.
-->
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import type { MachineView } from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";
import { formatLastSeen, countLabel } from "../time";
import ScreenRow from "../components/ScreenRow.vue";
import ColdStartWizard from "../components/ColdStartWizard.vue";

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
});

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

/** A comma-joined list of a machine's screen names (or its output count if none registered yet). */
function drives(m: MachineView): string {
  if (m.screens.length === 0) return countLabel(m.outputCount, "screen");
  return m.screens.map((s) => s.friendlyName).join(", ");
}

/** OTA (POL-28) — a small update-status pill for a machine, or null when there's nothing notable. */
function updatePill(m: MachineView): { text: string; cls: string } | null {
  if (m.needsInstaller) return { text: "needs installer", cls: "warn" };
  const s = m.updateState;
  if (!s || s === "idle" || s === "healthy") {
    return m.targetAgentVersion ? { text: `→ v${m.targetAgentVersion}`, cls: "info" } : null;
  }
  switch (s) {
    case "downloading":
      return { text: "updating…", cls: "info" };
    case "staged":
    case "updating":
      return { text: "rebooting…", cls: "info" };
    case "rolled-back":
      return { text: "rolled back", cls: "bad" };
    case "failed":
      return { text: "update failed", cls: "bad" };
  }
  return null;
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
            anything — approved screens land in the Wall's unplaced tray.
          </p>
        </div>
        <button class="connect-btn" @click="wizardOpen = true">Connect a machine</button>
      </header>

      <!-- first-run empty state -->
      <div v-if="!hasAnyMachine" class="empty">
        <span class="empty-glyph">▤</span>
        <span class="empty-title">No machines yet</span>
        <span class="empty-sub">
          Bring a PC online behind your screens and it appears here for approval. The guided
          first-run setup walks you through it.
        </span>
        <button class="connect-btn ghost" @click="wizardOpen = true">Start first-run setup →</button>
      </div>

      <template v-else>
        <!-- enrolment guidance -->
        <div class="card enrol">
          <div class="enrol-text">
            <div class="enrol-title">Enrolling a machine</div>
            <div class="enrol-sub">
              New machines dial in and present the operator-configured enrolment secret (the agent's
              bootstrap token); if the server runs in open mode, none is required. Once connected, a
              machine appears below as Pending — approve it to admit its screens.
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
                <div class="machine-id">
                  <div class="machine-id-line">
                    <span class="dot" :class="m.online ? 'dot-on' : 'dot-off'"></span>
                    <span class="machine-label">{{ m.label }}</span>
                    <span class="machine-uuid">{{ m.id }}</span>
                  </div>
                  <div class="machine-meta">
                    {{ m.online ? "Online" : "Offline" }} · reports
                    {{ countLabel(m.outputCount, "screen") }} ·
                    {{ m.online ? "just now" : formatLastSeen(m.lastSeen, now) }}
                  </div>
                </div>
                <button class="btn-remove" @click="remove(m)">Remove</button>
                <button class="btn-reject" @click="reject(m)">Reject</button>
                <button class="btn-approve" @click="approve(m)">Approve</button>
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
                <span class="dot" :class="m.online ? 'dot-on' : 'dot-off'"></span>
                <div class="machine-id">
                  <div class="machine-id-line">
                    <span class="machine-label">{{ m.label }}</span>
                    <span v-if="m.agentVersion" class="ver-chip">v{{ m.agentVersion }}</span>
                    <span v-if="updatePill(m)" class="upd-pill" :class="updatePill(m)!.cls">
                      {{ updatePill(m)!.text }}
                    </span>
                    <span class="machine-uuid">{{ m.id }}</span>
                  </div>
                  <div class="machine-meta drives">Drives {{ drives(m) }}</div>
                </div>
                <span class="status-badge" :class="m.online ? 'online' : 'offline'">
                  {{ m.online ? "Online" : "Offline" }}
                </span>
                <span class="last-seen">
                  {{ m.online ? "just now" : formatLastSeen(m.lastSeen, now) }}
                </span>
                <button
                  v-if="m.screens.length"
                  class="btn-ghost-sm"
                  @click="identAll(m)"
                >
                  <span class="ident-dot"></span>Ident all
                </button>
                <button class="btn-revoke" @click="revoke(m)">Revoke</button>
                <button class="btn-remove" @click="remove(m)">Remove</button>
              </div>

              <div v-if="m.screens.length" class="screens">
                <ScreenRow
                  v-for="s in m.screens"
                  :key="s.id"
                  :screen="s"
                  :machine-label="m.label"
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

    <!-- cold-start wizard overlay -->
    <ColdStartWizard :open="wizardOpen" :now="now" @close="wizardOpen = false" />
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
  gap: 12px;
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
}
.machine-uuid {
  font-size: 11px;
  color: var(--muted2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* OTA (POL-28): the running agent version + an update-status pill */
.ver-chip {
  font-size: 10.5px;
  font-weight: 600;
  font-family: var(--mono, ui-monospace, "Geist Mono", monospace);
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--muted-bg);
  color: var(--muted);
  white-space: nowrap;
}
.upd-pill {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 20px;
  white-space: nowrap;
}
.upd-pill.info {
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.upd-pill.warn {
  background: var(--warn-soft);
  color: var(--warn);
}
.upd-pill.bad {
  background: var(--bad-soft);
  color: var(--bad);
}
.machine-meta {
  font-size: 12px;
  color: var(--muted);
  margin-top: 2px;
}
.machine-meta.drives {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
.status-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
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
.btn-ghost-sm:hover {
  background: var(--muted-bg);
}
.ident-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.btn-revoke {
  padding: 7px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}
.btn-revoke:hover {
  background: var(--bad-soft);
  color: var(--bad);
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
</style>
