/**
 * Admin console — the operator-facing view of the live registry.
 *
 * Connects to the server's /admin channel, renders the pushed `admin/state` snapshot, and exposes
 * the two Phase 2a operator actions: rename a screen and pulse ident (per screen, or all of a
 * machine's screens). Snapshots are reconciled BY id so an in-flight rename keeps focus while the
 * surrounding registry repaints live.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { MachineView, ScreenView, ServerToAdminMessage } from "@polyptych/protocol";
import { AdminSocket, type ConnState } from "./ws";

const SERVER_WS_URL = "ws://localhost:8080/admin";
const API_BASE = "http://localhost:8080/api/v1";
const IDENT_TTL_MS = 4000;

function connLabel(state: ConnState): string {
  switch (state) {
    case "open":
      return "live";
    case "connecting":
      return "connecting";
    case "closed":
      return "offline";
  }
}

/** POST JSON to the control plane, swallowing/logging transport errors so the UI never wedges. */
async function postJson(path: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[admin] POST ${path} -> ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[admin] POST ${path} failed`, err);
    return false;
  }
}

/** Human-friendly "last seen" relative to a ticking clock (so the value stays fresh on screen). */
function formatLastSeen(iso: string | undefined, nowMs: number): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const secs = Math.max(0, Math.round((nowMs - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** One screen row: status dot, inline rename, metadata chips, and an ident pulse button. */
function ScreenRow(props: { screen: ScreenView }): JSX.Element {
  const [draft, setDraft] = createSignal(props.screen.friendlyName);
  const [focused, setFocused] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // Mirror inbound name changes into the draft unless the operator is mid-edit (keeps focus/typed text).
  createEffect(() => {
    const incoming = props.screen.friendlyName;
    if (!focused()) setDraft(incoming);
  });

  const trimmed = createMemo(() => draft().trim());
  const canRename = createMemo(() => {
    const n = trimmed();
    return n.length >= 1 && n.length <= 64 && n !== props.screen.friendlyName;
  });

  const submitRename = async (): Promise<void> => {
    if (busy() || !canRename()) return;
    setBusy(true);
    await postJson(`/screens/${encodeURIComponent(props.screen.id)}/rename`, {
      friendlyName: trimmed(),
    });
    setBusy(false);
    // The server broadcasts admin/state; the createEffect above re-syncs the draft on the next snapshot.
  };

  const identScreen = async (): Promise<void> => {
    await postJson(`/screens/${encodeURIComponent(props.screen.id)}/ident`, {
      on: true,
      ttlMs: IDENT_TTL_MS,
    });
  };

  return (
    <li class="screen">
      <span
        class="dot"
        classList={{ "dot--online": props.screen.online, "dot--offline": !props.screen.online }}
        title={props.screen.online ? "player connected" : "player offline"}
      />

      <div class="screen-name">
        <input
          class="rename-input"
          value={draft()}
          disabled={busy()}
          spellcheck={false}
          autocomplete="off"
          aria-label={`Rename ${props.screen.friendlyName}`}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void submitRename();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setDraft(props.screen.friendlyName);
              e.currentTarget.blur();
            }
          }}
        />
        <button
          class="btn btn--rename"
          disabled={!canRename() || busy()}
          onClick={() => void submitRename()}
        >
          Rename
        </button>
      </div>

      <div class="screen-meta">
        <span class="chip mono">{props.screen.id}</span>
        <span class="chip chip--ghost">{props.screen.connector}</span>
        <span class="mono screen-rev">rev {props.screen.revision}</span>
        <span class="screen-surfaces">
          {props.screen.surfaceCount} {props.screen.surfaceCount === 1 ? "surface" : "surfaces"}
        </span>
      </div>

      <button class="btn btn--ident" onClick={() => void identScreen()}>
        Ident
      </button>
    </li>
  );
}

/** One machine card: header (status, label, id, backend, agent, last-seen, ident-all) + its screens. */
function MachineCard(props: { machine: MachineView; now: number }): JSX.Element {
  const identAll = async (): Promise<void> => {
    await postJson(`/machines/${encodeURIComponent(props.machine.id)}/ident`, {
      on: true,
      ttlMs: IDENT_TTL_MS,
    });
  };

  return (
    <section class="machine" classList={{ "machine--offline": !props.machine.online }}>
      <header class="machine-head">
        <div class="machine-ident">
          <span
            class="dot dot--lg"
            classList={{
              "dot--online": props.machine.online,
              "dot--offline": !props.machine.online,
            }}
            title={props.machine.online ? "agent connected" : "agent offline"}
          />
          <div class="machine-id-text">
            <span class="machine-label">{props.machine.label}</span>
            <span class="machine-uid mono">{props.machine.id}</span>
          </div>
        </div>

        <div class="machine-meta">
          <Show when={props.machine.backend}>
            {(b) => <span class="chip">{b()}</span>}
          </Show>
          <Show when={props.machine.agentVersion}>
            {(v) => <span class="chip chip--ghost">agent {v()}</span>}
          </Show>
          <span class="machine-seen">
            {props.machine.online
              ? "online"
              : `last seen ${formatLastSeen(props.machine.lastSeen, props.now)}`}
          </span>
          <button
            class="btn btn--ident"
            onClick={() => void identAll()}
            disabled={props.machine.screens.length === 0}
          >
            Ident all
          </button>
        </div>
      </header>

      <Show
        when={props.machine.screens.length > 0}
        fallback={<p class="machine-empty">No screens enrolled on this machine yet.</p>}
      >
        <ul class="screens">
          <For each={props.machine.screens}>{(s) => <ScreenRow screen={s} />}</For>
        </ul>
      </Show>
    </section>
  );
}

export function Admin(): JSX.Element {
  // Reconciled BY id so machines/screens keep stable identity across snapshots — an in-flight
  // rename input keeps focus while everything around it repaints live.
  const [state, setState] = createStore<{ revision: number; machines: MachineView[] }>({
    revision: -1,
    machines: [],
  });
  const [connState, setConnState] = createSignal<ConnState>("connecting");
  const [now, setNow] = createSignal(Date.now());

  let socket: AdminSocket | undefined;

  const handleMessage = (msg: ServerToAdminMessage): void => {
    if (msg.t === "admin/state") {
      setState("revision", msg.revision);
      setState("machines", reconcile(msg.machines, { key: "id" }));
    }
  };

  const screenCount = createMemo(() =>
    state.machines.reduce((sum, m) => sum + m.screens.length, 0),
  );

  onMount(() => {
    socket = new AdminSocket(SERVER_WS_URL, {
      onMessage: handleMessage,
      onState: setConnState,
    });
    socket.start();

    // Tick so "last seen" stays fresh without waiting for the next server push.
    const clock = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(clock));
  });

  onCleanup(() => socket?.stop());

  return (
    <div class="admin">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true" />
          <div class="brand-text">
            <h1>Polyptych</h1>
            <p class="brand-sub">Display-wall control</p>
          </div>
        </div>

        <div class="topbar-status">
          <span class="count">
            {state.machines.length} {state.machines.length === 1 ? "machine" : "machines"}
            <span class="count-sep"> · </span>
            {screenCount()} {screenCount() === 1 ? "screen" : "screens"}
          </span>
          <span class="conn">
            <span
              class="dot"
              classList={{
                "dot--online": connState() === "open",
                "dot--offline": connState() === "closed",
                "dot--pending": connState() === "connecting",
              }}
            />
            <span class="conn-label">{connLabel(connState())}</span>
            <span class="conn-sep">·</span>
            <span class="mono">rev {state.revision < 0 ? "—" : state.revision}</span>
          </span>
        </div>
      </header>

      <main class="content">
        <Show
          when={state.machines.length > 0}
          fallback={
            <div class="empty">
              <span class="empty-spinner" aria-hidden="true" />
              <p class="empty-title">Waiting for machines…</p>
              <p class="empty-sub">
                Start an agent and it will appear here. Connection:{" "}
                <span class="mono">{connLabel(connState())}</span>.
              </p>
            </div>
          }
        >
          <div class="machines">
            <For each={state.machines}>{(m) => <MachineCard machine={m} now={now()} />}</For>
          </div>
        </Show>
      </main>
    </div>
  );
}
