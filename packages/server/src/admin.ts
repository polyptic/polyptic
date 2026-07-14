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
import type { MachineView, ScreenView, ServerToAdminMessage } from "@polyptic/protocol";
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
  private readonly screenRevision = new Map<string, number>();
  /** screenIds whose panel currently shows the browser's Web Inspector (POL-50). */
  private readonly inspecting = new Set<string>();
  /** POL-119 — screenIds with a LIVE cast (AirPlay) session: the box's receiver owns a visible
   *  window (mirror or PIN prompt). Level-set from `agent/status.screens[].casting`. */
  private readonly casting = new Set<string>();
  /** screenId → why the box last refused to show it (POL-50). */
  private readonly inspectErrors = new Map<string, string>();
  /** machineId → when the box ACCEPTED an operator reboot (POL-68). Live-only; cleared when the
   *  machine reconnects, and expired after REBOOTING_TTL_MS so a box that dies mid-reboot doesn't
   *  read "rebooting…" in the console forever. */
  private readonly rebootingSince = new Map<string, number>();

  /** How long an accepted reboot may read as "rebooting…" before it degrades to plain offline. */
  private static readonly REBOOTING_TTL_MS = 3 * 60_000;

  agentConnected(machineId: string): void {
    this.agentConns.set(machineId, (this.agentConns.get(machineId) ?? 0) + 1);
  }

  agentDisconnected(machineId: string): void {
    const n = (this.agentConns.get(machineId) ?? 0) - 1;
    if (n <= 0) this.agentConns.delete(machineId);
    else this.agentConns.set(machineId, n);
  }

  isMachineOnline(machineId: string): boolean {
    return (this.agentConns.get(machineId) ?? 0) > 0;
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
    }
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
): ServerToAdminMessage {
  const screens = control.getScreens();

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
