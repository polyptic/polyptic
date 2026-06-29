/**
 * Admin channel client (admin UI ↔ server) — the live registry feed.
 *
 * Dials the server's admin WS, announces itself with `admin/hello`, and surfaces validated
 * `admin/state` snapshots to the caller. Reconnects with exponential backoff + jitter so a
 * control-plane blip or laptop sleep self-heals with no human in the loop — mirroring the
 * player socket so both clients behave identically.
 *
 * Every inbound frame is parsed at the edge against the shared contract; malformed frames are
 * dropped, never trusted.
 */
import {
  PROTOCOL_VERSION,
  ServerToAdminMessage,
  parseMessage,
} from "@polyptych/protocol";

export type ConnState = "connecting" | "open" | "closed";

export interface AdminSocketHandlers {
  /** A validated server→admin frame arrived. */
  onMessage: (msg: ServerToAdminMessage) => void;
  /** The connection state changed (drives the header status pill). */
  onState: (state: ConnState) => void;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export class AdminSocket {
  private ws: WebSocket | null = null;
  private backoffMs = RECONNECT_MIN_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly handlers: AdminSocketHandlers,
  ) {}

  /** Begin connecting (and auto-reconnecting). */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Tear down the socket and stop reconnecting. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws !== null) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  /** Send a contract-shaped frame to the server (no-op unless the socket is open). */
  send(frame: unknown): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private connect(): void {
    this.handlers.onState("connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.backoffMs = RECONNECT_MIN_MS;
      this.handlers.onState("open");
      // Announce ourselves so the server starts pushing registry snapshots.
      this.send({
        t: "admin/hello",
        protocol: PROTOCOL_VERSION,
      });
    });

    ws.addEventListener("message", (ev) => {
      let msg: ServerToAdminMessage;
      try {
        msg = parseMessage(ServerToAdminMessage, ev.data as string);
      } catch (err) {
        console.warn("[admin] dropping invalid server frame", err);
        return;
      }
      this.handlers.onMessage(msg);
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handlers.onState("closed");
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // An error is always followed by `close`; force teardown so reconnect logic runs once.
      try {
        ws.close();
      } catch {
        /* noop */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== null) return;
    const jitter = Math.random() * 0.3 * this.backoffMs;
    const delay = this.backoffMs + jitter;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
  }
}
