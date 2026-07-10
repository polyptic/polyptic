<!--
  ColdStartWizard.vue — the guided first-run flow for getting a brand-new machine onto the wall.

  Opened from the Machines view (a first-run empty state, or the "Connect a machine" button). It is a
  full-bleed overlay over the main column, mirroring docs/design/console.dc.html's COLD START WIZARD:

    STEP 1 — connect: show how to enrol a new box (write the network bootloader to a USB stick and
      boot from it — the box streams the live image into RAM and dials in on its own; the agent
      one-liner survives behind a disclosure for boxes that already run Ubuntu), then LIVE-WATCH the
      store for the machine to appear `pending` and Approve / Reject it inline.
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

// Whether the agent-install fallback (an existing Ubuntu box) is expanded.
const fallbackOpen = ref(false);

// Reset all wizard state whenever it (re)opens, and (re)load the boot medium + enrollment-token info
// so STEP 1 offers the REAL bootloader download and the REAL token (gated) or the open-mode note.
watch(
  () => props.open,
  (open) => {
    if (open) {
      enrollingId.value = null;
      focusedScreen.value = null;
      fallbackOpen.value = false;
      for (const k of Object.keys(drafts)) delete drafts[k];
      for (const k of Object.keys(identing)) delete identing[k];
      void store.fetchEnrollment();
      void store.fetchNetboot();
    }
  },
  { immediate: true },
);

const pending = computed(() => store.pendingMachines);

// Enrollment-token info (open vs gated) for STEP 1 — sourced from GET /settings/enrollment.
const enrollmentLoaded = computed(() => store.enrollment !== null);
const enrollmentOpen = computed(() => store.enrollmentOpen);
const enrollmentToken = computed(() => store.enrollmentToken);

// The network bootloader (POL-33/D54) — the primary way a bare box becomes a screen. Null until the
// netboot info loads, and null-valued when no medium is built into this deployment's depot.
const netbootLoaded = computed(() => store.netboot !== null);
const bootMediumUrl = computed(() => store.netboot?.bootMediumUrl ?? null);

// The control plane a box dials. The server computes it from the request Host; before that lands, fall
// back to how the operator reached the console (:8080 is the server — same-origin in the prod image).
const serverBase = computed(
  () => store.netboot?.baseUrl ?? `${window.location.protocol}//${window.location.hostname}:8080`,
);

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
                Download the network bootloader below and flash it to a USB stick (4&nbsp;GB or
                larger — everything on it is erased). Balena Etcher or Rufus will do it.
              </span>
            </li>
            <li>
              <span class="num">2</span>
              <span>
                Boot the box behind your screens from that stick, Secure Boot <b>on</b>. It streams
                the latest Polyptic image into RAM — no OS install, no disk — and dials this control
                plane on its own. Nothing to type on the box.
              </span>
            </li>
            <li>
              <span class="num">3</span>
              <span>Approve it below, then name &amp; place the screens it drives.</span>
            </li>
          </ol>

          <div class="dl-row">
            <a v-if="bootMediumUrl" class="btn-download" :href="bootMediumUrl" download>
              Download bootloader
            </a>
            <button v-else class="btn-download" type="button" disabled>Bootloader not built</button>
            <span v-if="enrollmentLoaded && enrollmentOpen" class="enrol-open">
              <span class="enrol-open-badge">Open mode</span>
              <span>No token needed — any agent that connects is auto-registered.</span>
            </span>
            <span v-else class="dl-note">
              The control-plane URL and enrolment token travel with the boot menu.
            </span>
          </div>
          <div v-if="netbootLoaded && !bootMediumUrl" class="run-hint gap">
            No bootloader is built into this deployment.
            <button type="button" class="link-btn" @click="openOnboardSettings">
              Settings ▸ Onboard Screens
            </button>
            has the build hint, the per-build live ISO, and the HTTP Boot URI for booting without a
            stick.
          </div>

          <!-- fallback: a box that already runs Ubuntu takes the agent one-liner instead (D41) -->
          <button
            type="button"
            class="disclosure"
            :class="{ open: fallbackOpen }"
            @click="fallbackOpen = !fallbackOpen"
          >
            <span class="caret">›</span>The box already runs Ubuntu
          </button>
          <div v-if="fallbackOpen" class="fallback">
            <div class="run">
              <code v-if="enrollmentLoaded && !enrollmentOpen"
                >curl -sfL {{ serverBase }}/install | POLYPTIC_TOKEN={{ enrollmentToken }} sh -</code
              >
              <code v-else>curl -sfL {{ serverBase }}/install | sh -</code>
            </div>
            <div class="run-hint">
              Installs the agent onto the existing OS, straight from this control plane — no internet
              on the box. Add <code class="inline">sh -s -- --kiosk</code> to also set up the display
              (sway + Chromium). If the box can't reach <b>{{ serverBase }}</b>, use this server's LAN
              address instead. Unlike a netbooted box, this one won't take image updates.
            </div>
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
                <span class="pend-label">{{ m.label }}</span>
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
            <span class="waiting-text">Registering screens for {{ enrollingMachine?.label }}…</span>
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
.run {
  background: var(--muted-bg);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 10px;
  overflow-x: auto;
}
.run code {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11.5px;
  color: var(--fg2);
  white-space: pre;
  line-height: 1.6;
}
.run-hint {
  font-size: 11.5px;
  color: var(--muted2);
  line-height: 1.6;
}
.run-hint b {
  color: var(--muted);
  font-weight: 600;
}
.run-hint.gap {
  margin-bottom: 12px;
}
code.inline {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  background: var(--muted-bg);
  border-radius: 5px;
  padding: 1px 5px;
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

/* "the box already runs Ubuntu" fallback */
.disclosure {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 10px 0;
  border: none;
  border-top: 1px solid var(--line);
  background: none;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  text-align: left;
}
.disclosure:hover {
  color: var(--fg2);
}
.caret {
  display: inline-block;
  font-size: 14px;
  line-height: 1;
  transition: transform 0.15s ease;
}
.disclosure.open .caret {
  transform: rotate(90deg);
}
.fallback {
  margin-bottom: 4px;
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
