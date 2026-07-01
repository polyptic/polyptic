/**
 * Player socket registry — the "instant" fan-out path.
 *
 * Tracks live player WebSockets keyed by screenId so a render push reaches exactly the
 * player(s) showing that screen (a screen may have >1 socket open during reconnects).
 * Content goes server → player directly (never through the agent) for speed.
 *
 * The agent socket registry (`AgentHub`) lives here too: it keys live agent WebSockets by machineId
 * so an operator's approve/reject can reach a connected agent NOW — a live `server/apply` on approve,
 * a `server/rejected` + socket close on reject.
 */
import { WebSocket } from "ws";

import type { ServerToAgentMessage, ServerToPlayerMessage } from "@polyptic/protocol";

export class PlayerHub {
  private readonly byScreen = new Map<string, Set<WebSocket>>();

  add(screenId: string, socket: WebSocket): void {
    let set = this.byScreen.get(screenId);
    if (!set) {
      set = new Set<WebSocket>();
      this.byScreen.set(screenId, set);
    }
    set.add(socket);
  }

  remove(screenId: string, socket: WebSocket): void {
    const set = this.byScreen.get(screenId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.byScreen.delete(screenId);
  }

  count(screenId: string): number {
    return this.byScreen.get(screenId)?.size ?? 0;
  }

  /** Number of distinct screens with at least one live player socket (for /metrics). */
  screenCount(): number {
    return this.byScreen.size;
  }

  /** Send a validated server→player message to every open socket on a screen. Returns count delivered. */
  send(screenId: string, message: ServerToPlayerMessage): number {
    const set = this.byScreen.get(screenId);
    if (!set || set.size === 0) return 0;
    const data = JSON.stringify(message);
    let delivered = 0;
    for (const socket of set) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
        delivered += 1;
      }
    }
    return delivered;
  }

  /**
   * Broadcast a validated server→player message to EVERY open player socket, across all screens.
   * The fleet-wide fan-out path (POL-6): flipping a global setting reaches every wall at once, with
   * no per-screen recompute. Returns the total number of sockets delivered to.
   */
  broadcastAll(message: ServerToPlayerMessage): number {
    const data = JSON.stringify(message);
    let delivered = 0;
    for (const set of this.byScreen.values()) {
      for (const socket of set) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(data);
          delivered += 1;
        }
      }
    }
    return delivered;
  }
}

/**
 * Agent socket registry — keyed by machineId so the control plane can push to a connected agent on
 * demand (operator approve → live `server/apply`; operator reject → `server/rejected` + close).
 * A machine may transiently hold >1 socket during a reconnect, so each id maps to a set.
 */
export class AgentHub {
  private readonly byMachine = new Map<string, Set<WebSocket>>();

  add(machineId: string, socket: WebSocket): void {
    let set = this.byMachine.get(machineId);
    if (!set) {
      set = new Set<WebSocket>();
      this.byMachine.set(machineId, set);
    }
    set.add(socket);
  }

  remove(machineId: string, socket: WebSocket): void {
    const set = this.byMachine.get(machineId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.byMachine.delete(machineId);
  }

  count(machineId: string): number {
    return this.byMachine.get(machineId)?.size ?? 0;
  }

  /** Number of distinct machines with at least one live agent socket (for /metrics). */
  machineCount(): number {
    return this.byMachine.size;
  }

  /** The machineIds with at least one live agent socket (for fleet-wide capture sweeps). */
  machineIds(): string[] {
    return [...this.byMachine.keys()];
  }

  /** Send a validated server→agent message to every open socket for a machine. Returns count delivered. */
  send(machineId: string, message: ServerToAgentMessage): number {
    const set = this.byMachine.get(machineId);
    if (!set || set.size === 0) return 0;
    const data = JSON.stringify(message);
    let delivered = 0;
    for (const socket of set) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
        delivered += 1;
      }
    }
    return delivered;
  }

  /** Close every socket for a machine (after an operator reject). Returns count closed. */
  close(machineId: string): number {
    const set = this.byMachine.get(machineId);
    if (!set || set.size === 0) return 0;
    let closed = 0;
    for (const socket of set) {
      try {
        socket.close();
        closed += 1;
      } catch {
        /* already closing */
      }
    }
    return closed;
  }
}
