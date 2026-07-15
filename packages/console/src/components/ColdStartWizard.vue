<!--
  ColdStartWizard.vue — the guided first-run flow for getting a brand-new machine onto the wall.

  Opened from the Machines view (a first-run empty state, or the "Connect a machine" button). It is a
  full-bleed overlay over the main column, mirroring docs/design/console.dc.html's COLD START WIZARD:

    STEP 1 — connect: show how to enrol a new machine (write the network bootloader to a USB stick and
      boot from it; the machine streams the live image into RAM and dials in on its own), then
      LIVE-WATCH the store for the machine to appear `pending` and Approve / Reject it inline.
    STEP 2 — map screens: for each screen the freshly approved machine reports, Ident the physical
      panel, give it a memorable name, and optionally place it on the active mural.

  Everything composes EXISTING store actions (approveMachine / rejectMachine / identScreen /
  renameScreen / placeScreen) — no new endpoints, no direct fetch.
-->
<script setup lang="ts">
import { ref, reactive, computed, watch } from "vue";
import { useRouter } from "vue-router";
import { useConsoleStore } from "../stores/console";
import { formatLastSeen, countLabel } from "../time";
import { machineDisplayName } from "../machine-name";

const props = defineProps<{ open: boolean; now: number }>();
const emit = defineEmits<{ (e: "close"): void }>();

const store = useConsoleStore();
const router = useRouter();

// The machine this run is enrolling. Set when the operator approves a pending box in STEP 1; the
// wizard then follows that machine into STEP 2 once the server reports it `approved`.
const enrollingId = ref<string | null>(null);

// Per-screen rename drafts (keyed by screenId) + transient ident flashes for STEP 2.
const drafts = reactive<Record<string, string>>({});
const focusedScreen = ref<string | null>(null);
const identing = reactive<Record<string, boolean>>({});
const identTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Reset all wizard state whenever it (re)opens, and (re)load the boot medium + enrollment-mode info
// so STEP 1 offers the REAL bootloader download and knows whether the server is open or gated.
watch(
  () => props.open,
  (open) => {
    if (open) {
      enrollingId.value = null;
      focusedScreen.value = null;
      for (const k of Object.keys(drafts)) delete drafts[k];
      for (const k of Object.keys(identing)) delete identing[k];
      void store.fetchEnrollment();
      void store.fetchNetboot();
      // POL-122: with no medium published, whether an image BUILD is in flight is the difference
      // between "wait, it's coming" and "nothing is happening" — so the wizard needs it too.
      void store.fetchImageUpdates();
    }
  },
  { immediate: true },
);

const pending = computed(() => store.pendingMachines);

// Open vs gated, for the note beside the download. A gated box needs no hand-typed token: it arrives
// with the boot menu the control plane serves.
const enrollmentLoaded = computed(() => store.enrollment !== null);
const enrollmentOpen = computed(() => store.enrollmentOpen);

// The network bootloader (POL-33/D54), the only way a bare machine becomes a screen. Null until the
// netboot info loads, and null-valued when no medium is built into this deployment's depot.
const bootMediumUrl = computed(() => store.netboot?.bootMediumUrl ?? null);

/** What the download really is (POL-122) — see the same computed in Settings.vue. A LEAN medium is
 *  wired-only and boots no Wi-Fi screen, and until now it wore the same name and the same button. */
const mediumState = computed<"full" | "lean" | "building" | "none" | null>(() => {
  if (store.netboot === null) return null; // not loaded — claim nothing
  const m = store.netboot.bootMedium;
  if (m) return m.lean ? "lean" : "full";
  return store.imageUpdates?.lastBuild?.status === "running" ? "building" : "none";
});

function openOnboardSettings(): void {
  emit("close");
  void router.push({ name: "settings" });
}

const enrollingMachine = computed(() =>
  enrollingId.value ? store.machineById(enrollingId.value) : undefined,
);

// STEP 2 begins once the machine we're enrolling is actually approved by the server.
const step = computed<1 | 2>(() =>
  enrollingMachine.value && enrollingMachine.value.status === "approved" ? 2 : 1,
);

const waiting = computed(() => step.value === 1 && pending.value.length === 0);

const title = computed(() =>
  step.value === 2 ? "Name & place your screens" : "Connect your first machine",
);
const subtitle = computed(() =>
  step.value === 2
    ? "These screens are live but anonymous. Map each one to the physical panel on your wall."
    : "No machines are on the wall yet. Bring one online to get started.",
);

const screens = computed(() => enrollingMachine.value?.screens ?? []);
const targetMuralId = computed(() => store.activeMuralId ?? store.murals[0]?.id ?? null);

// ── STEP 1 ─────────────────────────────────────────────────────────────────
function approve(id: string): void {
  void store.approveMachine(id);
  enrollingId.value = id; // follow this machine into STEP 2
}

function reject(id: string): void {
  void store.rejectMachine(id);
}

// ── STEP 2 ─────────────────────────────────────────────────────────────────
function nameFor(id: string, fallback: string): string {
  return drafts[id] ?? fallback;
}

function onNameInput(id: string, value: string): void {
  drafts[id] = value;
}

function commitName(id: string): void {
  focusedScreen.value = null;
  const draft = drafts[id];
  if (draft === undefined) return;
  const trimmed = draft.trim();
  if (trimmed.length >= 1 && trimmed.length <= 64) void store.renameScreen(id, trimmed);
}

function ident(id: string): void {
  void store.identScreen(id);
  identing[id] = true;
  const existing = identTimers.get(id);
  if (existing) clearTimeout(existing);
  identTimers.set(
    id,
    setTimeout(() => {
      identing[id] = false;
    }, 3000),
  );
}

function isPlaced(id: string): boolean {
  return store.placementForScreen(id) !== undefined;
}

function place(id: string, index: number): void {
  const muralId = targetMuralId.value;
  if (!muralId) return;
  if (isPlaced(id)) {
    void store.unplaceScreen(id);
    return;
  }
  // Fan the new screens out across the canvas so they don't stack.
  void store.placeScreen(id, muralId, 120 + index * 220, 120);
}

function finish(): void {
  emit("close");
  void router.push({ name: "wall" });
}

function close(): void {
  emit("close");
}
</script>

<template>
  <div v-if="open" class="cs-overlay">
    <div class="cs-scroll">
      <div class="cs-panel">
        <button class="cs-close" title="Close" @click="close">✕</button>

        <div class="cs-eyebrow">First-run setup</div>
        <h1 class="cs-title">{{ title }}</h1>
        <p class="cs-sub">{{ subtitle }}</p>

        <!-- STEP 1: connect ------------------------------------------------- -->
        <div v-if="step === 1" class="card cs-card">
          <div class="card-label">Enrol a new machine</div>
          <ol class="steps">
            <li>
              <span class="num">1</span>
              <span>
                Download the network bootloader below and flash it to a USB stick (2&nbsp;GB or
                larger). You can use Balena Etcher or Rufus to do this.
              </span>
            </li>
            <li>
              <span class="num">2</span>
              <span>
                Insert the USB stick into the machine connected to the screen and boot from the USB
                stick. Leave Secure Boot <b>on</b>.
              </span>
            </li>
            <li>
              <span class="num">3</span>
              <span>
                Once the machine boots up, you should see it appear below for approval. Approve it,
                then name and place the screens it drives.
              </span>
            </li>
          </ol>

          <div class="dl-row">
            <a
              v-if="bootMediumUrl && (mediumState === 'full' || mediumState === 'lean')"
              class="btn-download"
              :href="bootMediumUrl"
              download
            >
              {{ mediumState === "lean" ? "Download (wired-only)" : "Download bootloader" }}
            </a>
            <button v-else-if="mediumState === 'building'" class="btn-download" type="button" disabled>
              Building the first OS image…
            </button>
            <button v-else class="btn-download" type="button" disabled>No bootloader yet</button>
            <span v-if="enrollmentLoaded && enrollmentOpen" class="enrol-open">
              <span class="enrol-open-badge">Open mode</span>
              <span>No token needed. Any agent that connects is auto-registered.</span>
            </span>
            <span v-else class="dl-note">
              This control plane's address and enrolment token are sent with the boot menu, so there
              is nothing to type on the machine.
            </span>
          </div>
          <!-- POL-122: an honest gate. "Bootloader not built" was said even while the very image it is
               baked from was building, and a wired-only (lean) medium was offered as if it booted anything. -->
          <div v-if="mediumState === 'building'" class="run-hint gap">
            Building the first OS image — screens can't netboot until it finishes. The bootloader is baked from
            that image; it appears here (and in
            <button type="button" class="link-btn" @click="openOnboardSettings">
              Settings ▸ Onboard Screens
            </button>
            ) the moment it's ready.
          </div>
          <div v-else-if="mediumState === 'lean'" class="run-hint gap warn">
            This bootloader is wired-only — no local payload, no Wi-Fi. It boots a screen on Ethernet; a screen
            with no cable cannot boot from it. Run a Full rebuild in
            <button type="button" class="link-btn" @click="openOnboardSettings">
              Settings ▸ Onboard Screens
            </button>
            to publish the full medium.
          </div>
          <div v-else-if="mediumState === 'none'" class="run-hint gap">
            No bootloader is published in this deployment.
            <button type="button" class="link-btn" @click="openOnboardSettings">
              Settings ▸ Onboard Screens
            </button>
            has the build instructions, plus other ways to boot a machine.
          </div>

          <!-- waiting for the machine to dial in -->
          <div v-if="waiting" class="waiting">
            <span class="spinner"></span>
            <span class="waiting-text">Waiting for a machine to dial in…</span>
            <span class="waiting-hint">
              It appears here the moment its agent connects — keep this open.
            </span>
          </div>

          <!-- pending machines have arrived: approve / reject inline -->
          <div v-else class="pend-list">
            <div v-for="m in pending" :key="m.id" class="pend">
              <div class="pend-head">
                <span class="dot dot-on"></span>
                <!-- POL-117 — honest name; never `localhost.localdomain` posing as one. -->
                <span class="pend-label">{{ machineDisplayName(m) }}</span>
                <span class="pend-id">requesting access</span>
              </div>
              <div class="pend-meta">
                {{ m.online ? "Online" : "Offline" }} · reports
                {{ countLabel(m.outputCount, "screen") }} ·
                {{ m.online ? "just now" : formatLastSeen(m.lastSeen, now) }}
              </div>
              <div class="pend-actions">
                <button class="btn-reject" @click="reject(m.id)">Reject</button>
                <button class="btn-approve" @click="approve(m.id)">Approve machine</button>
              </div>
            </div>
          </div>
        </div>

        <!-- STEP 2: map screens --------------------------------------------- -->
        <div v-else class="card cs-card">
          <div class="cs-hint">
            For each screen: <b>Ident</b> to see which physical panel flashes, give it a memorable
            name, then place it on your mural.
          </div>

          <div v-if="screens.length === 0" class="waiting">
            <span class="spinner"></span>
            <span class="waiting-text">Registering screens for {{ enrollingMachine ? machineDisplayName(enrollingMachine) : "the machine" }}…</span>
          </div>

          <div v-else class="map-list">
            <div v-for="(s, i) in screens" :key="s.id" class="map-row">
              <span class="map-idx">{{ i + 1 }}</span>
              <input
                class="map-name"
                :value="nameFor(s.id, s.friendlyName)"
                placeholder="Name this screen…"
                spellcheck="false"
                autocomplete="off"
                @focus="focusedScreen = s.id"
                @input="onNameInput(s.id, ($event.target as HTMLInputElement).value)"
                @blur="commitName(s.id)"
                @keyup.enter="commitName(s.id); ($event.target as HTMLInputElement).blur()"
              />
              <button
                class="map-ident"
                :class="{ active: identing[s.id] }"
                @click="ident(s.id)"
              >
                <span class="ident-dot"></span>{{ identing[s.id] ? "Flashing…" : "Ident" }}
              </button>
              <button
                class="map-place"
                :class="{ done: isPlaced(s.id) }"
                :disabled="!targetMuralId"
                :title="targetMuralId ? '' : 'Create a mural on the Wall first'"
                @click="place(s.id, i)"
              >
                {{ isPlaced(s.id) ? "Placed ✓" : "Place" }}
              </button>
            </div>
          </div>

          <p v-if="!targetMuralId" class="no-mural">
            No mural yet — you can still name screens now and place them later on the Wall.
          </p>

          <button class="btn-finish" @click="finish">Finish — open the Wall</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cs-overlay {
  position: absolute;
  inset: 0;
  z-index: 120;
  background: var(--bg);
}
.cs-scroll {
  height: 100%;
  overflow-y: auto;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}
.cs-panel {
  position: relative;
  width: 560px;
  max-width: calc(100vw - 32px);
  padding: 48px 24px 60px;
}
.cs-close {
  position: absolute;
  top: 20px;
  right: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.cs-close:hover {
  background: var(--muted-bg);
  color: var(--fg2);
}
.cs-eyebrow {
  text-align: center;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--accent-fg);
  text-transform: uppercase;
  margin-bottom: 8px;
}
.cs-title {
  text-align: center;
  font-size: 23px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 6px;
}
.cs-sub {
  text-align: center;
  font-size: 13.5px;
  color: var(--muted);
  margin: 0 0 26px;
  line-height: 1.5;
}
.cs-card {
  padding: 22px;
  box-shadow: var(--shadow);
}
.card-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 12px;
}
.steps {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.steps li {
  display: flex;
  gap: 11px;
  align-items: flex-start;
  font-size: 13px;
  color: var(--fg2);
  line-height: 1.5;
}
.num {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--muted-bg);
  color: var(--fg2);
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}
.run-hint {
  font-size: 11.5px;
  color: var(--muted2);
  line-height: 1.6;
}
.run-hint.gap {
  margin-bottom: 12px;
}
/* A wired-only medium can't boot half a fleet — that reads as a warning, not a footnote (POL-122). */
.run-hint.warn {
  color: var(--warn, #e0a750);
}

/* bootloader download */
.dl-row {
  display: flex;
  align-items: center;
  gap: 13px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.btn-download {
  padding: 10px 16px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}
.btn-download:hover:not(:disabled) {
  opacity: 0.92;
}
.btn-download:disabled {
  background: var(--muted-bg);
  color: var(--muted2);
  cursor: not-allowed;
}
.dl-note {
  flex: 1;
  min-width: 200px;
  font-size: 11.5px;
  color: var(--muted2);
  line-height: 1.5;
}
.link-btn {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--accent-fg);
  font-weight: 600;
  cursor: pointer;
}
.link-btn:hover {
  text-decoration: underline;
}

.enrol-open {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.enrol-open-badge {
  flex: 0 0 auto;
  background: var(--accent-soft);
  color: var(--accent-fg);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
}
.waiting {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  padding: 22px;
  border: 1.5px dashed var(--line2);
  border-radius: 11px;
}
.spinner {
  width: 22px;
  height: 22px;
  border: 2.5px solid var(--line2);
  border-right-color: var(--accent);
  border-radius: 50%;
  animation: cs-spin 0.8s linear infinite;
}
@keyframes cs-spin {
  to {
    transform: rotate(360deg);
  }
}
.waiting-text {
  font-size: 12.5px;
  color: var(--muted);
}
.waiting-hint {
  font-size: 11.5px;
  color: var(--muted2);
  text-align: center;
  line-height: 1.5;
}
.pend-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 16px;
}
.pend {
  border: 1px solid var(--warn-soft);
  border-left: 3px solid var(--warn);
  border-radius: 11px;
  padding: 15px;
  background: var(--surface);
  animation: cs-fade 0.25s ease;
}
@keyframes cs-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.pend-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 4px;
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
.pend-label {
  font-size: 14px;
  font-weight: 600;
}
.pend-id {
  font-size: 11px;
  color: var(--muted2);
}
.pend-meta {
  font-size: 12.5px;
  color: var(--muted);
  margin-bottom: 13px;
}
.pend-actions {
  display: flex;
  gap: 9px;
}
.btn-reject {
  flex: 1;
  padding: 9px;
  border-radius: 9px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--bad);
  cursor: pointer;
  font-family: inherit;
}
.btn-reject:hover {
  background: var(--bad-soft);
}
.btn-approve {
  flex: 2;
  padding: 9px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.btn-approve:hover {
  opacity: 0.92;
}
.cs-hint {
  font-size: 12.5px;
  color: var(--muted);
  margin-bottom: 16px;
  line-height: 1.5;
}
.cs-hint b {
  color: var(--fg2);
  font-weight: 600;
}
.map-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 18px;
}
.map-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.map-idx {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--muted-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  flex: 0 0 auto;
}
.map-name {
  flex: 1;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 13px;
  font-weight: 500;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.map-name:focus {
  border-color: var(--accent);
}
.map-ident {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
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
.map-ident:hover {
  background: var(--muted-bg);
}
.map-ident.active {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.ident-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.map-place {
  padding: 8px 14px;
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
.map-place:hover:not(:disabled) {
  background: var(--muted-bg);
}
.map-place:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.map-place.done {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.no-mural {
  font-size: 11.5px;
  color: var(--muted2);
  line-height: 1.5;
  margin: 0 0 16px;
}
.btn-finish {
  width: 100%;
  padding: 11px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.btn-finish:hover {
  opacity: 0.92;
}
</style>
