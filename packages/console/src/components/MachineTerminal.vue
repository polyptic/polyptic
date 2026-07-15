<!--
  MachineTerminal.vue — the operator's full-screen console on a running box (POL-59, POL-68).

  A kiosk box dials OUT to the control plane (D12); there is nothing to SSH into. This component
  tunnels a real terminal over the SAME authenticated /admin socket the console already holds: it
  opens a session (`admin/shell-open`), streams keystrokes up and PTY bytes down (base64), and honours
  resize. The shell on the far side is UNPRIVILEGED (the kiosk user) and cannot change what the wall
  displays — it is for looking, not touching pixels.

  POL-68 made this a full-screen view (not a modal): a header with "← Machines", the machine's
  name + id, live Online / Console enabled chips, and a reminder that sessions land in the activity
  feed; below it, the terminal fills the rest of the viewport.

  xterm.js does the terminal emulation (cursor addressing, colours, alt-screen) so `top`, `journalctl`
  and editors render correctly. Bytes are base64 so a PTY's raw output survives the JSON frames.
-->
<script setup lang="ts">
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { useConsoleStore } from "../stores/console";
import { fitGrid } from "./termFit";

const props = defineProps<{ machineId: string; machineLabel: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

const store = useConsoleStore();
const host = ref<HTMLDivElement | null>(null);
const statusLine = ref("Connecting…");
const connected = ref(false);

// Live chips track the authoritative admin/state, not the props at open time — if the box drops or
// an operator disables the console elsewhere, the header says so.
const machine = computed(() => store.machineById(props.machineId));
const online = computed(() => machine.value?.online ?? false);
const shellEnabled = computed(() => machine.value?.shellEnabled ?? false);

let term: Terminal | null = null;
let sessionId: string | null = null;
let unsubscribe: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;

/** xterm keeps its measured cell metrics on the (stable, but private) core — same source FitAddon read. */
type XtermWithCore = Terminal & {
  _core?: {
    _renderService?: { clear(): void; dimensions?: { css?: { cell?: { width: number; height: number } } } };
    viewport?: { scrollBarWidth?: number };
  };
};

/**
 * Fit the terminal to the largest WHOLE-cell grid inside `.term-host`'s content box (POL-131).
 *
 * FitAddon is gone: under the app's `* { box-sizing: border-box }` reset it measured the host's
 * border-box height, counted the padding as rows, and painted the bottom row — the prompt —
 * half-clipped once the buffer filled. Here the content box is measured explicitly (clientWidth/
 * Height minus computed padding, so fractional padding at odd zooms is exact), the grid is floored
 * to whole cells (termFit.ts), and the leftover fraction of a row is letterboxed by the host's own
 * background instead of clipped. Whenever the grid actually changes, the SAME cols×rows go to the
 * PTY over the relay, so `stty size` on the box always matches what the operator can see.
 */
function refit(): void {
  if (!term || !host.value) return;
  const core = (term as XtermWithCore)._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  if (!cell) return;
  const cs = getComputedStyle(host.value);
  const contentW = host.value.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const contentH = host.value.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const grid = fitGrid(contentW, contentH, cell, core?.viewport?.scrollBarWidth ?? 0);
  if (!grid || (grid.cols === term.cols && grid.rows === term.rows)) return;
  core?._renderService?.clear();
  term.resize(grid.cols, grid.rows);
  pushResize();
}

const enc = new TextEncoder();
const b64encode = (s: string): string => btoa(String.fromCharCode(...enc.encode(s)));
const b64decodeToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

onMounted(() => {
  if (!host.value) return;
  term = new Terminal({
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: { background: "#0b0b0e" },
    scrollback: 5000,
  });
  term.open(host.value);
  refit();

  // Operator keystrokes → the box.
  term.onData((data) => {
    if (sessionId) store.sendShellFrame({ t: "admin/shell-data", machineId: props.machineId, sessionId, dataBase64: b64encode(data) });
  });

  // Downlink: PTY bytes + lifecycle, scoped to THIS machine.
  unsubscribe = store.onShellFrame((f) => {
    if (f.machineId !== props.machineId) return;
    if (f.t === "server/shell-opened") {
      if (f.ok && f.sessionId) {
        sessionId = f.sessionId;
        connected.value = true;
        statusLine.value = "Connected";
        pushResize();
      } else {
        statusLine.value = `Refused: ${f.reason ?? "unknown reason"}`;
        term?.writeln(`\r\n\x1b[31mConsole session refused: ${f.reason ?? "unknown reason"}\x1b[0m`);
      }
    } else if (f.t === "server/shell-data" && f.sessionId === sessionId && f.dataBase64) {
      term?.write(b64decodeToBytes(f.dataBase64));
    } else if (f.t === "server/shell-closed" && (!sessionId || f.sessionId === sessionId)) {
      connected.value = false;
      statusLine.value = `Session ended: ${f.reason ?? "closed"}`;
      term?.writeln(`\r\n\x1b[33m[session ended: ${f.reason ?? "closed"}]\x1b[0m`);
      sessionId = null;
    }
  });

  // Open the session.
  const ok = store.sendShellFrame({ t: "admin/shell-open", machineId: props.machineId, cols: term.cols, rows: term.rows });
  if (!ok) {
    statusLine.value = "Not connected to the control plane";
    term.writeln("\x1b[31mThe console is not connected to the control plane.\x1b[0m");
  }

  // Keep the grid (and through pushResize, the PTY) sized to the panel. The observer covers
  // layout changes; the window listener covers browser zoom, which changes xterm's fractional
  // cell metrics WITHOUT necessarily changing the host's CSS box.
  resizeObserver = new ResizeObserver(() => refit());
  resizeObserver.observe(host.value);
  window.addEventListener("resize", onWindowResize);
  term.focus();
});

function onWindowResize(): void {
  refit();
}

function pushResize(): void {
  if (term && sessionId) {
    store.sendShellFrame({ t: "admin/shell-resize", machineId: props.machineId, sessionId, cols: term.cols, rows: term.rows });
  }
}

onBeforeUnmount(() => {
  if (sessionId) store.sendShellFrame({ t: "admin/shell-close", machineId: props.machineId, sessionId });
  window.removeEventListener("resize", onWindowResize);
  resizeObserver?.disconnect();
  unsubscribe?.();
  term?.dispose();
});
</script>

<template>
  <div class="console-view">
    <div class="console-head">
      <button class="back-btn" @click="emit('close')">← Machines</button>
      <div class="who">
        <span class="who-name">{{ machineLabel }}</span>
        <span class="who-id">{{ machineId }}</span>
      </div>
      <span class="chip" :class="online ? 'chip-ok' : 'chip-bad'">{{ online ? "Online" : "Offline" }}</span>
      <span v-if="shellEnabled" class="chip chip-warn">Shell armed</span>
      <span v-if="!connected" class="session-status">{{ statusLine }}</span>
      <span class="spacer"></span>
      <span class="head-note">Session is logged to the activity feed</span>
    </div>
    <div ref="host" class="term-host"></div>
  </div>
</template>

<style scoped>
.console-view {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  background: #0b0b0e;
}
.console-head {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 56px;
  flex: 0 0 56px;
  padding: 0 18px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 11px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}
.back-btn:hover {
  background: var(--muted-bg);
}
.who {
  display: flex;
  align-items: baseline;
  gap: 9px;
  min-width: 0;
}
.who-name {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.who-id {
  font-size: 11px;
  color: var(--muted2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
}
.chip-ok {
  color: var(--ok);
  background: var(--ok-soft);
}
.chip-bad {
  color: var(--bad);
  background: var(--bad-soft);
}
.chip-warn {
  color: var(--warn);
  background: var(--warn-soft);
}
.session-status {
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.head-note {
  font-size: 11.5px;
  color: var(--muted2);
  white-space: nowrap;
}
.term-host {
  flex: 1;
  min-height: 0;
  padding: 12px 14px;
  /* The grid is floored to whole cells (termFit.ts); the sub-cell remainder letterboxes here
     against the shared background instead of a half-painted row (POL-131). */
  overflow: hidden;
}
</style>
