/**
 * Admin channel plumbing (admin UI ↔ server).
 *
 * Three pieces:
 *   - `AdminHub`   — the set of connected admin WebSockets; broadcasts `admin/state` to all of them.
 *   - `Presence`   — LIVE connection state that isn't in the persisted registry: which machines have
 *                    an agent socket connected, and the last revision each screen's player observed.
 *                    (Screen "online" is derived from the PlayerHub — a screen is online iff a player
 *                    socket is open for it.)
 *   - `AdminBroadcaster` — builds a `MachineView[]` snapshot by merging the persisted registry
 *                    (ControlPlane) with live status (Presence + PlayerHub) and pushes it to every
 *                    admin socket. Broadcasts are COALESCED (one microtask) so a burst of changes
 *                    collapses into a single, latest-state push.
 *
 * The server calls `broadcaster.broadcast()` on EVERY change: agent/player connect+disconnect,
 * rename, surface change, and player/ack.
 */
import { ServerToAdminState } from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { MachineVitals, MachineView, ScreenView, ServerToAdminMessage } from "@polyptic/protocol";
import { WebSocket } from "ws";

import type { ControlPlane } from "./state";
import type { PlayerHub } from "./hub";
import type { ActivityLog } from "./activity";

/** Tracks connected admin sockets and fans `admin/state` out to all of them. */
export class AdminHub {
  private readonly sockets = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.sockets.add(socket);
  }

  remove(socket: WebSocket): void {
    this.sockets.delete(socket);
  }

  count(): number {
    return this.sockets.size;
  }

  /** Send a validated server→admin message to every open admin socket. Returns count delivered. */
  broadcast(message: ServerToAdminMessage): number {
    if (this.sockets.size === 0) return 0;
    const data = JSON.stringify(message);
    let delivered = 0;
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
        delivered += 1;
      }
    }
    return delivered;
  }
}

/**
 * Live, non-persisted connection state.
 *  - machine online: an agent WS is currently connected (ref-counted so overlapping sockets are safe).
 *  - screen observed revision: the last revision a screen's player acked.
 *  - screen inspecting: the wall's Web Inspector is open on that panel (POL-50).
 */
export class Presence {
  private readonly agentConns = new Map<string, number>();
  /** POL-134 — machineId → the channel its live agent session arrived on. Live-only. */
  private readonly agentChannel = new Map<string, "plain" | "mtls">();
  private readonly screenRevision = new Map<string, number>();
  /** screenIds whose panel currently shows the browser's Web Inspector (POL-50). */
  private readonly inspecting = new Set<string>();
  /** POL-119 — screenIds with a LIVE cast (AirPlay) session: the box's receiver owns a visible
   *  window (the mirror). Level-set from `agent/status.screens[].casting`. */
  private readonly casting = new Set<string>();
  /** POL-136 — screenId → the PIN a pairing sender must type RIGHT NOW (plus when we learned it),
   *  per the agent's status report (the receiver prints it to stdout; the agent learns it there).
   *  Live-only, like the rest of Presence — and TTL-guarded on read: the value exists to be
   *  REPLAYED to late-connecting players, so a lost agent-side clear must not replay a stale code
   *  over live mirrored content. The TTL mirrors the agent's own 120s pin backstop. */
  private readonly castPins = new Map<string, { pin: string; at: number }>();
  /** screenId → why the box last refused to show it (POL-50). */
  private readonly inspectErrors = new Map<string, string>();
  /** machineId → when the box ACCEPTED an operator reboot (POL-68). Live-only; cleared when the
   *  machine reconnects, and expired after REBOOTING_TTL_MS so a box that dies mid-reboot doesn't
   *  read "rebooting…" in the console forever. */
  private readonly rebootingSince = new Map<string, number>();

  /** POL-92 — machineId → a small ring of host-vitals samples, newest LAST. Live-only, exactly like
   *  the rest of Presence: vitals describe a running box, and a box that isn't running has none. The
   *  ring (not just the latest sample) is what lets an operator surface, and a future feature graph,
   *  a few minutes of history without touching the store or the <150ms path. */
  private readonly vitals = new Map<string, MachineVitals[]>();
  /** POL-104 — machineId → the peer address of its live agent socket. Live-only (see `machineAddress`). */
  private readonly addresses = new Map<string, string>();
  /** machineId → ms epoch of the last heartbeat we accepted (with or WITHOUT vitals — a pre-POL-92
   *  agent still proves liveness). Drives `polyptic_machine_last_seen_seconds`. */
  private readonly lastHeartbeat = new Map<string, number>();

  /** How long an accepted reboot may read as "rebooting…" before it degrades to plain offline. */
  private static readonly REBOOTING_TTL_MS = 3 * 60_000;

  /** POL-136 — how long a stored pairing PIN stays replayable; mirrors the agent's pin TTL. */
  private static readonly CAST_PIN_TTL_MS = 120_000;

  /** Samples retained per machine — ~5 minutes at the agent's 10s heartbeat. Bounded on purpose:
   *  this is a fleet-sized in-memory structure, not a time-series database. */
  private static readonly VITALS_RING = 30;

  agentConnected(machineId: string, channel?: "plain" | "mtls"): void {
    this.agentConns.set(machineId, (this.agentConns.get(machineId) ?? 0) + 1);
    // POL-134 — remember which agent channel the live session rides (the newest admitted socket
    // wins; overlapping reconnects converge on the surviving one within a heartbeat anyway).
    if (channel) this.agentChannel.set(machineId, channel);
  }

  agentDisconnected(machineId: string): void {
    const n = (this.agentConns.get(machineId) ?? 0) - 1;
    if (n <= 0) {
      this.agentConns.delete(machineId);
      // POL-104 — the box is gone, and so is the address it was dialling from.
      this.addresses.delete(machineId);
      this.agentChannel.delete(machineId);
    } else this.agentConns.set(machineId, n);
  }

  isMachineOnline(machineId: string): boolean {
    return (this.agentConns.get(machineId) ?? 0) > 0;
  }

  /** POL-134 — the channel of the machine's live agent session (undefined while offline). */
  machineChannel(machineId: string): "plain" | "mtls" | undefined {
    return this.isMachineOnline(machineId) ? this.agentChannel.get(machineId) : undefined;
  }

  setScreenObservedRevision(screenId: string, revision: number): void {
    this.screenRevision.set(screenId, revision);
  }

  screenObservedRevision(screenId: string): number {
    return this.screenRevision.get(screenId) ?? 0;
  }

  /**
   * Record whether a screen's panel is showing the Web Inspector (POL-50). Only ever called from the
   * agent's `agent/inspect-ack` — the operator's click is a request, the ack is the truth.
   */
  setScreenInspecting(screenId: string, on: boolean): void {
    if (on) this.inspecting.add(screenId);
    else this.inspecting.delete(screenId);
  }

  isScreenInspecting(screenId: string): boolean {
    return this.inspecting.has(screenId);
  }

  /** POL-119 — record whether a cast session is live on a screen, per the agent's status report
   *  (window presence on the box — never the operator's click — is the truth). Returns true when the
   *  value CHANGED, so the caller broadcasts only on real edges, not every heartbeat. */
  setScreenCasting(screenId: string, active: boolean): boolean {
    const was = this.casting.has(screenId);
    if (active) this.casting.add(screenId);
    else this.casting.delete(screenId);
    return was !== active;
  }

  isScreenCasting(screenId: string): boolean {
    return this.casting.has(screenId);
  }

  /** POL-136 — record (or clear, with null) the PIN a sender must type to pair with this screen's
   *  receiver, per the agent's level report. Returns true when the value CHANGED, so the caller
   *  pushes the player overlay / feed line only on real edges, not every heartbeat. */
  setScreenCastPin(screenId: string, pin: string | null, nowMs: number = Date.now()): boolean {
    const was = this.screenCastPin(screenId, nowMs); // TTL-aware: an expired pin reads as null
    if (pin === null) this.castPins.delete(screenId);
    else this.castPins.set(screenId, { pin, at: nowMs });
    return was !== pin;
  }

  /** The PIN currently pairing against this screen, or null — replayed to a player that (re)connects
   *  mid-pairing, right after its first render. Expired entries read as null (and are dropped): a
   *  PIN nobody refreshed for 2 minutes describes a pairing that no longer exists. */
  screenCastPin(screenId: string, nowMs: number = Date.now()): string | null {
    const held = this.castPins.get(screenId);
    if (!held) return null;
    if (nowMs - held.at > Presence.CAST_PIN_TTL_MS) {
      this.castPins.delete(screenId);
      return null;
    }
    return held.pin;
  }

  /**
   * Record (or clear, with `null`) why the box refused to show its inspector. A refusal leaves
   * `inspecting` false — i.e. UNCHANGED — so this is the only thing that distinguishes "the wall said
   * no" from "the wall hasn't answered yet", and it is what un-sticks the console's pending button.
   */
  setScreenInspectError(screenId: string, reason: string | null): void {
    if (reason === null) this.inspectErrors.delete(screenId);
    else this.inspectErrors.set(screenId, reason);
  }

  screenInspectError(screenId: string): string | undefined {
    return this.inspectErrors.get(screenId);
  }

  /** The box accepted `server/reboot` (POL-68) — it goes dark on purpose a moment later. */
  setMachineRebooting(machineId: string): void {
    this.rebootingSince.set(machineId, Date.now());
  }

  /** Whether an accepted reboot is still plausibly in flight (set, not reconnected, not expired). */
  isMachineRebooting(machineId: string): boolean {
    const since = this.rebootingSince.get(machineId);
    if (since === undefined) return false;
    if (Date.now() - since > Presence.REBOOTING_TTL_MS) {
      this.rebootingSince.delete(machineId);
      return false;
    }
    return true;
  }

  /** Clear (and report) an in-flight reboot — called when the machine dials back in, so the feed
   *  can say "back online" for a round trip vs a plain "connected" for anything else. */
  consumeMachineRebooting(machineId: string): boolean {
    const wasRebooting = this.isMachineRebooting(machineId);
    this.rebootingSince.delete(machineId);
    return wasRebooting;
  }

  /**
   * Forget the inspector state for these screens — their machine dropped, so whatever was on those
   * panels is gone. Without this a box that reboots while being inspected comes back showing a stale
   * "inspecting" badge for a wall that is once again a sealed kiosk.
   */
  clearScreensInspecting(screenIds: readonly string[]): void {
    for (const id of screenIds) {
      this.inspecting.delete(id);
      this.inspectErrors.delete(id);
      // POL-119 — a dropped machine's receiver windows are gone with it; no session survives.
      this.casting.delete(id);
      // POL-136 — and neither does an in-flight pairing (its receiver died with the box).
      this.castPins.delete(id);
    }
  }

  // ── Host vitals (POL-92) ───────────────────────────────────────────────────

  /** Record one heartbeat's arrival, with or without vitals (an old agent proves liveness too). */
  noteHeartbeat(machineId: string, vitals?: MachineVitals): void {
    this.lastHeartbeat.set(machineId, Date.now());
    if (!vitals) return;
    const ring = this.vitals.get(machineId) ?? [];
    ring.push(vitals);
    if (ring.length > Presence.VITALS_RING) ring.splice(0, ring.length - Presence.VITALS_RING);
    this.vitals.set(machineId, ring);
  }

  /** The newest sample, or undefined when this box has never reported any. */
  machineVitals(machineId: string): MachineVitals | undefined {
    const ring = this.vitals.get(machineId);
    return ring && ring.length > 0 ? ring[ring.length - 1] : undefined;
  }

  /** The whole ring, oldest first (a few minutes of history). */
  machineVitalsSeries(machineId: string): readonly MachineVitals[] {
    return this.vitals.get(machineId) ?? [];
  }

  /** Ms epoch of the last heartbeat from this machine, or undefined if we've had none this boot. */
  machineLastHeartbeat(machineId: string): number | undefined {
    return this.lastHeartbeat.get(machineId);
  }

  // ── Peer address (POL-104) ─────────────────────────────────────────────────

  /** The address the agent's socket is coming from, recorded on hello. LIVE-ONLY, exactly like the
   *  rest of Presence: an IP is a fact about a connection, and a connection that is gone has none —
   *  persisting it would leave an offline card asserting an address that may now belong elsewhere. */
  noteMachineAddress(machineId: string, address: string): void {
    // Normalize the IPv4-mapped IPv6 form node hands us for a plain v4 peer (`::ffff:10.0.0.7`).
    this.addresses.set(machineId, address.replace(/^::ffff:/, ""));
  }

  machineAddress(machineId: string): string | undefined {
    return this.addresses.get(machineId);
  }

  /** A machine was REMOVED (POL-14) — drop everything we hold about it, so an id that is reused
   *  never inherits a dead box's vitals. */
  forgetMachine(machineId: string): void {
    this.vitals.delete(machineId);
    this.lastHeartbeat.delete(machineId);
    this.rebootingSince.delete(machineId);
    this.agentConns.delete(machineId);
    this.addresses.delete(machineId);
  }
}

/**
 * Build the denormalized `admin/state` snapshot: persisted registry (machines + screens + surface
 * counts) merged with live status (machine online from Presence, screen online from the PlayerHub,
 * screen observed revision from Presence). Validated against the contract before it leaves.
 */
export function buildAdminState(
  control: ControlPlane,
  playerHub: PlayerHub,
  presence: Presence,
  activity: ActivityLog,
  /** POL-104 — the enrolment policy, so a machine's card can say which token it came in on and whether
   *  that token has since been revoked. Optional: unit tests that build a view need no policy. */
  enrollment?: { list(): { id: string; revokedAt: string | null }[] },
): ServerToAdminMessage {
  const screens = control.getScreens();
  const revokedTokenIds = new Set(
    (enrollment?.list() ?? []).filter((t) => t.revokedAt !== null).map((t) => t.id),
  );

  const machines: MachineView[] = control.getMachines().map((machine) => {
    const machineScreens: ScreenView[] = screens
      .filter((s) => s.machineId === machine.id)
      .map((s) => {
        const slice = control.getSlice(s.id);
        return {
          id: s.id,
          friendlyName: s.friendlyName,
          machineId: s.machineId,
          connector: s.connector,
          online: playerHub.count(s.id) > 0,
          revision: presence.screenObservedRevision(s.id),
          surfaceCount: slice ? slice.surfaces.length : 0,
          content: control.screenContentSummary(s.id),
          inspecting: presence.isScreenInspecting(s.id),
          inspectError: presence.screenInspectError(s.id),
          castEnabled: s.castEnabled, // POL-119 — the persistent operator toggle
          castActive: presence.isScreenCasting(s.id), // POL-119 — a session is live NOW
        } satisfies ScreenView;
      });

    return {
      id: machine.id,
      label: machine.label,
      agentVersion: machine.agentVersion,
      backend: machine.backend,
      browser: machine.browser,
      online: presence.isMachineOnline(machine.id),
      status: machine.status,
      // Outputs the agent reported — shown for pending machines that have no screens yet.
      outputCount: machine.outputs.length,
      lastSeen: machine.lastSeen,
      shellEnabled: machine.shellEnabled ?? false,
      rebooting: presence.isMachineRebooting(machine.id),
      shellArmedAt: machine.shellArmedAt,
      // POL-92 — the latest host-vitals sample, but ONLY while the box is online. A CPU reading from
      // a machine that has since gone dark is not health data, it is an epitaph; the console says
      // "System stats unavailable while offline" instead of drawing a stale meter.
      vitals: presence.isMachineOnline(machine.id) ? presence.machineVitals(machine.id) : undefined,
      // POL-104 — what the box IS. Persisted (so a PENDING card is informative even between boots)
      // and shown on the card an operator has to make a decision about: 50 identical UUIDs was the
      // whole reason mass commissioning was 50 blind approvals.
      hardware: machine.hardware,
      // Live-only: an IP describes a connection, so an offline box has none.
      ip: presence.isMachineOnline(machine.id) ? presence.machineAddress(machine.id) : undefined,
      enrolledVia: machine.enrolledTokenId
        ? {
            tokenId: machine.enrolledTokenId,
            name: machine.enrolledTokenName ?? machine.enrolledTokenId,
            // Revoked ≠ dead: this box holds a durable per-machine credential and keeps running. The
            // chip is provenance ("came in on a stick we have since cut"), not a status.
            revoked: revokedTokenIds.has(machine.enrolledTokenId),
          }
        : undefined,
      preRegistered: machine.preRegistered ?? false,
      // POL-134 — the agent channel of the live session + persisted cert state, for the Settings
      // card and the Machines view ("is this box actually on mTLS?").
      agentChannel: presence.machineChannel(machine.id),
      mtlsCertIssuedAt: machine.mtlsCertIssuedAt,
      mtlsSeenAt: machine.mtlsSeenAt,
      screens: machineScreens,
    } satisfies MachineView;
  });

  return ServerToAdminState.parse({
    t: "admin/state",
    revision: control.state.revision,
    machines,
    murals: control.getMurals(),
    placements: control.getPlacements(),
    videoWalls: control.getVideoWalls(),
    contentSources: control.getContentSources(),
    scenes: control.getScenes(),
    activity: activity.recent(), // D25 — Live Activity feed (newest first, bounded)
    settings: control.getDisplaySettings(), // POL-6 — fleet-wide display settings (badge toggle)
    credentialProfiles: control.getCredentialProfileViews(), // POL-24 — content auth (never the secret)
  });
}

interface BroadcasterDeps {
  control: ControlPlane;
  playerHub: PlayerHub;
  presence: Presence;
  adminHub: AdminHub;
  activity: ActivityLog;
  log: FastifyBaseLogger;
  /** POL-104 — the live enrolment policy (which token a machine came in on, and whether it is revoked). */
  enrollment?: { list(): { id: string; revokedAt: string | null }[] };
}

/**
 * Coalesced `admin/state` broadcaster. `broadcast()` may be called freely on every change; a single
 * microtask flush collapses bursts into one push that reflects the latest state. `snapshot()` builds
 * the current state on demand (used to greet a freshly connected admin socket).
 */
export class AdminBroadcaster {
  private scheduled = false;

  constructor(private readonly deps: BroadcasterDeps) {}

  /** Current `admin/state` for a single recipient (e.g. on connect). */
  snapshot(): ServerToAdminMessage {
    return buildAdminState(
      this.deps.control,
      this.deps.playerHub,
      this.deps.presence,
      this.deps.activity,
      this.deps.enrollment,
    );
  }

  /** Schedule a coalesced broadcast of the latest state to all admin sockets. */
  broadcast(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.deps.adminHub.count() === 0) return;
      const message = this.snapshot();
      const delivered = this.deps.adminHub.broadcast(message);
      this.deps.log.debug(
        {
          event: "admin.state.broadcast",
          revision: message.revision,
          machines: message.machines.length,
          delivered,
        },
        "broadcast admin/state",
      );
    });
  }
}
