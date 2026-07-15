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
 *     the advertised outputs come from discovery (see the next block), not a fixed default.
 *
 * Output auto-discovery — advertise the compositor's REAL outputs (see ./outputs.ts):
 *   - The agent sits right next to the compositor, so by default it ASKS it which outputs exist
 *     (`DisplayBackend.discoverOutputs()` → sway `get_outputs` / xrandr) and advertises THOSE real
 *     connector names — retrying briefly because sway may still be warming up at hello time. This
 *     means an operator never hand-configures connector names and the control plane never targets a
 *     connector that doesn't exist (e.g. the guessed "HDMI-1" vs QEMU's actual "Virtual-1").
 *   - `POLYPTIC_OUTPUTS` / a non-empty `POLYPTIC_CONNECTOR` remain an explicit OVERRIDE/pin: when set
 *     they are honoured verbatim (the Phase 3c multi-output dev path is unchanged). dev-open (no
 *     compositor) falls back to the configured/default connector, as before.
 *   - POL-9: a REAL backend with NO override whose compositor reports nothing (it isn't up yet —
 *     e.g. the headless Stage-A system agent enrolling before Stage B installs/starts sway) advertises
 *     ZERO outputs, NOT a guessed default. A wrong-named placeholder screen breaks placement and
 *     lingers next to the real panels once the kiosk agent later advertises them.
 *
 * POL-25 — mTLS client identity (the transport layer on top of the 2b credential):
 *   - Whenever a hello leaves on the PLAIN channel (or the held cert nears expiry) it carries a
 *     fresh CSR; a server with mTLS enabled answers `server/enrolled.mtls` with a signed client
 *     cert + the deployment CA + the listener port. The bundle is persisted (see ./mtls.ts) and
 *     every subsequent reconnect dials that `wss://` listener presenting the cert — where a
 *     wrong/absent cert fails the TLS handshake outright.
 *   - After 3 consecutive failed mTLS dials the agent takes ONE plain-channel attempt (re-enrols
 *     via token/credential, picks up a fresh bundle — heals a rotated CA); that fallback session
 *     is sticky so a runtime that cannot present client certs never churns.
 *
 * Phase 2b — enrollment + durable credential (app-level identity; mTLS rides POL-25 above):
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
import type { KioskBrowser, MachineVitals, Output, PowerCapabilities } from "@polyptic/protocol";
import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { applyCastPinEvent } from "./backends/cast";
import { selectKioskBrowser } from "./backends/chrome";
import { selectBackend } from "./backends/select";
import type { DisplayBackend } from "./backends/types";
import { credentialPath, loadCredential, saveCredential } from "./credential";
import { readHostIdentity } from "./hardware";
import { DevtoolsManager } from "./devtools";
import {
  certNeedsRenewal,
  deriveMtlsUrl,
  generateKeyAndCsr,
  loadMtlsBundle,
  mtlsBundlePath,
  saveMtlsBundle,
} from "./mtls";
import type { MtlsBundleFile } from "./mtls";
import { rebootHost } from "./host";
import { ShellManager } from "./shell";
import { resolveAdvertisedOutputs, resolveConnector } from "./outputs";
import { applyConfigFileToEnv } from "./setup/config";
import { agentVersion } from "./version";
import { VitalsSampler } from "./vitals";

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
/** POL-25 — after this many consecutive failed mTLS dials, try the plain channel ONCE to re-enrol
 *  (heals a rotated CA / a server whose mTLS moved) before going back to the mTLS target. */
const MTLS_FALLBACK_AFTER = 3;

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

/** The operator-configured enrollment secret, if any (server GATED mode). */
function readBootstrapToken(): string | undefined {
  const token = process.env.POLYPTIC_BOOTSTRAP_TOKEN?.trim();
  return token && token.length > 0 ? token : undefined;
}

function readAgentVersion(): string {
  return agentVersion();
}

// Narrowed server-frame variants.
type ApplyMsg = Extract<ServerToAgentMessage, { t: "server/apply" }>;
type IdentMsg = Extract<ServerToAgentMessage, { t: "server/ident" }>;
type CaptureMsg = Extract<ServerToAgentMessage, { t: "server/capture" }>;
type RebootMsg = Extract<ServerToAgentMessage, { t: "server/reboot" }>;
type InspectMsg = Extract<ServerToAgentMessage, { t: "server/inspect" }>;
type DisplayPowerMsg = Extract<ServerToAgentMessage, { t: "server/display-power" }>;
type EnrolledMsg = Extract<ServerToAgentMessage, { t: "server/enrolled" }>;
type PendingMsg = Extract<ServerToAgentMessage, { t: "server/pending" }>;
type RejectedMsg = Extract<ServerToAgentMessage, { t: "server/rejected" }>;
type ShellOpenMsg = Extract<ServerToAgentMessage, { t: "server/shell-open" }>;
type ShellDataMsg = Extract<ServerToAgentMessage, { t: "server/shell-data" }>;
type ShellResizeMsg = Extract<ServerToAgentMessage, { t: "server/shell-resize" }>;
type ShellCloseMsg = Extract<ServerToAgentMessage, { t: "server/shell-close" }>;
type DevtoolsRequestMsg = Extract<ServerToAgentMessage, { t: "server/devtools-request" }>;

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

  /** POL-25 — the persisted mTLS bundle (client key+cert, pinned CA, wss target), when issued. */
  private mtls: MtlsBundleFile | null;
  /** The private key whose CSR rode the LAST hello — paired with the cert `server/enrolled` returns. */
  private pendingKeyPem: string | null = null;
  /** True while the CURRENT socket is the mTLS channel (drives fallback + reconnect-on-enrol). */
  private connectedViaMtls = false;
  /** True while the CURRENT socket is the one-shot plain fallback after repeated mTLS failures.
   *  A fallback session is STICKY: receiving a fresh bundle must not close it, or a runtime whose
   *  WS client cannot present certs would churn (fail mTLS → fall back → re-issue → close → loop). */
  private currentIsFallback = false;
  /** Did the current socket ever reach `open`? A close without it counts as a failed dial. */
  private socketOpened = false;
  /** Consecutive failed mTLS dials; at MTLS_FALLBACK_AFTER the next dial is a one-shot plain retry. */
  private mtlsFailStreak = 0;

  /** Remote-shell PTYs (POL-59), created on first `server/shell-open`. A dev/non-Linux backend
   *  reports it can't provide a real terminal, and every open on such a box is refused. */
  private shell: ShellManager | null = null;

  /** Remote-DevTools bridge (POL-67), created on first `server/devtools-*` frame. The backend's
   *  `devtoolsEndpoint` gate means a non-Chrome box simply refuses every request. */
  private devtools: DevtoolsManager | null = null;

  private lastAppliedRevision = 0;
  /** connector → player URL currently placed (dedupes repeat opens on reconnect/re-apply). */
  private readonly placed = new Map<string, string>();
  /** connector → last placement outcome, reported in heartbeats. */
  private readonly status = new Map<string, { ok: boolean; note?: string }>();
  /** POL-119 — connector → is a cast session live NOW (receiver window on the glass)? Entries exist
   *  only for cast-enabled connectors; reported in every status frame + immediately on change. */
  private readonly casting = new Map<string, boolean>();
  /** POL-136 — connector → the PIN a pairing sender must type right now. Entries exist only while a
   *  pairing is in progress; level-reported like `casting` (heartbeat + immediate on change) so the
   *  overlay self-heals across reconnects. */
  private readonly castPins = new Map<string, string>();

  /** POL-92 — host vitals, sampled from /proc on each heartbeat. Holds the previous CPU jiffy totals
   *  between samples (busy% is a delta), so it lives for the life of the agent, not the socket. */
  private readonly vitals = new VitalsSampler();

  constructor(
    private readonly url: string,
    private readonly machineId: string,
    private readonly agentVersion: string,
    private readonly backend: DisplayBackend,
    private readonly outputs: Output[],
    private readonly bootstrapToken: string | undefined,
    credential: string | null,
    /** Which kiosk browser this box drives (POL-67); undefined on dev-open (no kiosk browser). */
    private readonly browser: KioskBrowser | undefined,
    /** POL-101 — what this box can do about panel power (DPMS / CEC), probed once at startup. */
    private readonly power: PowerCapabilities,
    mtls: MtlsBundleFile | null = null,
  ) {
    this.credential = credential;
    this.mtls = mtls;
  }

  start(): void {
    // POL-119 — the backend's account of window presence IS the cast-session signal: push it up
    // the moment it changes (the console's "casting now"), on top of the level in every heartbeat.
    this.backend.onCastSession((connector, active) => {
      if (this.casting.get(connector) === active) return;
      if (!this.casting.has(connector)) return; // receiver already retired — stale event
      this.casting.set(connector, active);
      log(`cast session on ${connector}: ${active ? "started" : "ended"}`);
      this.sendStatus();
    });
    // POL-136 — the PIN a pairing sender must type: learned by the backend from the receiver's
    // stdout (the receiver never draws it), pushed up IMMEDIATELY so the panel shows it while the
    // phone is still asking, and level-reported in every heartbeat until the pairing ends.
    this.backend.onCastPin((connector, pin) => {
      // The ledger rules live in applyCastPinEvent (cast.ts, pinned by tests) — notably that a
      // null CLEAR applies even after the `casting` entry is gone, or a receiver-death ordering
      // could strand a stale PIN in every heartbeat.
      if (!applyCastPinEvent(this.castPins, (c) => this.casting.has(c), connector, pin)) return;
      log(
        pin === null
          ? `cast pairing PIN on ${connector} cleared`
          : `cast pairing PIN on ${connector}: ${pin} — reporting for the panel overlay`,
      );
      this.sendStatus();
    });
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
    // POL-25 — prefer the mTLS channel whenever we hold a cert bundle. After MTLS_FALLBACK_AFTER
    // consecutive failed dials, take ONE plain-channel attempt — it re-enrols via the token/credential
    // seam and picks up a fresh bundle, healing a rotated CA or a moved mTLS endpoint — then return
    // to the mTLS target.
    const fallbackNow = this.mtls !== null && this.mtlsFailStreak >= MTLS_FALLBACK_AFTER;
    if (fallbackNow) {
      log(
        `mTLS dial failed ${this.mtlsFailStreak} times — trying the plain channel once to re-enrol`,
      );
      this.mtlsFailStreak = 0;
    }
    const useMtls = this.mtls !== null && !fallbackNow;
    const target = useMtls && this.mtls ? this.mtls.url : this.url;
    log(`connecting to ${target}${useMtls ? " (mTLS, presenting client cert)" : ""} …`);
    let ws: WebSocket;
    if (useMtls && this.mtls) {
      // Node's ws reads key/cert/ca at the top level; Bun's built-in client reads them from a
      // non-standard `tls` option (measured — top-level is ignored there). Set both, pin OUR CA as
      // the only trust root.
      const tls = { key: this.mtls.keyPem, cert: this.mtls.certPem, ca: this.mtls.caPem };
      ws = new WebSocket(target, { ...tls, tls } as WebSocket.ClientOptions);
    } else {
      ws = new WebSocket(target);
    }
    this.ws = ws;
    this.connectedViaMtls = useMtls;
    this.currentIsFallback = fallbackNow;
    this.socketOpened = false;
    // A failed dial must count exactly once, whether the runtime reports it via error, close or both.
    let dialFailureCounted = false;
    const countDialFailure = () => {
      if (this.connectedViaMtls && !this.socketOpened && !dialFailureCounted) {
        dialFailureCounted = true;
        this.mtlsFailStreak += 1;
        log(`mTLS dial failed (${this.mtlsFailStreak}/${MTLS_FALLBACK_AFTER} before a plain-channel retry)`);
      }
    };

    ws.on("open", () => {
      this.attempt = 0;
      this.socketOpened = true;
      if (this.connectedViaMtls) this.mtlsFailStreak = 0;
      // A fresh connection: clear the stale "rejected" flag. If the server rejects us again it
      // re-sets the flag before close, so the long backoff persists across rejection cycles.
      this.rejected = false;
      log(`agent channel open${this.connectedViaMtls ? " (mTLS)" : ""} — enrolling`);
      void this.sendHello();
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
      // A handshake-stage error may not be followed by a close on every runtime; count it and make
      // sure a reconnect is queued (scheduleReconnect() no-ops when one already is).
      countDialFailure();
      if (!this.socketOpened && !this.closing) this.scheduleReconnect();
    });

    ws.on("close", (code: number) => {
      log(`agent channel closed (code ${code})`);
      countDialFailure();
      this.stopHeartbeat();
      // A remote shell / DevTools session is authorised by the live connection; kill them all when
      // it drops so a session can never outlive the socket that carried it (POL-59, POL-67).
      this.shell?.closeAll();
      this.devtools?.closeAll();
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
      case "server/reboot":
        await this.onReboot(msg);
        break;
      case "server/inspect":
        await this.onInspect(msg);
        break;
      case "server/display-power":
        await this.onDisplayPower(msg);
        break;
      case "server/enrolled":
        this.onEnrolled(msg);
        break;
      case "server/pending":
        await this.onPending(msg);
        break;
      case "server/rejected":
        this.onRejected(msg);
        break;
      case "server/shell-open":
        this.onShellOpen(msg);
        break;
      case "server/shell-data":
        this.shellMgr().data(msg.sessionId, msg.dataBase64);
        break;
      case "server/shell-resize":
        this.shellMgr().resize(msg.sessionId, msg.cols, msg.rows);
        break;
      case "server/shell-close":
        this.shellMgr().close(msg.sessionId, msg.reason);
        break;
      case "server/devtools-request":
        await this.onDevtoolsRequest(msg);
        break;
      case "server/devtools-open":
        this.devtoolsMgr().open(msg.sessionId, msg.connector, msg.path);
        break;
      case "server/devtools-data":
        this.devtoolsMgr().data(msg.sessionId, msg.dataBase64);
        break;
      case "server/devtools-close":
        this.devtoolsMgr().close(msg.sessionId, msg.reason);
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
      } else {
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
      await this.reconcileCast(screen);
    }

    // Retire any output no longer in the desired set.
    for (const connector of [...this.placed.keys()]) {
      if (wanted.has(connector)) continue;
      try {
        await this.backend.hideScreen(connector);
      } catch (err) {
        log(`hideScreen(${connector}) failed: ${(err as Error).message}`);
      }
      try {
        await this.backend.setCast(connector, null); // a retired output keeps no receiver either
      } catch (err) {
        log(`setCast(${connector}, off) failed: ${(err as Error).message}`);
      }
      this.placed.delete(connector);
      this.status.delete(connector);
      this.casting.delete(connector);
      this.castPins.delete(connector);
    }

    // Ack the new state immediately rather than waiting for the next heartbeat tick.
    this.sendStatus();
  }

  /**
   * POL-119 — reconcile one connector's cast receiver to the apply's desired state. A cast failure
   * must never fail the SCREEN (the wall renders fine without a receiver): it rides the status note
   * instead, so the console can say why casting isn't up without painting the panel red.
   */
  private async reconcileCast(screen: ApplyMsg["screens"][number]): Promise<void> {
    const enabled = screen.castEnabled === true;
    try {
      await this.backend.setCast(
        screen.connector,
        enabled ? { name: screen.friendlyName ?? screen.screenId } : null,
      );
      if (enabled && !this.casting.has(screen.connector)) this.casting.set(screen.connector, false);
      if (!enabled) {
        this.casting.delete(screen.connector);
        this.castPins.delete(screen.connector); // a torn-down receiver strands no PIN (POL-136)
      }
    } catch (err) {
      const reason = (err as Error).message;
      log(`setCast(${screen.connector}, ${enabled ? "on" : "off"}) failed: ${reason}`);
      this.casting.delete(screen.connector);
      this.castPins.delete(screen.connector);
      const st = this.status.get(screen.connector);
      this.status.set(screen.connector, {
        ok: st?.ok ?? true,
        note: st?.note ? `${st.note}; cast: ${reason}` : `cast: ${reason}`,
      });
    }
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
   * `server/reboot` — an operator asked the control plane to power-cycle this box (POL-55).
   *
   * We answer BEFORE the box goes down, so the console can distinguish "rebooting" from "fell off the
   * network". The trigger itself (see ./host.ts) returns long before systemd starts tearing the system
   * down — `systemctl --no-block` and the path-unit handshake are both asynchronous — so the ack is
   * both truthful about the outcome and still has time to reach the wire.
   *
   * A refusal (dev backend, non-Linux, no privileged helper) leaves the box up and running: the reason
   * rides back on the ack and surfaces in the console's activity feed.
   */
  private async onReboot(msg: RebootMsg): Promise<void> {
    log(`server/reboot received${msg.reason ? ` — ${msg.reason}` : ""}`);
    const outcome = await rebootHost(this.backend.id);
    this.send({
      t: "agent/reboot-ack",
      machineId: this.machineId,
      accepted: outcome.accepted,
      reason: outcome.reason,
    });
    if (outcome.accepted) log(`rebooting: ${outcome.reason}`);
    else logError(`refused to reboot: ${outcome.reason}`);
  }

  /** Lazily build the shell manager. `canPty` is false on the dev/non-Linux backends so every open
   *  is refused with a legible reason rather than a dead terminal. */
  private shellMgr(): ShellManager {
    if (!this.shell) {
      const canPty = process.platform === "linux" && this.backend.id !== "dev-open";
      this.shell = new ShellManager(
        {
          onData: (sessionId, dataBase64) =>
            this.send({ t: "agent/shell-data", machineId: this.machineId, sessionId, dataBase64 }),
          onClosed: (sessionId, reason, exitCode) =>
            this.send({ t: "agent/shell-closed", machineId: this.machineId, sessionId, reason, exitCode }),
        },
        "/bin/bash",
        canPty,
      );
    }
    return this.shell;
  }

  /** Lazily build the DevTools bridge (POL-67). All policy lives in `backend.devtoolsEndpoint`:
   *  a non-Chrome or disarmed connector refuses with the reason, never a dead proxy. */
  private devtoolsMgr(): DevtoolsManager {
    if (!this.devtools) {
      this.devtools = new DevtoolsManager(
        this.backend,
        {
          onResponse: (reqId, res) =>
            this.send({
              t: "agent/devtools-response",
              machineId: this.machineId,
              reqId,
              ...(res.ok
                ? { ok: true, status: res.status, contentType: res.contentType, bodyBase64: res.bodyBase64 }
                : { ok: false, error: res.error }),
            }),
          onOpened: (sessionId, ok, reason) =>
            this.send({ t: "agent/devtools-opened", machineId: this.machineId, sessionId, ok, reason }),
          onData: (sessionId, dataBase64) =>
            this.send({ t: "agent/devtools-data", machineId: this.machineId, sessionId, dataBase64 }),
          onClosed: (sessionId, reason) =>
            this.send({ t: "agent/devtools-closed", machineId: this.machineId, sessionId, reason }),
        },
        log,
      );
    }
    return this.devtools;
  }

  /** `server/devtools-request` — proxy one HTTP GET to the armed connector's DevTools port. */
  private async onDevtoolsRequest(msg: DevtoolsRequestMsg): Promise<void> {
    await this.devtoolsMgr().request(msg.reqId, msg.connector, msg.path);
  }

  /**
   * `server/shell-open` — an operator opened a terminal on this box (POL-59). The server only sends
   * this to an ARMED box, so policy is already enforced upstream; here we just try to allocate the
   * PTY and report whether it came up. The shell is the unprivileged kiosk user (whatever the agent
   * runs as) and cannot touch what the wall displays.
   */
  private onShellOpen(msg: ShellOpenMsg): void {
    const res = this.shellMgr().open(msg.sessionId, msg.cols, msg.rows);
    this.send({
      t: "agent/shell-opened",
      machineId: this.machineId,
      sessionId: msg.sessionId,
      ok: res.ok,
      reason: res.reason,
    });
    if (res.ok) log(`shell-open ${msg.sessionId} (${msg.cols}x${msg.rows})`);
    else logError(`shell-open ${msg.sessionId} refused: ${res.reason}`);
  }

  /**
   * `server/inspect` — pop (or dismiss) the kiosk browser's Web Inspector ON the wall (POL-50).
   *
   * Honouring this relaunches that output's browser, because surf only takes `-N` at launch, so the
   * page reloads. The ack carries the state we ACTUALLY reached: a failure here must never leave the
   * console showing an inspector that isn't on the panel, and the operator needs to know it was the
   * box that refused (nothing placed on that connector, no `xdotool`, a dev backend).
   */
  private async onInspect(msg: InspectMsg): Promise<void> {
    log(`server/inspect received (connector=${msg.connector} on=${msg.on})`);
    try {
      await this.backend.inspect(msg.connector, msg.on);
      this.send({
        t: "agent/inspect-ack",
        machineId: this.machineId,
        connector: msg.connector,
        on: msg.on,
        ok: true,
      });
      log(`inspector ${msg.on ? "opened on" : "closed on"} ${msg.connector}`);
    } catch (err) {
      const reason = (err as Error).message;
      this.send({
        t: "agent/inspect-ack",
        machineId: this.machineId,
        connector: msg.connector,
        on: false,
        ok: false,
        reason,
      });
      logError(`inspect(${msg.connector}, ${msg.on}) failed: ${reason}`);
    }
  }

  /**
   * `server/display-power` — sleep or wake ONE panel (POL-101).
   *
   * This is the ONLY thing in the agent that darkens a wall, and it fires only when the control plane
   * says so — an operator's click, or a panel-hours boundary an operator set. Nothing here is driven
   * by idleness; the compositor's no-blank discipline (`output * dpms on`, no swayidle) is untouched.
   *
   * The browser is deliberately NOT torn down: the player keeps its socket and its slice, so waking is
   * a DPMS/CEC command rather than a reload, and the wall lights up already showing its content (D5).
   *
   * The ack carries the state we actually reached and WHICH rungs got us there — DPMS alone means the
   * output is dark but the panel may still be lit; DPMS+CEC means the display itself was told to power
   * down. A failure acks `ok: false` and leaves the console reading the screen as awake, which is the
   * safe direction: never claim a wall is dark when it might not be.
   */
  private async onDisplayPower(msg: DisplayPowerMsg): Promise<void> {
    log(
      `server/display-power received (connector=${msg.connector} on=${msg.on})` +
        (msg.reason ? ` — ${msg.reason}` : ""),
    );
    try {
      const methods = await this.backend.setPower(msg.connector, msg.on);
      this.send({
        t: "agent/power-ack",
        machineId: this.machineId,
        connector: msg.connector,
        on: msg.on,
        ok: true,
        methods,
      });
      log(`panel ${msg.on ? "awake" : "asleep"} on ${msg.connector} via ${methods.join("+")}`);
    } catch (err) {
      const reason = (err as Error).message;
      this.send({
        t: "agent/power-ack",
        machineId: this.machineId,
        connector: msg.connector,
        on: msg.on,
        ok: false,
        methods: [],
        reason,
      });
      logError(`display-power(${msg.connector}, ${msg.on}) failed: ${reason}`);
    }
  }

  /**
   * `server/enrolled` — the server issued (or re-issued) this machine's durable credential and/or
   * its mTLS client-cert bundle (POL-25). Persist the RAW credential locally so future reconnects
   * authenticate without the bootstrap token. A cert bundle is paired with the private key whose
   * CSR rode our last hello (the key never crossed the wire), persisted, and — when we are on the
   * plain channel — acted on immediately: close and redial the mTLS listener.
   */
  private onEnrolled(msg: EnrolledMsg): void {
    if (msg.credential) {
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
    if (msg.mtls) {
      if (!this.pendingKeyPem) {
        logError("server issued an mTLS client cert but no CSR key is pending — ignoring the bundle");
        return;
      }
      const bundle: MtlsBundleFile = {
        keyPem: this.pendingKeyPem,
        certPem: msg.mtls.certPem,
        caPem: msg.mtls.caPem,
        url: deriveMtlsUrl(this.url, { port: msg.mtls.port, url: msg.mtls.url }),
      };
      this.mtls = bundle;
      this.mtlsFailStreak = 0;
      try {
        saveMtlsBundle(this.machineId, bundle);
        log(
          `mTLS client cert issued — bundle persisted to ${mtlsBundlePath(this.machineId)}; agent channel moves to ${bundle.url}`,
        );
      } catch (err) {
        logError(
          `mTLS client cert issued but FAILED to persist the bundle to ${mtlsBundlePath(this.machineId)}: ${(err as Error).message} — using it for this run only`,
        );
      }
      if (!this.connectedViaMtls && !this.currentIsFallback) {
        // Switch now rather than on the next drop — in require mode the server is about to close
        // this plain socket anyway; in roll-out mode this is what actually moves the fleet over.
        // EXCEPT on the post-failure fallback session: that one stays up until it drops naturally,
        // or a runtime that cannot present client certs would churn in a fail→fallback→close loop.
        log("switching to the mTLS channel — closing the plain connection");
        this.ws?.close();
      }
    }
  }

  /** `server/pending` — recognised but awaiting operator approval. Keep the WS open; no apply yet.
   *
   *  POL-46: a pending machine has no screens, so nothing was ever placed and the wall sat BLACK —
   *  indistinguishable from a dead box, and the operator had no on-screen clue what to do. Show the
   *  server-supplied pending board on EVERY output instead. `showScreen` is the same call `apply`
   *  makes, so the eventual approval simply swaps the URL in place (no remount, no flash). */
  private async onPending(msg: PendingMsg): Promise<void> {
    log(
      `awaiting operator approval${msg.reason ? ` — ${msg.reason}` : ""} (connection kept open; will receive server/apply once approved)`,
    );
    if (!msg.pendingUrl) return; // older server: nothing to show, keep the previous behaviour
    for (const output of this.outputs) {
      if (this.placed.get(output.connector) === msg.pendingUrl) continue;
      try {
        await this.backend.showScreen(output.connector, msg.pendingUrl);
        this.placed.set(output.connector, msg.pendingUrl);
      } catch (err) {
        logError(`failed to show the pending board on ${output.connector}: ${(err as Error).message}`);
      }
    }
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

  private async sendHello(): Promise<void> {
    // POL-25 — ask for a client cert whenever this connection is NOT the mTLS channel (no bundle
    // yet, or a fallback re-enrol) or the cert we hold is inside its renewal window. The keypair is
    // generated here and kept; only the CSR goes on the wire. A crypto failure never blocks the
    // hello — the agent then simply stays on its current identity.
    let csrPem: string | undefined;
    const wantCert =
      !this.connectedViaMtls || (this.mtls !== null && certNeedsRenewal(this.mtls.certPem));
    if (wantCert) {
      try {
        const generated = await generateKeyAndCsr(this.machineId);
        this.pendingKeyPem = generated.keyPem;
        csrPem = generated.csrPem;
      } catch (err) {
        logError(`could not generate an mTLS keypair/CSR: ${(err as Error).message}`);
      }
    }
    // Both `bootstrapToken` and `credential` are optional. The server ignores them in OPEN mode
    // (Phase 2a behaviour) and uses them to enrol in GATED mode. `undefined` values are dropped by
    // JSON.stringify, so an agent with neither sends a plain Phase-2a hello.
    const hello: AgentMessage = {
      t: "agent/hello",
      protocol: PROTOCOL_VERSION,
      machineId: this.machineId,
      agentVersion: this.agentVersion,
      backend: this.backend.id,
      browser: this.browser,
      power: this.power,
      outputs: this.outputs,
      hostname: osHostname(),
      // POL-105 — the OS image this box actually BOOTED (`/etc/polyptic/image-id`). Undefined on a
      // dev box with no live image, and dropped by JSON.stringify, so an old server ignores it.
      imageId: await this.vitals.bootedImageId().catch(() => undefined),
      // POL-104 — what this box IS (MACs / DMI serial / arch). Descriptive, never a credential: the
      // server uses it to match a pre-registration (after the token gate) and to make a pending
      // approval card readable. Sampled per hello so a re-cabled box re-reports honestly.
      hardware: readHostIdentity(),
      bootstrapToken: this.bootstrapToken,
      credential: this.credential ?? undefined,
      csrPem,
    };
    this.send(hello);
  }

  /**
   * The heartbeat. Carries the observed revision + per-connector placement outcome, and — POL-92 —
   * a cheap /proc sample of the box's own health (CPU/mem/disk/temp, per-browser RSS + respawns, and
   * the `/dev/dri` GPU tell that catches a software-rendering browser before it cooks the box).
   *
   * The sample is best-effort and NEVER blocks the heartbeat: a host with no /proc (a dev laptop)
   * samples nothing and the frame goes out without `vitals` — exactly what a pre-POL-92 agent sends.
   */
  private async sendStatus(): Promise<void> {
    const screens = [...this.status.entries()].map(([connector, st]) => {
      const entry: { connector: string; ok: boolean; note?: string; casting?: boolean; castPin?: string } = {
        connector,
        ok: st.ok,
      };
      if (st.note !== undefined) entry.note = st.note;
      // POL-119 — level-report the live session per cast-enabled connector (absent = not castable).
      const casting = this.casting.get(connector);
      if (casting !== undefined) entry.casting = casting;
      // POL-136 — level-report the pairing PIN while a sender is pairing (absent = no pairing).
      const castPin = this.castPins.get(connector);
      if (castPin !== undefined) entry.castPin = castPin;
      return entry;
    });
    let vitals: MachineVitals | undefined;
    try {
      vitals = await this.vitals.sample(this.backend.browserProbes?.() ?? []);
    } catch (err) {
      // Telemetry must never cost a heartbeat: a machine that stops heartbeating reads as OFFLINE.
      log(`vitals sample failed (heartbeat continues without them): ${(err as Error).message}`);
    }
    this.send({
      t: "agent/status",
      machineId: this.machineId,
      observedRevision: this.lastAppliedRevision,
      screens,
      vitals,
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
    void this.sendStatus();
    this.heartbeatTimer = setInterval(() => void this.sendStatus(), HEARTBEAT_MS);
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
  // (greetd autologin → sway → systemd-supervised agent → surf-per-output). The setup CLI and
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
  // Prefer the compositor's REAL outputs over a guessed default (unless explicitly overridden). A
  // real backend whose compositor isn't up yet advertises ZERO outputs — no phantom screen (POL-9).
  const outputs = await resolveAdvertisedOutputs(backend, connector, { log });
  const bootstrapToken = readBootstrapToken();
  const credential = loadCredential(machineId);
  // POL-67 — which kiosk browser this box drives, reported on hello so the console knows whether
  // Inspect means remote DevTools (chrome) or the on-panel inspector (surf). The SAME selection the
  // sway backend makes at launch; x11-i3 only ever drives surf, and dev-open owns no browser.
  const browser: KioskBrowser | undefined =
    backend.id === "wayland-sway" ? await selectKioskBrowser() : backend.id === "x11-i3" ? "surf" : undefined;
  const mtlsBundle = loadMtlsBundle(machineId);
  // POL-101 — probe panel power ONCE at startup (is there a CEC adapter this user can open?) and
  // report it on hello, so the console can be honest about whether "sleep" darkens the output or
  // actually powers the display down. A box with no CEC is a normal box, not a broken one.
  const power = await backend.powerCapabilities();

  log(
    `polyptic-agent v${agentVersion} · machineId=${machineId} · outputs=${outputs
      .map((o) => o.connector)
      .join(",")} · backend=${backend.id}${browser ? ` · browser=${browser}` : ""}` +
      ` · panel power: ${power.dpms ? (power.cec ? "dpms+cec" : "dpms only") : "none"}`,
  );
  log(
    `enrollment: ${credential ? "stored credential found" : "no stored credential"}${
      bootstrapToken ? " · bootstrap token present" : ""
    }${mtlsBundle ? ` · mTLS cert bundle found (dials ${mtlsBundle.url})` : ""} (open mode ignores credentials)`,
  );

  const agent = new Agent(
    SERVER_URL,
    machineId,
    agentVersion,
    backend,
    outputs,
    bootstrapToken,
    credential,
    browser,
    power,
    mtlsBundle,
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

// Only auto-run when invoked as the entry point (`bun src/index.ts`), so importing this module for
// tests doesn't dial the control plane.
if (import.meta.main) {
  main().catch((err) => {
    logError(`fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
