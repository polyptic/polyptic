<!--
  MachineTerminal.vue — the operator's remote shell on a running box (POL-59).

  A kiosk box dials OUT to the control plane (D12); there is nothing to SSH into. This component
  tunnels a real terminal over the SAME authenticated /admin socket the console already holds: it
  opens a session (`admin/shell-open`), streams keystrokes up and PTY bytes down (base64), and honours
  resize. The shell on the far side is UNPRIVILEGED (the kiosk user) and cannot change what the wall
  displays — it is for looking, not touching pixels.

  xterm.js does the terminal emulation (cursor addressing, colours, alt-screen) so `top`, `journalctl`
  and editors render correctly. Bytes are base64 so a PTY's raw output survives the JSON frames.
-->
<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { onBeforeUnmount, onMounted, ref } from "vue";

import { useConsoleStore } from "../stores/console";

const props = defineProps<{ machineId: string; machineLabel: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

const store = useConsoleStore();
const host = ref<HTMLDivElement | null>(null);
const statusLine = ref("Connecting…");
const connected = ref(false);

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let sessionId: string | null = null;
let unsubscribe: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;

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
    theme: { background: "#0b0f14" },
    scrollback: 5000,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value);
  fit.fit();

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
        term?.writeln(`\r\n\x1b[31mRemote shell refused: ${f.reason ?? "unknown reason"}\x1b[0m`);
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

  // Keep the PTY sized to the panel.
  resizeObserver = new ResizeObserver(() => {
    fit?.fit();
    pushResize();
  });
  resizeObserver.observe(host.value);
  term.focus();
});

function pushResize(): void {
  if (term && sessionId) {
    store.sendShellFrame({ t: "admin/shell-resize", machineId: props.machineId, sessionId, cols: term.cols, rows: term.rows });
  }
}

onBeforeUnmount(() => {
  if (sessionId) store.sendShellFrame({ t: "admin/shell-close", machineId: props.machineId, sessionId });
  resizeObserver?.disconnect();
  unsubscribe?.();
  term?.dispose();
});
</script>

<template>
  <div class="term-overlay" @click.self="emit('close')">
    <div class="term-panel">
      <div class="term-head">
        <div class="term-title">
          <span class="term-dot" :class="{ live: connected }"></span>
          Remote shell — {{ machineLabel }}
        </div>
        <div class="term-status">{{ statusLine }}</div>
        <button class="term-close" title="Close terminal" @click="emit('close')">✕</button>
      </div>
      <div ref="host" class="term-host"></div>
      <div class="term-foot">
        Unprivileged shell (kiosk user). It cannot change what the wall displays. Closing ends the session.
      </div>
    </div>
  </div>
</template>

<style scoped>
.term-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}
.term-panel {
  width: min(920px, 92vw);
  height: min(560px, 84vh);
  display: flex;
  flex-direction: column;
  background: #0b0f14;
  border: 1px solid var(--border, #23303c);
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.term-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: #10161d;
  border-bottom: 1px solid var(--border, #23303c);
}
.term-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #e6edf3;
}
.term-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #6b7683;
}
.term-dot.live {
  background: #34d399;
  box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.2);
}
.term-status {
  flex: 1;
  color: #93a1b0;
  font-size: 13px;
}
.term-close {
  border: none;
  background: transparent;
  color: #93a1b0;
  font-size: 15px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
}
.term-close:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #e6edf3;
}
.term-host {
  flex: 1;
  min-height: 0;
  padding: 8px 10px;
}
.term-foot {
  padding: 8px 14px;
  font-size: 12px;
  color: #7c8896;
  background: #10161d;
  border-top: 1px solid var(--border, #23303c);
}
</style>
