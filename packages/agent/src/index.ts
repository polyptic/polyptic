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
import type { KioskBrowser, LogEvent, LogLevel, MachineVitals, Output, PowerCapabilities } from "@polyptic/protocol";
import { readFileSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { applyCastPinEvent } from "./backends/cast";
import { selectKioskBrowser } from "./backends/chrome";
import { selectBackend } from "./backends/select";
import type { DisplayBackend } from "./backends/types";
import { credentialPath, loadCredential, saveCredential } from "./credential";
import { readHostIdentity } from "./hardware";
import { AgentLogger, logLine, setAgentLogger } from "./logger";
import { JournalTailer, probeJournalAccess } from "./journal";
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
import {
  INSTALL_STATUS_PATH,
  decideInstallResume,
  installRefusal,
  isTerminalPhase,
  readBootFacts,
  requestInstall,
  tailInstallStatus,
} from "./install";
import type { BootFacts, InstallStatusLine } from "./install";
import { ShellManager } from "./shell";
import { diffWindows } from "./windows";
import type { PlacedWindow } from "./windows";
import { resolveAdvertisedOutputs, resolveConnector } from "./outputs";
import { applyConfigFileToEnv } from "./setup/config";
import { describeAgentRuntime } from "./runtime";
import { agentVersion } from "./version";
import { VitalsSampler } from "./vitals";
import {
  applyUpdate,
  clearMarker,
  decideStartupAction,
  planUpdate,
  readMarker,
  realUpdateIO,
  resolveUpdateUrl,
  rollbackToBackup,
  selfBinaryPath,
  writeMarker,
  MAX_UNSTABLE_BOOTS,
  STABLE_UPTIME_MS,
} from "./update";

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

/**
 * POL-187 — every agent line now goes through the shared logger: stdout exactly as before (the
 * journal is unchanged), PLUS a bounded on-box spool that ships to the control plane and is only
 * dropped on an ack. Redaction lives inside it, so a content URL's send-time credential (POL-24)
 * can never reach a shipped line.
 */
function log(msg: string): void {
  logLine("info", "agent", msg);
}

function logWarn(msg: string): void {
  logLine("warn", "agent", msg);
}

function logError(msg: string): void {
  logLine("error", "agent", msg);
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

/**
 * POL-189 — start tailing the host journal, unless it is switched off.
 *
 * Returns null when host logs are disabled or unavailable. The access PROBE runs first and its
 * answer is logged either way, because the dangerous outcome is not "no host logs" — it is host
 * logs that look complete and are silently only this user's own entries (see probeJournalAccess).
 */
function startHostLogs(logger: AgentLogger, machineId: string): JournalTailer | null {
  const mode = process.env.POLYPTIC_HOST_LOGS?.trim().toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false") {
    logger.info("host-logs", "host journal shipping is OFF (POLYPTIC_HOST_LOGS)");
    return null;
  }
  // 0–7, syslog. Default 6 = everything journald carries except debug.
  const priority = Number.parseInt(process.env.POLYPTIC_HOST_LOG_PRIORITY?.trim() ?? "6", 10);
  const boots = Number.parseInt(process.env.POLYPTIC_HOST_LOG_BOOTS?.trim() ?? "1", 10);

  void probeJournalAccess(async (cmd, args) => {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }).then((probe) => {
    if (probe.ok) logger.info("host-logs", `host journal: ${probe.detail}`);
    // WARN, not info: a half-visible journal is a log that will lie to whoever reads it next.
    else logger.warn("host-logs", `host journal is only PARTLY readable — ${probe.detail}`);
  });

  const tailer = new JournalTailer({
    logger,
    machineId,
    maxPriority: Number.isFinite(priority) ? priority : 6,
    boots: Number.isFinite(boots) ? boots : 1,
  });
  tailer.start();
  logger.info(
    "host-logs",
    `shipping the host journal (priority <= ${priority}, ${boots === 1 ? "this boot" : `${boots} boots`})`,
  );
  return tailer;
}

/** POL-187 — the minimum level SHIPPED to the control plane. stdout always gets everything. */
function readShipLevel(): LogLevel {
  const raw = process.env.POLYPTIC_LOG_SHIP_LEVEL?.trim().toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

/** POL-183 — the `placed` dedupe signature for one connector: every LAUNCH input, so a scrollbar
 *  flip with an unchanged URL still reaches the backend (which relaunches — launch flags cannot be
 *  applied to a live browser). The prefix cannot collide with a URL: none starts with `#`. */
function placementKey(url: string, hideScrollbars: boolean): string {
  return `${hideScrollbars ? "#hs" : "#sb"}|${url}`;
}

// Narrowed server-frame variants.
type ApplyMsg = Extract<ServerToAgentMessage, { t: "server/apply" }>;
type IdentMsg = Extract<ServerToAgentMessage, { t: "server/ident" }>;
type CaptureMsg = Extract<ServerToAgentMessage, { t: "server/capture" }>;
type RebootMsg = Extract<ServerToAgentMessage, { t: "server/reboot" }>;
type InstallMsg = Extract<ServerToAgentMessage, { t: "server/install" }>;
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
type UpdateAvailableMsg = Extract<ServerToAgentMessage, { t: "server/update-available" }>;

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
  /** POL-143 — TOTAL consecutive failed mTLS dials since the last mTLS success (the streak above
   *  resets on every fallback cycle, so it cannot tell the server how long this has been going on).
   *  Reported in the plain-channel hello as `mtlsDialFailure` so the console can say "this box
   *  cannot reach the secure port at <url>" instead of promising a migration that never comes.
   *  Reset on an mTLS `open`, and when a fresh bundle points at a DIFFERENT URL (new door, fresh
   *  count). */
  private mtlsDialFailuresTotal = 0;

  /** Remote-shell PTYs (POL-59), created on first `server/shell-open`. A dev/non-Linux backend
   *  reports it can't provide a real terminal, and every open on such a box is refused. */
  private shell: ShellManager | null = null;

  /** Remote-DevTools bridge (POL-67), created on first `server/devtools-*` frame. The backend's
   *  `devtoolsEndpoint` gate means a non-Chrome box simply refuses every request. */
  private devtools: DevtoolsManager | null = null;

  private lastAppliedRevision = 0;
  /** connector → placement signature currently placed (dedupes repeat opens on reconnect/re-apply).
   *  POL-183 — the signature is `placementKey(url, hideScrollbars)`, not the bare URL: every LAUNCH
   *  input belongs in the key, or a flipped flag with an unchanged URL would dedupe to a no-op. */
  private readonly placed = new Map<string, string>();
  /** POL-18 — window id → what is placed (connector + spec signature); diffed on every apply so an
   *  unchanged window is never relaunched and a vanished one is torn down. */
  private readonly placedWindows = new Map<string, PlacedWindow>();
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

  /** POL-160 — versions we already tried to self-update to this process, so a server that re-offers
   *  on every hello does not re-download. Reset only by a restart (a fresh process = a fresh chance). */
  private readonly attemptedUpdates = new Set<string>();
  /** POL-160 — true while a self-update swap is in flight, so overlapping offers do not race the disk. */
  private updating = false;

  /** POL-176 — the boot/disk facts last gathered for a hello (bootMode + disk inventory + staged
   *  image id). Refreshed on every connect — cheap (one lsblk + two file reads) — and the inventory
   *  the install handler validates a requested device against. */
  private bootFacts: BootFacts = {};
  /** POL-176 — the live install-status tail, while an install is in flight. One at a time: a second
   *  `server/install` during a wipe is refused rather than racing the root installer. */
  private installTail: { stop(): void } | null = null;
  /** POL-177 — true once THIS process has sent a terminal install line (live or replayed), so an
   *  in-process reconnect never re-replays a finished outcome into a duplicate feed line. A process
   *  restart resets it — exactly the case (the OOM-killed agent) the replay exists for. */
  private installOutcomeReported = false;
  /** POL-187 — the URL this connection dialled, for the log-shipping cleartext check. */
  private currentTarget = "";
  /** POL-187 — true once this connection has armed log shipping (on its first apply). */
  private logShippingArmed = false;

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
    /** POL-187 — the shared logger whose spool this connection ships. */
    private readonly logger: AgentLogger | null = null,
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
        this.mtlsDialFailuresTotal += 1;
        logWarn(`mTLS dial failed (${this.mtlsFailStreak}/${MTLS_FALLBACK_AFTER} before a plain-channel retry)`);
      }
    };

    ws.on("open", () => {
      this.attempt = 0;
      this.socketOpened = true;
      if (this.connectedViaMtls) {
        this.mtlsFailStreak = 0;
        this.mtlsDialFailuresTotal = 0;
      }
      // A fresh connection: clear the stale "rejected" flag. If the server rejects us again it
      // re-sets the flag before close, so the long backoff persists across rejection cycles.
      this.rejected = false;
      log(`agent channel open${this.connectedViaMtls ? " (mTLS)" : ""} — enrolling`);
      // POL-177 — after the hello (never before it: the hello is the channel's first frame), if an
      // installer narrated (or is narrating) into /run/polyptic/install-status while no agent was
      // listening — the OOM-killed-mid-install case — pick the story back up.
      void this.sendHello().then(() => this.resumeInstallNarration());
      this.startHeartbeat();
      // NOT here: log shipping is armed on ADMISSION (the first `server/apply`), not on the socket
      // opening. See startLogShipping.
      this.currentTarget = target;
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
      logWarn(`ws error: ${err.message}`);
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
      // POL-187 — unwire the shipper. Anything in flight is re-queued: an unacked batch is by
      // definition a batch we cannot prove landed, so it stays spooled and goes again on reconnect
      // (where the server's `(machineId, seq)` dedupe makes a genuine duplicate a no-op).
      this.logger?.setShipper(null);
      this.logShippingArmed = false;
      if (!this.closing) this.scheduleReconnect();
    });
  }

  /**
   * POL-187 — arm log shipping for this connection, or refuse it.
   *
   * ARMED ON ADMISSION, NOT ON CONNECT. The first version armed this in the socket's `open` handler,
   * next to the hello — and the logger ships eagerly, so a batch raced the hello down the wire and
   * the server refused it ("no admitted hello for that machine"). Nothing was lost (a refusal leaves
   * the lines spooled, and they went on the next drain), but every single connect produced a scary
   * WARN in the operator's own log about the logging not working, which is a poor first impression
   * for a feature whose whole job is to be trustworthy. A box has no business writing into the
   * fleet's partitions before the control plane has admitted it anyway.
   *
   * THE REFUSAL IS THE POINT. A log line is the box's whole story — what it launched, which panel
   * it slept, which URL (redacted, but its origin and path all the same) it was pointed at. Shipping
   * that over an unencrypted socket would be a downgrade nobody asked for, so a cleartext channel
   * ships NOTHING and says so once in the journal, where the operator who goes looking will find it.
   * The lines are not lost — they stay spooled, and the moment the box has an encrypted channel
   * (mTLS by default since POL-134, or a TLS-terminated ingress) they go.
   *
   * `POLYPTIC_LOG_SHIP_CLEARTEXT=1` is the deliberate escape hatch for a lab or dev stack that has
   * no TLS at all. It is opt-IN, and it names what it is.
   */
  private startLogShipping(): void {
    const logger = this.logger;
    if (!logger) return;
    if (this.logShippingArmed) return; // idempotent: every apply calls this, only the first arms
    this.logShippingArmed = true;
    const target = this.currentTarget;
    const encrypted = target.startsWith("wss://");
    const allowCleartext = process.env.POLYPTIC_LOG_SHIP_CLEARTEXT?.trim() === "1";
    if (!encrypted && !allowCleartext) {
      logger.setShipper(null);
      logger.announceRefusal(
        `the agent channel at ${target} is not encrypted — set POLYPTIC_LOG_SHIP_CLEARTEXT=1 to ship anyway`,
      );
      return;
    }
    logger.setShipper((batchId, events) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try {
        ws.send(
          JSON.stringify(
            AgentMessage.parse({
              t: "agent/logs",
              machineId: this.machineId,
              batchId,
              events,
            }),
          ),
        );
        return true;
      } catch {
        // A frame we could not put on the wire is a frame that never left — nothing is dropped.
        return false;
      }
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
      logWarn(`dropping invalid server frame: ${(err as Error).message}`);
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
      case "server/install":
        this.onInstall(msg);
        break;
      case "server/update-available":
        await this.onUpdateAvailable(msg);
        break;
      case "server/inspect":
        await this.onInspect(msg);
        break;
      case "server/display-power":
        await this.onDisplayPower(msg);
        break;
      case "server/logs-ack":
        // POL-187 — the batch is durable (or was refused, and stays spooled). This one line is the
        // difference between store-and-forward and fire-and-forget.
        this.logger?.onAck(msg.batchId, msg.status === "accepted");
        if (msg.status === "refused") {
          this.logger?.announceRefusal(msg.reason ?? "the server would not take the batch");
        }
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
    // POL-187 — an apply IS admission: the control plane only sends one to a machine it has
    // accepted. Arming here (rather than on the socket opening) is what stops the first batch
    // racing the hello and coming back refused. Idempotent, so every later apply is a no-op.
    this.startLogShipping();
    log(`apply revision ${msg.revision} — ${msg.screens.length} screen(s)`);

    const wanted = new Set<string>();
    for (const screen of msg.screens) {
      wanted.add(screen.connector);
      // POL-183 — absent means TRUE (an old server's silence must not flip a fleet's scrollbars on).
      const hideScrollbars = screen.hideScrollbars !== false;
      // The dedupe key carries every LAUNCH input, so a scrollbar flip with an unchanged URL still
      // reaches the backend (which relaunches — a launch flag cannot be applied to a live browser).
      const placement = placementKey(screen.playerUrl, hideScrollbars);
      if (this.placed.get(screen.connector) === placement) {
        // already pointed at this launch — nothing to do (content updates over the player channel)
        this.status.set(screen.connector, { ok: true });
      } else {
        try {
          await this.backend.showScreen(screen.connector, screen.playerUrl, hideScrollbars);
          this.placed.set(screen.connector, placement);
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

    // POL-18 — reconcile the placed WEB-WINDOWS: place what's new/changed, retire what vanished.
    // Retire first so a window moving between outputs never briefly exists twice. A placement
    // failure is reported on the connector's status note (console-visible) but never fails the
    // apply — the player underneath keeps rendering everything else.
    const { toPlace, toRemove } = diffWindows(
      this.placedWindows,
      msg.screens.map((s) => ({ connector: s.connector, windows: s.windows ?? [] })),
    );
    for (const id of toRemove) {
      try {
        await this.backend.hideWindow(id);
      } catch (err) {
        log(`hideWindow(${id}) failed: ${(err as Error).message}`);
      }
      this.placedWindows.delete(id);
    }
    for (const place of toPlace) {
      const where = place.connectors.join("+");
      try {
        await this.backend.showWindow(place.window, place.connectors);
        this.placedWindows.set(place.id, {
          connectors: place.connectors,
          signature: place.signature,
        });
        log(`placed web-window ${place.id} on ${where}`);
      } catch (err) {
        const note = `web-window ${place.id}: ${(err as Error).message}`;
        // Keep the screen's ok flag (the player itself placed fine); surface the window's failure
        // on every connector it covers, so the console can show why the region(s) are empty.
        for (const connector of place.connectors) {
          const st = this.status.get(connector);
          this.status.set(connector, { ok: st?.ok ?? true, note });
        }
        log(`FAILED to place web-window ${place.id} on ${where}: ${note}`);
      }
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
    // POL-154 — a `connector` means "raise that output's player over its web-window for the flash": an
    // OS-level web-window (POL-18) floats above the player and hides the player-drawn ident overlay, so
    // the agent fullscreens the player over it (on) and drops it back after (off). Without a connector
    // this is the legacy machine-wide no-op — the visible ident is server→player everywhere else.
    log(
      `server/ident received (on=${msg.on}${msg.connector ? `, connector=${msg.connector}` : ""}) — ` +
        (msg.connector
          ? "raising the player over any web-window for the flash"
          : "visible ident is server→player; no agent action required"),
    );
    try {
      await this.backend.ident(msg.on, msg.connector);
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

  /**
   * `server/install` — install the OS to this box's internal disk (POL-176), the one DESTRUCTIVE
   * command on this channel. TRUST MODEL: the operator armed this via an explicit console confirm
   * that named the disk; the server re-checked the device against our reported inventory; here we
   * validate again (a LIVE box, a known non-removable disk — an INSTALLED box must never wipe the
   * disk it is running from); and the root install unit re-validates the device before writing a
   * byte. The escalation is the POL-55 pattern: one request file in the kiosk-writable /run
   * directory, `device=<dev>`, nothing else to smuggle.
   *
   * After the hand-over the agent NARRATES: it tails /run/polyptic/install-status (written by the
   * root installer) and forwards each new `<phase>|<percent>|<detail>` line as
   * `agent/install-status`, until `done`/`failed` or a 30-minute timeout.
   */
  private onInstall(msg: InstallMsg): void {
    log(`server/install received (device=${msg.device})`);
    const ack = (accepted: boolean, reason?: string): void => {
      this.send({ t: "agent/install-ack", machineId: this.machineId, accepted, reason });
    };

    if (this.installTail) {
      ack(false, "an install is already in flight on this box");
      logError("refused install: one is already in flight");
      return;
    }
    const refusal = installRefusal(msg.device, this.bootFacts.bootMode, this.bootFacts.disks);
    if (refusal) {
      ack(false, refusal);
      logError(`refused install to ${msg.device}: ${refusal}`);
      return;
    }
    const outcome = requestInstall(msg.device);
    ack(outcome.accepted, outcome.reason);
    if (!outcome.accepted) {
      logError(`could not request install to ${msg.device}: ${outcome.reason}`);
      return;
    }
    log(`install to ${msg.device} handed to the root installer (${outcome.reason}) — tailing its progress`);
    this.installOutcomeReported = false;
    this.startInstallTail(`install to ${msg.device}`);
  }

  /** Forward one install-status line on the wire (POL-176's frame, also used by the POL-177 replay). */
  private sendInstallStatus(line: InstallStatusLine): void {
    this.send({
      t: "agent/install-status",
      machineId: this.machineId,
      phase: line.phase,
      ...(line.percent !== undefined ? { percent: line.percent } : {}),
      ...(line.detail !== undefined ? { detail: line.detail } : {}),
    });
  }

  /** Start the install-status tail, forwarding each new line until `done`/`failed` or the 30-minute
   *  timeout. `subject` names the run in the logs ("install to /dev/sda" / "resumed install"). */
  private startInstallTail(subject: string): void {
    this.installTail = tailInstallStatus(
      (line) => {
        this.sendInstallStatus(line);
        if (isTerminalPhase(line.phase)) {
          this.installOutcomeReported = true;
          (line.phase === "done" ? log : logError)(
            `${subject} ${line.phase}${line.detail ? `: ${line.detail}` : ""}`,
          );
        }
      },
      (why) => {
        this.installTail = null;
        if (why === "timeout") {
          logError(`${subject}: no terminal status after the timeout — abandoning the tail`);
          this.installOutcomeReported = true;
          this.sendInstallStatus({
            phase: "failed",
            detail: "the installer reported no outcome within 30 minutes",
          });
        }
      },
    );
  }

  /**
   * POL-177 — resume the install narration after a restart or reconnect. The first field install ran
   * INVISIBLE: the swapless box hit OOM, the kernel killed the agent mid-install, and the restarted
   * process had no tail — none of the lines already in /run/polyptic/install-status were ever
   * forwarded, and the server had cleared the live `installing` state on the disconnect. So on every
   * fresh connection: if the status file exists and is recent (< 1 h), either resume the tail (the
   * installer may still be running — the tail re-forwards every line from the top, which re-sets the
   * server's presence state) or, when its last word is already terminal, send that one line once so
   * the console's strip and feed reflect the outcome even though the agent died mid-run. The
   * decision itself is pure ({@link decideInstallResume}); this method just does the I/O.
   */
  private async resumeInstallNarration(): Promise<void> {
    if (this.installTail) return; // a live tail already narrates over the new socket
    let text: string | null;
    let mtimeMs: number | null;
    try {
      text = await readFile(INSTALL_STATUS_PATH, "utf8");
      mtimeMs = (await stat(INSTALL_STATUS_PATH)).mtimeMs;
    } catch {
      return; // no status file — nothing ever installed this boot (the overwhelmingly common case)
    }
    // Re-check after the awaits: a `server/install` may have started a tail while we were reading.
    if (this.installTail) return;
    const decision = decideInstallResume(text, mtimeMs, Date.now());
    if (decision.action === "none") return;
    if (decision.action === "replay") {
      if (this.installOutcomeReported) return; // this process already told the server
      this.installOutcomeReported = true;
      log(
        `install-status file ends in "${decision.line.phase}" from before a restart — replaying the outcome`,
      );
      this.sendInstallStatus(decision.line);
      return;
    }
    log(
      `install-status file shows an install in flight (last phase: ${decision.lastLine?.phase ?? "none yet"}) — resuming the narration`,
    );
    this.startInstallTail("resumed install");
  }

  /**
   * POL-160 — the server says a newer agent binary is available for this box. Verify, swap our own
   * binary, and exit cleanly so systemd (`Restart=always`) relaunches the NEW one — no reboot, no
   * rebuild. Every step is logged loudly and self-reported over the channel (`agent/update-status`)
   * so a fix reaching — or NOT reaching — the fleet is never silent again (the v0.2.41 trap). The
   * version guard, the "updatable binary" guard, and the "already attempted" guard all live in
   * {@link planUpdate}; the download/verify/swap in {@link applyUpdate}. A failure leaves the box on
   * its current binary, still rendering.
   */
  private async onUpdateAvailable(msg: UpdateAvailableMsg): Promise<void> {
    const report = (
      phase: "downloading" | "verifying" | "swapping" | "restarting" | "skipped" | "failed",
      reason?: string,
    ): void => {
      this.send({
        t: "agent/update-status",
        machineId: this.machineId,
        phase,
        fromVersion: this.agentVersion,
        toVersion: msg.version,
        ...(reason ? { reason } : {}),
      });
    };

    if (this.updating) {
      log(`self-update to ${msg.version} already in flight — ignoring duplicate offer`);
      return;
    }

    const plan = planUpdate({
      currentVersion: this.agentVersion,
      offerVersion: msg.version,
      binaryPath: selfBinaryPath(),
      attemptedVersions: this.attemptedUpdates,
    });
    if (plan.action === "skip") {
      log(`self-update to ${msg.version} skipped: ${plan.reason}`);
      // A "not newer" offer is routine (the server offers on every hello until the box catches up),
      // so it is not worth a feed line; the server treats `skipped` as log-only.
      report("skipped", plan.reason);
      return;
    }

    this.updating = true;
    this.attemptedUpdates.add(msg.version);
    const url = resolveUpdateUrl(this.url, msg.url);
    log(`self-update: server offers agent ${this.agentVersion} → ${msg.version}; pulling ${url}`);
    report("downloading");

    try {
      report("verifying");
      const result = await applyUpdate(
        {
          binaryPath: plan.binaryPath,
          url,
          targetVersion: msg.version,
          ...(msg.sha256 ? { sha256: msg.sha256 } : {}),
          ...(msg.sizeBytes !== undefined ? { sizeBytes: msg.sizeBytes } : {}),
        },
        realUpdateIO(log),
      );
      if (!result.ok) {
        logError(`self-update to ${msg.version} FAILED (staying on ${this.agentVersion}): ${result.reason}`);
        report("failed", result.reason);
        this.updating = false;
        return;
      }

      // The new binary is on disk and passed its self-check. Record a crash-loop marker so the
      // relaunched binary can roll itself back if it boots but won't stay up, then exit for systemd.
      await writeMarker(plan.binaryPath, {
        targetVersion: msg.version,
        previousVersion: this.agentVersion,
        swappedAt: new Date().toISOString(),
        boots: 0,
        committed: false,
      }).catch((err) => logError(`could not write update marker: ${(err as Error).message}`));

      log(`self-update: swapped in agent ${msg.version}; exiting for systemd to relaunch the new binary`);
      report("restarting");
      // Give the status frame a moment to flush, then exit cleanly. systemd Restart=always relaunches
      // the (now newer) binary, which reconnects exactly like any other reconnect. NOTE: the browser
      // supervision model reaps + relaunches each output's browser on the first apply after a restart,
      // so the wall briefly reloads (it repaints from the player's cache) — this is the status quo of
      // any agent restart, not new to self-update. See PR notes.
      this.stop();
      setTimeout(() => process.exit(0), 250);
    } catch (err) {
      logError(`self-update to ${msg.version} errored (staying on ${this.agentVersion}): ${(err as Error).message}`);
      report("failed", (err as Error).message);
      this.updating = false;
    }
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
   * says so — an operator's click, or a schedule window's boundary. Nothing here is driven
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
      // A bundle pointing at a DIFFERENT door restarts the failure count — the old count described
      // the old address, and carrying it over would report a URL nobody is dialling any more.
      if (this.mtls?.url !== bundle.url) this.mtlsDialFailuresTotal = 0;
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
      // The pending board rides the POL-183 default (scrollbars hidden) — no screen registry exists
      // yet to say otherwise, and the board is ours (it never scrolls anyway).
      if (this.placed.get(output.connector) === placementKey(msg.pendingUrl, true)) continue;
      try {
        await this.backend.showScreen(output.connector, msg.pendingUrl, true);
        this.placed.set(output.connector, placementKey(msg.pendingUrl, true));
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
    // POL-176 — how this box boots (live vs installed), what disks it holds, and any staged image.
    // Re-gathered on every connect (cheap: one lsblk + two /run reads), so a reconnect after an
    // install/reboot reports the NEW truth; the inventory is also what `server/install` validates
    // its device against. Never blocks the hello: a failed probe simply reports nothing.
    try {
      this.bootFacts = await readBootFacts();
    } catch (err) {
      logError(`could not gather boot/disk facts (hello continues without them): ${(err as Error).message}`);
      this.bootFacts = {};
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
      // POL-176 — live vs installed + the disk inventory + any staged image, gathered above. All
      // undefined on a dev/non-fleet box, and dropped by JSON.stringify like everything else here.
      bootMode: this.bootFacts.bootMode,
      disks: this.bootFacts.disks,
      stagedImageId: this.bootFacts.stagedImageId,
      // POL-104 — what this box IS (MACs / DMI serial / arch). Descriptive, never a credential: the
      // server uses it to match a pre-registration (after the token gate) and to make a pending
      // approval card readable. Sampled per hello so a re-cabled box re-reports honestly.
      hardware: readHostIdentity(),
      // POL-192 — how this agent is RUNNING: a compiled binary or a source run, the binary it would
      // replace, and whether it can self-update at all (with the reason it cannot, in the same words
      // the `agent/update-status` skip line uses). Sent on every hello because it is a standing fact:
      // a box that will never take an update must say so when it connects, not only when it declines
      // one into a log. Sampled per hello, so a box that gets swapped onto a real binary re-reports.
      runtime: describeAgentRuntime(this.agentVersion),
      bootstrapToken: this.bootstrapToken,
      credential: this.credential ?? undefined,
      csrPem,
      // POL-143 — on a PLAIN hello while holding a bundle whose dials keep failing, tell the server
      // exactly what was dialled and how many times it failed, so an unreachable mTLS port surfaces
      // on the console instead of reading "moves over on next connection" forever.
      mtlsDialFailure:
        !this.connectedViaMtls && this.mtls !== null && this.mtlsDialFailuresTotal > 0
          ? { url: this.mtls.url, attempts: this.mtlsDialFailuresTotal }
          : undefined,
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
      logWarn(`cannot send ${msg.t}: socket not open`);
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

/**
 * POL-160 — reconcile a self-update marker at startup, BEFORE dialling the server. Three outcomes:
 *   - the binary we swapped in is what is running now and this is one of its first boots → let it run
 *     and prove itself; a timer marks the update COMMITTED (and drops `<bin>.bak`) once it has stayed
 *     up STABLE_UPTIME_MS. Each boot increments the marker's boot count first.
 *   - it has booted too many times without ever staying up → ROLL BACK to `<bin>.bak` and exit for
 *     systemd to relaunch the binary that worked, so a bad update cannot wedge the box content-less.
 *   - anything else (no marker, already committed, a version we are not running) → clear the marker.
 * Never throws: a box that keeps running its current binary is strictly better than one that doesn't.
 */
async function reconcileSelfUpdateAtStartup(currentVersion: string): Promise<void> {
  const binaryPath = selfBinaryPath();
  if (!binaryPath) return; // dev/source run — nothing self-updates
  try {
    const existing = await readMarker(binaryPath);
    // Count THIS boot before deciding, so the crash-loop budget is measured across relaunches.
    const marker = existing ? { ...existing, boots: existing.boots + 1 } : null;
    const action = decideStartupAction(marker, currentVersion);
    if (action.kind === "rollback") {
      logError(
        `self-update to ${action.marker.targetVersion} has booted ${action.marker.boots} times without staying up — rolling back to ${action.marker.previousVersion}`,
      );
      const rolledBack = await rollbackToBackup(binaryPath);
      await clearMarker(binaryPath);
      if (rolledBack) {
        log(`rolled back to the previous agent binary; exiting for systemd to relaunch it`);
        setTimeout(() => process.exit(0), 100);
        // Block here so we don't go on to dial the server as the doomed binary.
        await new Promise(() => {});
      } else {
        logError(`no ${binaryPath}.bak to roll back to — continuing on the current binary`);
      }
      return;
    }
    if (action.kind === "commit") {
      // Persist the incremented boot count now, so a crash before the stable timer still counts.
      await writeMarker(binaryPath, action.marker).catch(() => {});
      log(
        `running freshly self-updated agent ${currentVersion} (boot ${action.marker.boots}/${MAX_UNSTABLE_BOOTS}); will commit after ${Math.round(STABLE_UPTIME_MS / 1000)}s uptime`,
      );
      setTimeout(() => {
        void writeMarker(binaryPath, { ...action.marker, committed: true })
          .then(() => clearMarker(binaryPath)) // committed: drop the marker AND the backup below
          .then(() => rm(`${binaryPath}.bak`, { force: true }).catch(() => {}))
          .then(() => log(`self-update to ${currentVersion} committed — stable for ${Math.round(STABLE_UPTIME_MS / 1000)}s`))
          .catch(() => {});
      }, STABLE_UPTIME_MS).unref?.();
      return;
    }
    // kind "none": a stale marker (already committed, or for a version we are not running) — clear it.
    if (existing) await clearMarker(binaryPath);
  } catch (err) {
    logError(`self-update startup reconcile failed (continuing): ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  // POL-160 — the self-update self-check runs `<binary> --version`, so answer it before anything else
  // (no server dial, no backend probe): print just the version and exit 0. A truncated or wrong-arch
  // binary cannot get here, which is exactly what makes the check a real gate on the swap.
  if (process.argv[2] === "--version" || process.argv[2] === "version") {
    process.stdout.write(`${readAgentVersion()}\n`);
    process.exit(0);
  }

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
  // POL-187 — install the process-wide logger as soon as the machine id is known (a log line is
  // addressed BY machine), and before anything else narrates. Everything from here on writes stdout
  // exactly as it always did AND spools for shipping. `POLYPTIC_LOG_SHIP_LEVEL=debug` raises what
  // gets shipped for a lab session; the default is info-and-above, so Chrome's filtered firehose
  // (POL-67's `POLYPTIC_BROWSER_LOG=all`) stays on the box unless deliberately asked for.
  const logger = new AgentLogger({ machineId, shipMinLevel: readShipLevel() });
  setAgentLogger(logger);
  const connector = resolveConnector();
  const agentVersion = readAgentVersion();
  // POL-160 — before dialling: if we are a binary that just self-updated, either let it prove itself
  // (and commit) or roll back a binary that keeps crashing. Runs first so a doomed binary rolls back
  // rather than reconnecting and re-triggering the same bad swap.
  await reconcileSelfUpdateAtStartup(agentVersion);
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
    logger,
  );
  agent.start();

  // POL-189 — the HOST's own logs. The agent explains the agent; journald explains everything under
  // it (greetd, sway, the kernel, the NIC, the OOM killer) — including the boots where the agent
  // never got far enough to say anything at all. Off with POLYPTIC_HOST_LOGS=off.
  const journal = startHostLogs(logger, machineId);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`received ${sig} — shutting down`);
      agent.stop();
      journal?.stop();
      // Flush the spool before we go: the lines describing a shutdown are exactly the ones you want
      // when the box comes back up wrong.
      logger.stop();
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
