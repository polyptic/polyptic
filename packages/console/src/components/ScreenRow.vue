<!--
  ScreenRow.vue — one screen under an approved machine in the Machines view.

  Mirrors the retired SolidJS admin's ScreenRow: a connectivity dot, an inline rename (committed on
  Enter/blur, reverted on Escape), the screen's connector + "Driven by {machine}" line, an Ident
  pulse, and an Inspect toggle. The rename draft re-syncs from the authoritative admin/state on every
  snapshot UNLESS the operator is mid-edit, so a live repaint never clobbers typed text or steals focus.

  The Inspect affordance is browser-dependent (POL-50 / POL-67, driven by the machine's reported
  kiosk browser):
    - chrome: "DevTools" ARMS the remote tunnel and opens Chrome DevTools in a NEW TAB on the
      operator's own machine — nothing on the glass changes and nothing reloads. Clicking again
      disarms (which also severs any live DevTools tab).
    - surf (or an older agent that reports no browser): "Inspect" pops the Web Inspector ON the
      panel itself — WebKitGTK has no remote inspector to tunnel (D63), so the console asks and
      someone at the screen reads. Relaunches the browser, so the page reloads.
  Either way the button reflects `screen.inspecting`, which only ever comes from the agent's ack;
  until the box answers the button shows a pending label rather than lying about the wall.

  All mutations go through the Pinia store (renameScreen / identScreen / inspectScreen) — no direct
  fetch here (the DevTools tab is a navigation, not a fetch). Failures are surfaced to the parent
  via `notify`, which toasts them.
-->
<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from "vue";
import type { KioskBrowser, ScreenView } from "@polyptic/protocol";
import { devtoolsUrl } from "../api";
import { useConsoleStore } from "../stores/console";
import { useScreenThumbnail } from "./canvas/useThumbnails";
import { useScreenInspect, type InspectTarget } from "./useInspect";
import { useScreenPower, powerMethodLabel, type PowerTarget } from "./usePanelPower";
import type { PowerCapabilities } from "@polyptic/protocol";

const props = defineProps<{
  screen: ScreenView;
  machineLabel: string;
  /** Is the screen's machine reachable? The inspector rides the agent socket, not the player's. */
  machineOnline: boolean;
  /** The machine's kiosk browser (POL-67): chrome = remote DevTools, else the on-panel inspector. */
  browser?: KioskBrowser;
  /** What the box can do about panel power (POL-101): dpms always, cec if it has an adapter. */
  power?: PowerCapabilities;
}>();

const emit = defineEmits<{ notify: [message: string] }>();

const store = useConsoleStore();

// Live preview of what's actually on this panel, refreshed on a throttle by the shared manager and
// paused automatically while the screen is offline (falls back to the neutral placeholder tile).
const thumbUrl = useScreenThumbnail(
  computed(() => props.screen.id),
  computed(() => props.screen.online),
);

const draft = ref(props.screen.friendlyName);
const focused = ref(false);
const identing = ref(false);
let identTimer: ReturnType<typeof setTimeout> | null = null;

// Re-sync from inbound snapshots unless the operator is actively editing this field.
watch(
  () => props.screen.friendlyName,
  (name) => {
    if (!focused.value) draft.value = name;
  },
);

const trimmed = computed(() => draft.value.trim());
const canRename = computed(() => {
  const n = trimmed.value;
  return n.length >= 1 && n.length <= 64 && n !== props.screen.friendlyName;
});

function commit(): void {
  if (!canRename.value) return;
  void store.renameScreen(props.screen.id, trimmed.value);
}

function revert(): void {
  draft.value = props.screen.friendlyName;
}

function ident(): void {
  void store.identScreen(props.screen.id);
  identing.value = true;
  if (identTimer) clearTimeout(identTimer);
  identTimer = setTimeout(() => {
    identing.value = false;
  }, 3000);
}

// ── Inspect / DevTools (POL-50 / POL-67) ───────────────────────────────────────
// The whole toggle — the ack-driven pending state, the new-tab arm on chrome, the on-panel confirm
// on surf — lives in the shared composable (also behind the Wall Inspector's ⋯ menu, POL-85).
const inspectTarget = computed<InspectTarget>(() => ({
  screen: props.screen,
  machineLabel: props.machineLabel,
  machineOnline: props.machineOnline,
  browser: props.browser,
}));
const {
  isChrome,
  inspecting,
  pending: inspectPending,
  title: inspectTitle,
  toggle: toggleInspect,
} = useScreenInspect(inspectTarget, {
  inspect: (id, on) => store.inspectScreen(id, on),
  devtoolsUrl,
  notify: (message) => emit("notify", message),
});
const inspectLabel = computed(() => {
  if (inspectPending.value) return inspecting.value ? "Closing…" : "Opening…";
  if (isChrome.value) return inspecting.value ? "DevTools live" : "DevTools";
  return inspecting.value ? "Inspecting" : "Inspect";
});

// ── Panel power (POL-101) ──────────────────────────────────────────────────────
// A sleeping screen is HEALTHY: its player is still connected, still holding its content, and the box
// is fine — the glass is simply dark because someone (or a schedule) asked for it. So it gets its own
// calm "Asleep" chip and a moon on the preview, NOT the offline dot. The two must never be confused,
// or an operator will be dispatched to fix a wall that is working exactly as instructed.
const powerTarget = computed<PowerTarget>(() => ({
  screen: props.screen,
  machineLabel: props.machineLabel,
  machineOnline: props.machineOnline,
  power: props.power,
}));
const {
  asleep,
  pending: powerPending,
  supported: powerSupported,
  disabled: powerDisabled,
  title: powerTitle,
  toggle: togglePower,
} = useScreenPower(powerTarget, {
  setPower: (id, on) => store.setScreenPower(id, on),
  notify: (message) => emit("notify", message),
});
const powerLabel = computed(() => {
  if (powerPending.value) return asleep.value ? "Waking…" : "Sleeping…";
  return asleep.value ? "Wake" : "Sleep";
});
/** The chip's tooltip: which rung slept it (DPMS-only vs CEC) — an operator standing at a still-lit
 *  panel deserves to know that is expected, not broken. */
const asleepDetail = computed(() => powerMethodLabel(props.screen.powerMethods));
/** A screen with a daily window shows it, so "why did that go dark at 19:00?" answers itself. */
const hoursSummary = computed(() => {
  const h = props.screen.panelHours;
  if (!h || !h.enabled) return null;
  return `${h.on}–${h.off}`;
});

onUnmounted(() => {
  if (identTimer) clearTimeout(identTimer);
});

// Permanently forget this screen (POL-14) — deletes it, its placement + content. Aimed at stale
// screens (an output the machine no longer drives); a still-reported output reappears on reconnect.
function remove(): void {
  const yes = window.confirm(
    `Remove screen "${props.screen.friendlyName}"? This permanently deletes it, its placement and ` +
      `content from the console. If its machine still drives this output, the screen reappears when the ` +
      `machine next reconnects.`,
  );
  if (yes) void store.removeScreen(props.screen.id);
}
</script>

<template>
  <div class="screen-row">
    <span
      class="dot"
      :class="screen.online ? 'dot-on' : 'dot-off'"
      :title="screen.online ? 'player connected' : 'player offline'"
    ></span>

    <!-- live preview tile (falls back to a neutral placeholder when offline / no frame yet).
         Asleep dims it under a moon: the player is still rendering, so the last frame is REAL — but
         nobody is looking at it, and the tile should say so. -->
    <div class="preview" :class="{ live: thumbUrl, asleep }">
      <div
        v-if="thumbUrl"
        class="preview-img"
        :style="{ backgroundImage: `url(${thumbUrl})` }"
        aria-hidden="true"
      ></div>
      <span v-else class="preview-empty" aria-hidden="true">▦</span>
      <span v-if="asleep" class="preview-moon" aria-hidden="true">☾</span>
    </div>

    <div class="name-col">
      <input
        v-model="draft"
        class="rename"
        spellcheck="false"
        autocomplete="off"
        :aria-label="`Rename ${screen.friendlyName}`"
        @focus="focused = true"
        @blur="focused = false; commit()"
        @keyup.enter="commit(); ($event.target as HTMLInputElement).blur()"
        @keyup.esc="revert(); ($event.target as HTMLInputElement).blur()"
      />
      <div class="sub">
        <span class="chip">{{ screen.connector }}</span>
        <!-- POL-101: a sleeping panel is HEALTHY. Calm, deliberate, its own chip — never the red of a
             fault, and never mistakable for the offline dot beside it. -->
        <span v-if="asleep" class="chip chip-asleep" :title="asleepDetail">☾ Asleep</span>
        <span v-if="hoursSummary" class="chip chip-hours" :title="`Panel hours — this screen sleeps and wakes on a daily schedule`">
          {{ hoursSummary }}
        </span>
        <!-- POL-119 — cast-enabled indicator (the toggle itself lives in the canvas Inspector) -->
        <span
          v-if="screen.castEnabled"
          class="chip cast-chip"
          :class="{ live: screen.castActive }"
          :title="screen.castActive ? 'A device is casting to this screen now' : 'Casting enabled — discoverable via Screen Mirroring'"
        >
          {{ screen.castActive ? "Casting now" : "Cast on" }}
        </span>
        <span class="driven">
          Driven by {{ machineLabel }} ·
          {{ screen.surfaceCount }} {{ screen.surfaceCount === 1 ? "surface" : "surfaces" }}
        </span>
      </div>
    </div>

    <!-- POL-107 — Ident is an OPERATOR verb (flash a panel to find it); a viewer gets neither it nor
         the two below. Inspect opens a live debugger inside the wall's browser and removing a screen
         forgets a device: both are ADMIN. Every one of these routes 403s for a lesser role. -->
    <button v-if="store.canAuthor" class="ident-btn" :class="{ active: identing }" @click="ident">
      <span class="ident-dot"></span>{{ identing ? "Flashing…" : "Ident" }}
    </button>

    <button
      v-if="powerSupported"
      class="power-btn"
      :class="{ asleep, pending: powerPending }"
      :disabled="powerDisabled"
      :title="powerTitle"
      :aria-pressed="asleep"
      @click="togglePower"
    >
      <span class="power-glyph" aria-hidden="true">{{ asleep ? "☀" : "☾" }}</span>{{ powerLabel }}
    </button>

    <button
      v-if="store.isAdmin"
      class="inspect-btn"
      :class="{ active: inspecting, pending: inspectPending }"
      :disabled="!machineOnline || inspectPending"
      :title="inspectTitle"
      :aria-pressed="inspecting"
      @click="toggleInspect"
    >
      <span class="inspect-glyph" aria-hidden="true">&lt;/&gt;</span>{{ inspectLabel }}
    </button>

    <button v-if="store.isAdmin" class="remove-btn" title="Remove screen" aria-label="Remove screen" @click="remove">
      ✕
    </button>
  </div>
</template>

<style scoped>
.screen-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
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
.preview {
  flex: 0 0 auto;
  width: 64px;
  height: 36px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--muted-bg);
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview.live {
  background: #0b0d12;
}
.preview-img {
  width: 100%;
  height: 100%;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.preview-empty {
  font-size: 14px;
  color: var(--muted2);
  line-height: 1;
}
.name-col {
  flex: 1;
  min-width: 0;
}
.rename {
  width: 100%;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 4px 7px;
  margin: -4px -7px 2px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.rename:hover {
  border-color: var(--line);
}
.rename:focus {
  border-color: var(--accent);
  background: var(--card);
}
.sub {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 11.5px;
  color: var(--muted2);
  white-space: nowrap;
  overflow: hidden;
}
.chip {
  font-variant-numeric: tabular-nums;
  background: var(--muted-bg);
  color: var(--fg2);
  font-weight: 500;
  padding: 2px 7px;
  border-radius: 6px;
}
/* POL-119 — casting indicator: calm when merely enabled, accent while a session is live. */
.cast-chip {
  color: var(--muted);
}
.cast-chip.live {
  background: var(--accent-bg, var(--muted-bg));
  color: var(--accent-fg);
  font-weight: 600;
}
.driven {
  color: var(--muted);
}
.surfaces {
  color: var(--muted2);
}
.ident-btn {
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
.ident-btn:hover {
  background: var(--muted-bg);
}
.ident-btn.active {
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
.inspect-btn {
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
.inspect-btn:hover:not(:disabled) {
  background: var(--muted-bg);
}
/* Active = the inspector is genuinely on the panel (the agent said so), so make it look live. */
.inspect-btn.active {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.inspect-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.inspect-btn.pending {
  cursor: progress;
}
.inspect-glyph {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: -0.5px;
  color: var(--muted2);
}
.inspect-btn.active .inspect-glyph {
  color: var(--accent);
}
/* ── Panel power (POL-101) ─────────────────────────────────────────────────────
   The asleep vocabulary is deliberately COOL and CALM (an indigo moon), never the red/amber of a
   fault: a sleeping panel is a healthy panel obeying an instruction. It sits next to — and reads
   differently from — the offline dot, because "dark on purpose" and "we cannot reach this box" are
   the two states an operator must never confuse. */
.preview.asleep {
  position: relative;
}
.preview.asleep .preview-img {
  opacity: 0.25;
  filter: grayscale(0.6);
}
.preview-moon {
  position: absolute;
  font-size: 15px;
  line-height: 1;
  color: var(--fg2);
  opacity: 0.85;
}
.chip-asleep {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent-fg, var(--fg2));
  font-weight: 600;
  white-space: nowrap;
}
.chip-hours {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.power-btn {
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
.power-btn:hover:not(:disabled) {
  background: var(--muted-bg);
}
.power-btn.asleep {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-fg);
}
.power-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.power-btn.pending {
  cursor: progress;
}
.power-glyph {
  font-size: 12px;
  color: var(--muted2);
}
.power-btn.asleep .power-glyph {
  color: var(--accent);
}
/* Remove is a quiet ✕ icon (POL-68) — deletion shouldn't compete with Ident/Inspect for attention. */
.remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}
.remove-btn:hover {
  background: var(--bad-soft);
  color: var(--bad);
}
</style>
