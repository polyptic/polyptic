<!--
  Fleet.vue — the operator UPDATES view (OTA, POL-28). Drives the depot-wide agent version:

    • Release banner — the agent version the depot can serve, + a breakdown of what the fleet runs now.
    • Start a rollout — all-at-once, or a canary (pick boxes) with manual or auto-after-soak promotion.
    • Rollout in progress — live wave status (per-box version + self-update state) with Promote / Pause /
      Resume / Roll back / Clear.

  Every mutation goes through the Pinia store (startRollout / promoteRollout / …); the server broadcasts
  the authoritative rollout state on admin/state, so the UI reconciles live. Screens are first-class,
  machines are plumbing — but the agent BINARY is per-machine, so versioning lives here, by machine.
-->
<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import type { MachineView } from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";

const store = useConsoleStore();

const release = computed(() => store.agentRelease);
const rollout = computed(() => store.rollout);
const approved = computed(() => store.approvedMachines);
const breakdown = computed(() => store.agentVersionBreakdown);
const behind = computed(() => store.machinesBehindRelease);

// ── start-rollout form state (only meaningful when no rollout is running) ──
const strategy = ref<"all" | "canary">("all");
const promotion = ref<"manual" | "auto">("manual");
const canaryPicks = reactive<Record<string, boolean>>({});
const busy = ref(false);

const canaryIds = computed(() => Object.keys(canaryPicks).filter((id) => canaryPicks[id]));
const canStart = computed(
  () =>
    !!release.value &&
    behind.value.length > 0 &&
    (strategy.value === "all" || canaryIds.value.length > 0),
);

async function start(): Promise<void> {
  if (!release.value || !canStart.value) return;
  busy.value = true;
  await store.startRollout({
    version: release.value.version,
    strategy: strategy.value,
    canaryMachineIds: strategy.value === "canary" ? canaryIds.value : [],
    promotion: promotion.value,
  });
  busy.value = false;
}

async function promote(): Promise<void> {
  await store.promoteRollout();
}
async function pause(): Promise<void> {
  await store.pauseRollout();
}
async function resume(): Promise<void> {
  await store.resumeRollout();
}
async function rollback(): Promise<void> {
  const prev = "the previous version";
  if (window.confirm(`Roll the whole fleet back to ${prev}? Boxes reactivate their retained slot and reboot.`)) {
    await store.rollbackRollout();
  }
}
async function clearRollout(): Promise<void> {
  await store.cancelRollout();
}

// ── live rollout progress ──
const target = computed(() => rollout.value?.targetVersion ?? release.value?.version);
const canarySet = computed(() => new Set(rollout.value?.canaryMachineIds ?? []));
const isCanary = computed(() => rollout.value?.strategy === "canary");

const wave1 = computed<MachineView[]>(() =>
  isCanary.value ? approved.value.filter((m) => canarySet.value.has(m.id)) : approved.value,
);
const wave2 = computed<MachineView[]>(() =>
  isCanary.value ? approved.value.filter((m) => !canarySet.value.has(m.id)) : [],
);

const onTargetCount = computed(
  () => approved.value.filter((m) => m.agentVersion === target.value).length,
);
const soakMinutes = computed(() =>
  rollout.value?.soakRemainingMs != null ? Math.ceil(rollout.value.soakRemainingMs / 60000) : null,
);

/** A short, human status pill for one machine's OTA state. */
function statusPill(m: MachineView): { text: string; cls: string } {
  if (!m.online) return { text: "Offline", cls: "off" };
  if (m.needsInstaller) return { text: "Needs installer", cls: "warn" };
  const s = m.updateState;
  if (s && s !== "idle") {
    switch (s) {
      case "downloading":
        return { text: "Downloading…", cls: "info" };
      case "staged":
        return { text: "Staged", cls: "info" };
      case "updating":
        return { text: "Rebooting…", cls: "info" };
      case "healthy":
        return { text: "Healthy", cls: "good" };
      case "rolled-back":
        return { text: "Rolled back", cls: "bad" };
      case "failed":
        return { text: "Failed", cls: "bad" };
    }
  }
  if (target.value && m.agentVersion === target.value) return { text: "On target", cls: "good" };
  if (rollout.value && m.targetAgentVersion) return { text: "Waiting", cls: "muted" };
  return { text: "Idle", cls: "muted" };
}

function versionOf(m: MachineView): string {
  return m.agentVersion ? `v${m.agentVersion}` : "unknown";
}
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <header class="head">
        <div class="head-text">
          <h1 class="title">Updates</h1>
          <p class="subtitle">
            Push a new agent version to the whole fleet over the air — boxes pull, verify, swap and
            reboot themselves. A canary goes first and a bad build auto-rolls-back, so you never touch a
            box.
          </p>
        </div>
      </header>

      <!-- release banner -->
      <div class="card release">
        <div class="release-main">
          <div class="release-label">Depot agent release</div>
          <div v-if="release" class="release-version">
            <span class="chip mono">v{{ release.version }}</span>
            <span class="release-note">
              {{ behind.length === 0
                ? `All ${approved.length} approved ${approved.length === 1 ? "box is" : "boxes are"} on it.`
                : `${behind.length} ${behind.length === 1 ? "box is" : "boxes are"} behind.` }}
            </span>
          </div>
          <div v-else class="release-none">
            No agent release detected. The depot advertises one once the server image bakes an agent
            binary + manifest (or you set <code>POLYPTIC_VERSION</code> with binaries in the dist dir).
          </div>
        </div>
        <div v-if="breakdown.length" class="breakdown">
          <span v-for="b in breakdown" :key="b.version" class="chip mono soft">
            {{ b.count }}× v{{ b.version }}
          </span>
        </div>
      </div>

      <!-- start a rollout (no rollout running) -->
      <section v-if="!rollout" class="section">
        <div class="section-head">Roll out</div>
        <div v-if="!release" class="muted-line">Nothing to roll out until the depot has a release.</div>
        <div v-else-if="behind.length === 0" class="card success-line">
          ✓ The fleet is up to date on <span class="mono">v{{ release.version }}</span>.
        </div>
        <div v-else class="card rollout-form">
          <div class="form-row">
            <div class="form-label">Strategy</div>
            <div class="seg">
              <button :class="{ on: strategy === 'all' }" @click="strategy = 'all'">All at once</button>
              <button :class="{ on: strategy === 'canary' }" @click="strategy = 'canary'">Canary</button>
            </div>
          </div>

          <div v-if="strategy === 'canary'" class="form-row">
            <div class="form-label">Canary boxes</div>
            <div class="pick-list">
              <label v-for="m in behind" :key="m.id" class="pick">
                <input v-model="canaryPicks[m.id]" type="checkbox" />
                <span class="pick-label">{{ m.label }}</span>
                <span class="chip mono soft xs">{{ versionOf(m) }}</span>
                <span v-if="!m.online" class="pick-off">offline</span>
              </label>
            </div>
          </div>

          <div class="form-row">
            <div class="form-label">Promotion</div>
            <div class="seg">
              <button :class="{ on: promotion === 'manual' }" @click="promotion = 'manual'">Manual</button>
              <button :class="{ on: promotion === 'auto' }" @click="promotion = 'auto'">Auto after soak</button>
            </div>
          </div>

          <div class="form-actions">
            <button class="btn-primary" :disabled="!canStart || busy" @click="start">
              Roll out v{{ release.version }}
              <template v-if="strategy === 'canary'"> to {{ canaryIds.length }} box(es) first</template>
            </button>
          </div>
        </div>
      </section>

      <!-- rollout in progress -->
      <section v-else class="section">
        <div class="section-head">
          Rollout → <span class="mono">v{{ rollout.targetVersion }}</span>
          <span class="stage-badge" :class="`stage-${rollout.stage}`">{{ rollout.stage }}</span>
          <span v-if="rollout.paused" class="stage-badge stage-paused">paused</span>
        </div>

        <div class="card rollout-live">
          <div class="rollout-summary">
            <span>{{ onTargetCount }} / {{ approved.length }} on target</span>
            <span class="dot-sep">·</span>
            <span>{{ rollout.strategy === "canary" ? "canary" : "all at once" }}</span>
            <span class="dot-sep">·</span>
            <span>{{ rollout.promotion === "auto" ? "auto-promote" : "manual promote" }}</span>
            <span v-if="soakMinutes !== null" class="dot-sep">·</span>
            <span v-if="soakMinutes !== null">soaking ~{{ soakMinutes }}m</span>
          </div>

          <!-- wave 1 (canary, or the whole fleet for all-at-once) -->
          <div class="wave">
            <div class="wave-head">{{ isCanary ? "Wave 1 · canary" : "Fleet" }}</div>
            <div v-for="m in wave1" :key="m.id" class="fleet-row">
              <span class="dot" :class="m.online ? 'dot-on' : 'dot-off'"></span>
              <span class="fleet-label">{{ m.label }}</span>
              <span class="chip mono soft xs">{{ versionOf(m) }}</span>
              <span v-if="m.targetAgentVersion" class="arrow">→ v{{ m.targetAgentVersion }}</span>
              <span class="spacer"></span>
              <span class="pill" :class="statusPill(m).cls">{{ statusPill(m).text }}</span>
            </div>
          </div>

          <!-- wave 2 (the rest, canary only) -->
          <div v-if="isCanary && wave2.length" class="wave">
            <div class="wave-head">
              Wave 2 · rest
              <span v-if="!rollout.promoted" class="wave-note">waiting for the canary</span>
            </div>
            <div v-for="m in wave2" :key="m.id" class="fleet-row">
              <span class="dot" :class="m.online ? 'dot-on' : 'dot-off'"></span>
              <span class="fleet-label">{{ m.label }}</span>
              <span class="chip mono soft xs">{{ versionOf(m) }}</span>
              <span v-if="m.targetAgentVersion" class="arrow">→ v{{ m.targetAgentVersion }}</span>
              <span class="spacer"></span>
              <span class="pill" :class="statusPill(m).cls">{{ statusPill(m).text }}</span>
            </div>
          </div>

          <div class="rollout-actions">
            <button
              v-if="isCanary && !rollout.promoted"
              class="btn-primary"
              @click="promote"
            >
              Promote to all
            </button>
            <button v-if="!rollout.paused" class="btn-ghost" @click="pause">Pause</button>
            <button v-else class="btn-ghost" @click="resume">Resume</button>
            <button class="btn-warn" @click="rollback">Roll back</button>
            <button class="btn-ghost" @click="clearRollout">Clear</button>
          </div>
        </div>
      </section>

      <!-- full fleet table (always) -->
      <section v-if="approved.length" class="section">
        <div class="section-head">Fleet <span class="count-muted">· {{ approved.length }}</span></div>
        <div class="card">
          <div v-for="m in approved" :key="m.id" class="fleet-row">
            <span class="dot" :class="m.online ? 'dot-on' : 'dot-off'"></span>
            <span class="fleet-label">{{ m.label }}</span>
            <span class="chip mono soft xs">{{ versionOf(m) }}</span>
            <span class="spacer"></span>
            <span class="pill" :class="statusPill(m).cls">{{ statusPill(m).text }}</span>
          </div>
        </div>
      </section>
    </div>
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

.head {
  margin-bottom: 24px;
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
  max-width: 68ch;
}

.card {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px 18px;
  background: var(--card);
  box-shadow: var(--shadow-sm);
}

/* release banner */
.release {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 26px;
  flex-wrap: wrap;
}
.release-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted2);
  margin-bottom: 6px;
}
.release-version {
  display: flex;
  align-items: center;
  gap: 10px;
}
.release-note {
  font-size: 13px;
  color: var(--muted);
}
.release-none {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
  max-width: 60ch;
}
.release-none code {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11.5px;
  background: var(--muted-bg);
  padding: 1px 5px;
  border-radius: 4px;
}
.breakdown {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.chip.soft {
  background: var(--muted-bg);
  color: var(--fg2);
  font-weight: 500;
}
.chip.xs {
  font-size: 11px;
  padding: 2px 7px;
}
.mono {
  font-family: var(--mono, ui-monospace, "Geist Mono", monospace);
}

/* sections */
.section {
  margin-bottom: 26px;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
}
.count-muted {
  color: var(--muted2);
  font-weight: 500;
}
.muted-line {
  font-size: 12.5px;
  color: var(--muted2);
}
.success-line {
  font-size: 13px;
  color: var(--ok);
}

/* start-rollout form */
.rollout-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.form-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}
.form-label {
  width: 110px;
  flex: 0 0 110px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg2);
  padding-top: 6px;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--line2);
  border-radius: 9px;
  overflow: hidden;
}
.seg button {
  padding: 7px 14px;
  border: none;
  background: var(--surface);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}
.seg button.on {
  background: var(--accent-soft);
  color: var(--accent-fg);
  font-weight: 600;
}
.pick-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}
.pick {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  cursor: pointer;
}
.pick-label {
  font-weight: 500;
}
.pick-off {
  font-size: 11px;
  color: var(--muted2);
}
.form-actions {
  display: flex;
  justify-content: flex-end;
}

/* live rollout */
.stage-badge {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 20px;
  background: var(--muted-bg);
  color: var(--muted);
}
.stage-canary {
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.stage-fleet {
  background: var(--warn-soft);
  color: var(--warn);
}
.stage-complete {
  background: var(--ok-soft);
  color: var(--ok);
}
.stage-paused {
  background: var(--bad-soft);
  color: var(--bad);
}
.rollout-live {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rollout-summary {
  font-size: 12.5px;
  color: var(--muted);
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dot-sep {
  color: var(--muted2);
}
.wave {
  border-top: 1px solid var(--line);
  padding-top: 12px;
}
.wave-head {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.wave-note {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 500;
  color: var(--muted);
}

/* fleet rows */
.fleet-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  font-size: 13px;
}
.fleet-row + .fleet-row {
  border-top: 1px solid var(--line);
}
.fleet-label {
  font-weight: 500;
}
.arrow {
  font-size: 11.5px;
  color: var(--muted);
}
.spacer {
  flex: 1;
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

.pill {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
}
.pill.good {
  background: var(--ok-soft);
  color: var(--ok);
}
.pill.info {
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.pill.warn {
  background: var(--warn-soft);
  color: var(--warn);
}
.pill.bad {
  background: var(--bad-soft);
  color: var(--bad);
}
.pill.muted,
.pill.off {
  background: var(--muted-bg);
  color: var(--muted);
}

/* actions */
.rollout-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  border-top: 1px solid var(--line);
  padding-top: 14px;
}
.btn-primary {
  padding: 9px 16px;
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
.btn-ghost {
  padding: 9px 14px;
  border-radius: 9px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}
.btn-ghost:hover {
  background: var(--muted-bg);
}
.btn-warn {
  padding: 9px 14px;
  border-radius: 9px;
  border: 1px solid var(--bad-line, var(--line2));
  background: var(--surface);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--bad);
  cursor: pointer;
  font-family: inherit;
}
.btn-warn:hover {
  background: var(--bad-soft);
  border-color: var(--bad);
}
</style>
