/**
 * @polyptic/agent — per-client reconciler.
 *
 * Dials the server's agent channel (outbound WS), enrolls this machine's outputs, and for
 * every screen the control plane assigns, points a player at it via the selected
 * DisplayBackend. Heartbeats `agent/status` (echoing the last applied revision) and
 * reconnects with backoff. Content never flows through here — that goes server → player
 * directly, which is what makes changes instant.
 *
 * Every inbound frame is parsed at the edge against the `@polyptic/protocol` contract;
 * every outbound frame is validated before it leaves.
 *
 * Phase 2a — identity overrides for multi-machine dev demos:
 *   - `POLYPTIC_MACHINE_ID` overrides the machine id (else `/etc/machine-id`, else "dev-mac").
 *   - `POLYPTIC_CONNECTOR`  overrides the advertised output connector (else "HDMI-1").
 * Together these let two agents on one box present distinct machine + screen identities,
 * so the persistent registry and the Admin UI have multiple machines to show.
 *
 * Phase 3c — multiple outputs from one agent (local video-wall demo):
 *   - `POLYPTIC_OUTPUTS` (comma-separated connector names, e.g. "HDMI-1,HDMI-2,HDMI-3") makes a
 *     single agent advertise one 1920×1080 output per connector, so one `bun run dev` yields ≥2
 *     screens to drag into a wall. Blanks are trimmed/skipped and duplicates de-duped. When unset,
 *     the agent advertises the single default output (POLYPTIC_CONNECTOR or the default connector),
 *     exactly as before.
 *
 * Output auto-discovery — advertise the compositor's REAL outputs:
 *   - The agent sits right next to the compositor, so by default it ASKS it which outputs exist
 *     (`DisplayBackend.discoverOutputs()` → sway `get_outputs` / xrandr) and advertises THOSE real
 *     connector names — retrying briefly because sway may still be warming up at hello time. This
 *     means an operator never hand-configures connector names and the control plane never targets a
 *     connector that doesn't exist (e.g. the guessed "HDMI-1" vs QEMU's actual "Virtual-1").
 *   - `POLYPTIC_OUTPUTS` / a non-empty `POLYPTIC_CONNECTOR` remain an explicit OVERRIDE/pin: when set
 *     they are honoured verbatim (the Phase 3c multi-output dev path is unchanged). dev-open (no
 *     compositor) and any failed discovery fall back to the configured/default connector, as before.
 *
 * Phase 2b — enrollment + durable credential (app-level identity; mTLS is a later layer):
 *   - `POLYPTIC_BOOTSTRAP_TOKEN` (if set) is sent on `agent/hello` for first-contact enrollment.
 *   - A durable per-machine `credential` is persisted locally (see ./credential.ts) and presented
 *     on every reconnect. The server stores only `sha256(credential)`.
 *   In the server's OPEN mode (no bootstrap token configured) both are simply ignored and the
 *   agent behaves exactly as in Phase 2a. In GATED mode the server may reply:
 *     - `server/enrolled` → persist the issued credential, then await admission,
 *     - `server/pending`  → recognised but awaiting operator approval (keep the WS open),
 *     - `server/rejected` → auth failed / machine rejected; the server closes the WS and the
 *        agent retries on a long backoff (never hammers),
 *     - `server/apply`    → admitted (Phase 2a behaviour, unchanged).
 */
import WebSocket from "ws";
import {
  AgentMessage,
  ServerToAgentMessage,
  parseMessage,
  PROTOCOL_VERSION,
} from "@polyptic/protocol";
import type { Output } from "@polyptic/protocol";
import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { selectBackend } from "./backends/select";
import type { DisplayBackend } from "./backends/types";
import { credentialPath, loadCredential, saveCredential } from "./credential";
import { applyConfigFileToEnv } from "./setup/config";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

// Seed process.env DEFAULTS from /etc/polyptic/agent.toml (written by `polyptic-agent setup`)
// BEFORE any config is read below. Real env vars (and the systemd unit's Environment=) always win,
// and an absent file is a no-op — so a dev box with no agent.toml behaves exactly as before. This
// is what makes the on-box config file take effect without changing how the agent reads its config.
applyConfigFileToEnv();

const SERVER_URL = process.env.POLYPTIC_SERVER_URL ?? "ws://localhost:8080/agent";
const HEARTBEAT_MS = 10_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10_000;
/** After a `server/rejected`, retry slowly so a rejected/unapproved machine never hammers. */
const REJECT_BACKOFF_MS = 60_000;

/** Default advertised connector when `POLYPTIC_CONNECTOR` is unset. */
const DEFAULT_CONNECTOR = "HDMI-1";

const here = dirname(fileURLToPath(import.meta.url));

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [agent] ${msg}`);
}

function logError(msg: string): void {
  console.error(`[${new Date().toISOString()}] [agent] ERROR: ${msg}`);
}

/**
 * Stable machine id. Resolution order:
 *   1. `POLYPTIC_MACHINE_ID` env override (multi-machine dev demos),
 *   2. `/etc/machine-id` (Linux),
 *   3. "dev-mac" fallback (e.g. macOS dev host).
 */
function readMachineId(): string {
  const override = process.env.POLYPTIC_MACHINE_ID?.trim();
  if (override) return override;
  try {
    const id = readFileSync("/etc/machine-id", "utf8").trim();
    if (id) return id;
  } catch {
    // not present (e.g. macOS dev host)
  }
  return "dev-mac";
}

/**
 * The advertised connector for this agent's single output. Overridable via
 * `POLYPTIC_CONNECTOR` so two agents on one box present distinct screens.
 * Phase 1/2a remain a single fixed 1080p output.
 */
function resolveConnector(): string {
  const override = process.env.POLYPTIC_CONNECTOR?.trim();
  return override && override.length > 0 ? override : DEFAULT_CONNECTOR;
}

/**
 * This machine's outputs.
 *
 * Phase 3c: if `POLYPTIC_OUTPUTS` is set (comma-separated connector names) this agent advertises
 * one 1920×1080 output per connector — so a single `bun run dev` can yield ≥2 screens for a local
 * video-wall demo. Blank entries are trimmed/skipped and duplicates de-duped (first wins). If the
 * variable is unset or yields no usable connector, fall back to the single default output on the
 * resolved connector — Phase 1/2a behaviour, unchanged.
 */
function resolveOutputs(defaultConnector: string): Output[] {
  const raw = process.env.POLYPTIC_OUTPUTS;
  if (raw !== undefined) {
    const seen = new Set<string>();
    const outputs: Output[] = [];
    for (const part of raw.split(",")) {
      const connector = part.trim();
      if (connector.length === 0 || seen.has(connector)) continue;
      seen.add(connector);
      outputs.push({ connector, width: 1920, height: 1080 });
    }
    if (outputs.length > 0) return outputs;
  }
  return [{ connector: defaultConnector, width: 1920, height: 1080 }];
}

/** Geometry advertised for a discovered output whose exact mode we don't (yet) re-query. */
const DISCOVERED_OUTPUT_WIDTH = 1920;
const DISCOVERED_OUTPUT_HEIGHT = 1080;
/** Short retry while the compositor (launched alongside the agent) finishes warming up (~5s). */
const DISCOVERY_ATTEMPTS = 5;
const DISCOVERY_RETRY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Has the operator/dev pinned the advertised outputs explicitly? `POLYPTIC_OUTPUTS` (any value,
 * including the Phase 3c multi-output dev path) or a non-empty `POLYPTIC_CONNECTOR` is treated as an
 * OVERRIDE and honoured verbatim — discovery is then skipped so behaviour is exactly as before.
 */
function hasExplicitOutputOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.POLYPTIC_OUTPUTS !== undefined) return true;
  const connector = env.POLYPTIC_CONNECTOR?.trim();
  return connector !== undefined && connector.length > 0;
}

/**
 * Ask the backend's compositor what outputs really exist, retrying briefly: the agent is launched
 * by sway, but sway may still be warming up at hello time. Returns the real connector names, or
 * `null` if every attempt yielded nothing (compositor unavailable / no outputs).
 */
async function discoverOutputsWithRetry(backend: DisplayBackend): Promise<string[] | null> {
  for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt++) {
    let names: string[] | null = null;
    try {
      names = await backend.discoverOutputs();
    } catch (err) {
      log(`output discovery attempt ${attempt}/${DISCOVERY_ATTEMPTS} errored: ${(err as Error).message}`);
    }
    if (names && names.length > 0) return names;
    if (attempt < DISCOVERY_ATTEMPTS) await sleep(DISCOVERY_RETRY_MS);
  }
  return null;
}

/**
 * The outputs to advertise on `agent/hello`, in priority order:
 *   1. Explicit override (`POLYPTIC_OUTPUTS` / non-empty `POLYPTIC_CONNECTOR`) → honoured verbatim
 *      (Phase 2a/3c behaviour, unchanged).
 *   2. Otherwise PREFER discovery: ask the selected (real) backend for the compositor's REAL output
 *      names — with a short retry while it warms up — and advertise those.
 *   3. Otherwise (dev-open / discovery unavailable / all retries failed) → the configured/default
 *      single connector, exactly as before.
 */
async function resolveAdvertisedOutputs(
  backend: DisplayBackend,
  defaultConnector: string,
): Promise<Output[]> {
  if (hasExplicitOutputOverride()) {
    const outputs = resolveOutputs(defaultConnector);
    log(
      `advertising ${outputs.length} explicitly configured output(s): ${outputs
        .map((o) => o.connector)
        .join(", ")}`,
    );
    return outputs;
  }

  // Only a real backend sits next to a compositor we can interrogate. dev-open has none, so skip the
  // (retrying) discovery entirely and advertise the configured/default connector — keeping dev
  // startup instant.
  if (backend.id !== "dev-open") {
    const discovered = await discoverOutputsWithRetry(backend);
    if (discovered && discovered.length > 0) {
      log(`advertising ${discovered.length} discovered output(s): ${discovered.join(", ")}`);
      return discovered.map((connector) => ({
        connector,
        width: DISCOVERED_OUTPUT_WIDTH,
        height: DISCOVERED_OUTPUT_HEIGHT,
      }));
    }
  }

  const outputs = resolveOutputs(defaultConnector);
  log(`no compositor outputs discovered; using configured/default connector ${defaultConnector}`);
  return outputs;
}

/** The operator-configured enrollment secret, if any (server GATED mode). */
function readBootstrapToken(): string | undefined {
  const token = process.env.POLYPTIC_BOOTSTRAP_TOKEN?.trim();
  return token && token.length > 0 ? token : undefined;
}

function readAgentVersion(): string {
  try {
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // ignore — fall through to default
  }
  return "0.0.0";
}

// Narrowed server-frame variants.
type ApplyMsg = Extract<ServerToAgentMessage, { t: "server/apply" }>;
type IdentMsg = Extract<ServerToAgentMessage, { t: "server/ident" }>;
type CaptureMsg = Extract<ServerToAgentMessage, { t: "server/capture" }>;
type EnrolledMsg = Extract<ServerToAgentMessage, { t: "server/enrolled" }>;
type PendingMsg = Extract<ServerToAgentMessage, { t: "server/pending" }>;
type RejectedMsg = Extract<ServerToAgentMessage, { t: "server/rejected" }>;

// ─────────────────────────────────────────────────────────────────────────────
// Agent
// ─────────────────────────────────────────────────────────────────────────────

class Agent {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closing = false;
  /** Set when the server `server/rejected` us; drives a long reconnect backoff (no hammering). */
  private rejected = false;

  /** Durable app-level identity. Loaded from disk at boot; (re)issued via `server/enrolled`. */
  private credential: string | null;

  private lastAppliedRevision = 0;
  /** connector → player URL currently placed (dedupes repeat opens on reconnect/re-apply). */
  private readonly placed = new Map<string, string>();
  /** connector → last placement outcome, reported in heartbeats. */
  private readonly status = new Map<string, { ok: boolean; note?: string }>();

  constructor(
    private readonly url: string,
    private readonly machineId: string,
    private readonly agentVersion: string,
    private readonly backend: DisplayBackend,
    private readonly outputs: Output[],
    private readonly bootstrapToken: string | undefined,
    credential: string | null,
  ) {
    this.credential = credential;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.closing = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }

  // ── connection lifecycle ───────────────────────────────────────────────────

  private connect(): void {
    log(`connecting to ${this.url} …`);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      // A fresh connection: clear the stale "rejected" flag. If the server rejects us again it
      // re-sets the flag before close, so the long backoff persists across rejection cycles.
      this.rejected = false;
      log("agent channel open — enrolling");
      this.sendHello();
      this.startHeartbeat();
    });

    ws.on("message", (raw) => {
      const text = Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : Buffer.from(raw).toString("utf8");
      void this.onMessage(text);
    });

    ws.on("error", (err: Error) => {
      log(`ws error: ${err.message}`);
    });

    ws.on("close", (code: number) => {
      log(`agent channel closed (code ${code})`);
      this.stopHeartbeat();
      if (!this.closing) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    let delay: number;
    if (this.rejected) {
      // Rejected/unapproved: back off hard so we don't hammer the control plane. An operator
      // approving the machine (or a new credential) will be picked up on the next slow retry.
      delay = REJECT_BACKOFF_MS + Math.floor(Math.random() * 1_000);
      log(`reconnecting in ${delay}ms after rejection (slow retry — awaiting approval)`);
    } else {
      const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
      delay = backoff + Math.floor(Math.random() * 250);
      this.attempt += 1;
      log(`reconnecting in ${delay}ms (attempt ${this.attempt})`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ── inbound ──────────────────────────────────────────────────────────────────

  private async onMessage(text: string): Promise<void> {
    let msg: ServerToAgentMessage;
    try {
      msg = parseMessage(ServerToAgentMessage, text);
    } catch (err) {
      log(`dropping invalid server frame: ${(err as Error).message}`);
      return;
    }

    switch (msg.t) {
      case "server/apply":
        await this.onApply(msg);
        break;
      case "server/ident":
        await this.onIdent(msg);
        break;
      case "server/capture":
        await this.onCapture(msg);
        break;
      case "server/enrolled":
        this.onEnrolled(msg);
        break;
      case "server/pending":
        this.onPending(msg);
        break;
      case "server/rejected":
        this.onRejected(msg);
        break;
    }
  }

  private async onApply(msg: ApplyMsg): Promise<void> {
    if (msg.machineId !== this.machineId) {
      log(`ignoring apply for machine ${msg.machineId} (we are ${this.machineId})`);
      return;
    }
    this.lastAppliedRevision = msg.revision;
    log(`apply revision ${msg.revision} — ${msg.screens.length} screen(s)`);

    const wanted = new Set<string>();
    for (const screen of msg.screens) {
      wanted.add(screen.connector);
      if (this.placed.get(screen.connector) === screen.playerUrl) {
        // already pointed at this URL — nothing to do (content updates over the player channel)
        this.status.set(screen.connector, { ok: true });
        continue;
      }
      try {
        await this.backend.showScreen(screen.connector, screen.playerUrl);
        this.placed.set(screen.connector, screen.playerUrl);
        this.status.set(screen.connector, { ok: true });
        log(`placed ${screen.screenId} on ${screen.connector}`);
      } catch (err) {
        const note = (err as Error).message;
        this.status.set(screen.connector, { ok: false, note });
        log(`FAILED to place ${screen.screenId} on ${screen.connector}: ${note}`);
      }
    }

    // Retire any output no longer in the desired set.
    for (const connector of [...this.placed.keys()]) {
      if (wanted.has(connector)) continue;
      try {
        await this.backend.hideScreen(connector);
      } catch (err) {
        log(`hideScreen(${connector}) failed: ${(err as Error).message}`);
      }
      this.placed.delete(connector);
      this.status.delete(connector);
    }

    // Ack the new state immediately rather than waiting for the next heartbeat tick.
    this.sendStatus();
  }

  /**
   * Inbound `server/ident` on the agent channel.
   *
   * Phase 2a: the VISIBLE ident flash is server → player (`server/ident-pulse`, rendered by
   * the player overlay), so the agent is not required to act here. We log the frame and, for
   * Phase 1 continuity, still forward it to the backend (a no-op log under `dev-open`). Any
   * backend failure is caught and logged — an ident must never crash the reconciler.
   */
  private async onIdent(msg: IdentMsg): Promise<void> {
    log(
      `server/ident received (on=${msg.on}) — visible ident is server→player; no agent action required in Phase 2a`,
    );
    try {
      await this.backend.ident(msg.on);
    } catch (err) {
      log(`ident(${msg.on}) failed: ${(err as Error).message}`);
    }
  }

  private async onCapture(msg: CaptureMsg): Promise<void> {
    const targets = msg.connector ? [msg.connector] : this.outputs.map((o) => o.connector);
    for (const connector of targets) {
      try {
        const buf = await this.backend.capture(connector);
        if (!buf) continue; // dev-open has no capture facility
        this.send({
          t: "agent/thumbnail",
          machineId: this.machineId,
          connector,
          mime: "image/jpeg",
          dataBase64: buf.toString("base64"),
        });
      } catch (err) {
        log(`capture(${connector}) failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * `server/enrolled` — the server issued (or re-issued) this machine's durable credential.
   * Persist the RAW credential locally so future reconnects authenticate without the bootstrap
   * token. The connection stays open; admission follows via `server/apply` (if approved) or we
   * sit in `server/pending` until an operator approves.
   */
  private onEnrolled(msg: EnrolledMsg): void {
    this.credential = msg.credential;
    try {
      saveCredential(this.machineId, msg.credential);
      log(`enrolled (status=${msg.status}) — credential persisted to ${credentialPath(this.machineId)}`);
    } catch (err) {
      logError(
        `enrolled (status=${msg.status}) but FAILED to persist credential to ${credentialPath(this.machineId)}: ${(err as Error).message} — will re-enroll on next reconnect`,
      );
    }
  }

  /** `server/pending` — recognised but awaiting operator approval. Keep the WS open; no apply yet. */
  private onPending(msg: PendingMsg): void {
    log(
      `awaiting operator approval${msg.reason ? ` — ${msg.reason}` : ""} (connection kept open; will receive server/apply once approved)`,
    );
  }

  /**
   * `server/rejected` — authentication failed (bad/absent token & credential) or the machine was
   * rejected by an operator. The server closes the WS after this frame; we must NOT crash. Flag a
   * long reconnect backoff so a rejected machine retries slowly instead of hammering.
   */
  private onRejected(msg: RejectedMsg): void {
    this.rejected = true;
    logError(
      `enrollment rejected by server: ${msg.reason}. ` +
        `Provide a valid POLYPTIC_BOOTSTRAP_TOKEN or wait for operator approval. ` +
        `Retrying slowly (~${Math.round(REJECT_BACKOFF_MS / 1000)}s).`,
    );
    // The server closes the connection; the `close` handler will scheduleReconnect() with the
    // long backoff because `this.rejected` is now set.
  }

  // ── outbound ─────────────────────────────────────────────────────────────────

  private sendHello(): void {
    // Both `bootstrapToken` and `credential` are optional. The server ignores them in OPEN mode
    // (Phase 2a behaviour) and uses them to enrol in GATED mode. `undefined` values are dropped by
    // JSON.stringify, so an agent with neither sends a plain Phase-2a hello.
    const hello: AgentMessage = {
      t: "agent/hello",
      protocol: PROTOCOL_VERSION,
      machineId: this.machineId,
      agentVersion: this.agentVersion,
      backend: this.backend.id,
      outputs: this.outputs,
      hostname: osHostname(),
      bootstrapToken: this.bootstrapToken,
      credential: this.credential ?? undefined,
    };
    this.send(hello);
  }

  private sendStatus(): void {
    const screens = [...this.status.entries()].map(([connector, st]) => {
      const entry: { connector: string; ok: boolean; note?: string } = {
        connector,
        ok: st.ok,
      };
      if (st.note !== undefined) entry.note = st.note;
      return entry;
    });
    this.send({
      t: "agent/status",
      machineId: this.machineId,
      observedRevision: this.lastAppliedRevision,
      screens,
    });
  }

  private send(msg: AgentMessage): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log(`cannot send ${msg.t}: socket not open`);
      return;
    }
    // Validate against the contract before it leaves the process.
    const valid = AgentMessage.parse(msg);
    ws.send(JSON.stringify(valid));
  }

  // ── heartbeat ────────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.sendStatus();
    this.heartbeatTimer = setInterval(() => this.sendStatus(), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Subcommand dispatch: `polyptic-agent setup …` provisions/tears down the on-device stack
  // (greetd autologin → sway → systemd-supervised agent → Chromium-per-output). The setup CLI and
  // its (heavier) provisioning machinery are loaded lazily so the normal agent boot path never pays
  // for them. Anything other than `setup` runs the existing reconciler loop below, unchanged.
  if (process.argv[2] === "setup") {
    void import("./setup/index")
      .then(({ runSetupCli }) => runSetupCli(process.argv.slice(3)))
      .then((code) => process.exit(code))
      .catch((err) => {
        console.error(`[setup] fatal: ${(err as Error).message}`);
        process.exit(1);
      });
    return;
  }

  const machineId = readMachineId();
  const connector = resolveConnector();
  const agentVersion = readAgentVersion();
  const backend = selectBackend();
  // Prefer the compositor's REAL outputs over a guessed default (unless explicitly overridden).
  const outputs = await resolveAdvertisedOutputs(backend, connector);
  const bootstrapToken = readBootstrapToken();
  const credential = loadCredential(machineId);

  log(
    `polyptic-agent v${agentVersion} · machineId=${machineId} · outputs=${outputs
      .map((o) => o.connector)
      .join(",")} · backend=${backend.id}`,
  );
  log(
    `enrollment: ${credential ? "stored credential found" : "no stored credential"}${
      bootstrapToken ? " · bootstrap token present" : ""
    } (open mode ignores both)`,
  );

  const agent = new Agent(
    SERVER_URL,
    machineId,
    agentVersion,
    backend,
    outputs,
    bootstrapToken,
    credential,
  );
  agent.start();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`received ${sig} — shutting down`);
      agent.stop();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logError(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
