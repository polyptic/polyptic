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
 */
export class Presence {
  private readonly agentConns = new Map<string, number>();
  private readonly screenRevision = new Map<string, number>();

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
        } satisfies ScreenView;
      });

    return {
      id: machine.id,
      label: machine.label,
      agentVersion: machine.agentVersion,
      backend: machine.backend,
      online: presence.isMachineOnline(machine.id),
      status: machine.status,
      // Outputs the agent reported — shown for pending machines that have no screens yet.
      outputCount: machine.outputs.length,
      lastSeen: machine.lastSeen,
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
