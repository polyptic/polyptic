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

const props = defineProps<{
  screen: ScreenView;
  machineLabel: string;
  /** Is the screen's machine reachable? The inspector rides the agent socket, not the player's. */
  machineOnline: boolean;
  /** The machine's kiosk browser (POL-67): chrome = remote DevTools, else the on-panel inspector. */
  browser?: KioskBrowser;
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
// `inspecting` is written only by the agent's ack, so the click leaves the button in a pending state
// until the wall confirms. A stuck box therefore reads as "Opening…", never as a live inspector.
const inspectPending = ref(false);
let inspectTimer: ReturnType<typeof setTimeout> | null = null;

const isChrome = computed(() => props.browser === "chrome");
const inspecting = computed(() => props.screen.inspecting === true);
const inspectLabel = computed(() => {
  if (isChrome.value) {
    if (inspectPending.value) return inspecting.value ? "Closing…" : "Opening…";
    return inspecting.value ? "DevTools live" : "DevTools";
  }
  if (inspectPending.value) return inspecting.value ? "Closing…" : "Opening…";
  return inspecting.value ? "Inspecting" : "Inspect";
});
const inspectTitle = computed(() => {
  if (!props.machineOnline) {
    return `${props.machineLabel} is offline — the inspector rides its agent connection`;
  }
  if (isChrome.value) {
    return inspecting.value
      ? "Disarm remote DevTools for this screen (closes any open DevTools tab)"
      : "Open Chrome DevTools for this screen in a new tab — remote, nothing shows on the wall";
  }
  return inspecting.value
    ? "Close the Web Inspector on this panel (reloads the page)"
    : "Open the browser's Web Inspector ON this panel — read it at the screen (reloads the page)";
});

/**
 * Clear the pending state as soon as the wall's ack lands — on EITHER signal.
 *
 * A refusal leaves `inspecting` false, i.e. unchanged, so watching that alone would leave the button
 * spinning on "Opening…" until its timeout for exactly the case the operator most needs to hear about.
 * `inspectError` is the refusal edge; report it, because nobody is standing at that screen.
 *
 * `props.screen` is a fresh object on every admin/state broadcast, so this fires for unrelated
 * changes too. Only the two transitions that actually mean "the box answered" may settle the button:
 * the inspector flipping, or a NEW refusal. Notably, the server CLEARING a stale error at the start
 * of a fresh request must not cancel the pending state that request just set.
 */
watch(
  () => [props.screen.inspecting === true, props.screen.inspectError ?? ""] as const,
  ([nowOn, error], [wasOn, prevError]) => {
    const newRefusal = error !== "" && error !== prevError;
    if (!newRefusal && nowOn === wasOn) return; // an unrelated broadcast, or a stale error cleared
    inspectPending.value = false;
    if (inspectTimer) clearTimeout(inspectTimer);
    if (newRefusal) emit("notify", `Inspector: ${error}`);
  },
);
onUnmounted(() => {
  if (inspectTimer) clearTimeout(inspectTimer);
  if (identTimer) clearTimeout(identTimer);
});

async function toggleInspect(): Promise<void> {
  if (inspectPending.value || !props.machineOnline) return;
  const on = !inspecting.value;

  if (isChrome.value && on) {
    // POL-67 — remote DevTools: open the tab NOW, inside the user gesture (popup blockers), then
    // arm in parallel. The server's entry route waits briefly for the arm ack before proxying, so
    // the tab and the handshake race safely.
    window.open(devtoolsUrl(props.screen.id), "_blank", "noopener");
  } else if (!isChrome.value && on) {
    const yes = window.confirm(
      `Open the Web Inspector on "${props.screen.friendlyName}"?\n\n` +
        `It appears ON that panel, so anyone looking at the screen will see it, and the page reloads ` +
        `so the inspector captures the whole load.`,
    );
    if (!yes) return;
  }
  inspectPending.value = true;
  // surf relaunches the browser, so its ack takes a few seconds (chrome acks near-instantly).
  // Give up waiting well after that, rather than leaving the button pending forever if the box
  // never answers.
  if (inspectTimer) clearTimeout(inspectTimer);
  inspectTimer = setTimeout(() => {
    if (!inspectPending.value) return;
    inspectPending.value = false;
    emit("notify", `${props.screen.friendlyName} did not confirm the inspector — check the screen.`);
  }, 20_000);

  const error = await store.inspectScreen(props.screen.id, on);
  if (error) {
    inspectPending.value = false;
    if (inspectTimer) clearTimeout(inspectTimer);
    emit("notify", error);
  }
}

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

    <!-- live preview tile (falls back to a neutral placeholder when offline / no frame yet) -->
    <div class="preview" :class="{ live: thumbUrl }">
      <div
        v-if="thumbUrl"
        class="preview-img"
        :style="{ backgroundImage: `url(${thumbUrl})` }"
        aria-hidden="true"
      ></div>
      <span v-else class="preview-empty" aria-hidden="true">▦</span>
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
        <span class="driven">Driven by {{ machineLabel }}</span>
        <span class="surfaces">
          {{ screen.surfaceCount }} {{ screen.surfaceCount === 1 ? "surface" : "surfaces" }}
        </span>
      </div>
    </div>

    <button class="ident-btn" :class="{ active: identing }" @click="ident">
      <span class="ident-dot"></span>{{ identing ? "Flashing…" : "Ident" }}
    </button>

    <button
      class="inspect-btn"
      :class="{ active: inspecting, pending: inspectPending }"
      :disabled="!machineOnline || inspectPending"
      :title="inspectTitle"
      :aria-pressed="inspecting"
      @click="toggleInspect"
    >
      <span class="inspect-glyph" aria-hidden="true">&lt;/&gt;</span>{{ inspectLabel }}
    </button>

    <button class="remove-btn" title="Remove this screen from the console" @click="remove">
      Remove
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
.remove-btn {
  padding: 7px 11px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-size: 12px;
  font-weight: 500;
  color: var(--bad);
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
  box-shadow: var(--shadow-sm);
}
.remove-btn:hover {
  background: var(--bad-soft);
  border-color: var(--bad);
}
</style>
