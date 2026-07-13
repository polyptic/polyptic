/**
 * Player channel client (screen ↔ server) — the "instant" content path.
 *
 * Dials the server's player WS, announces itself with `player/hello`, and surfaces validated
 * `server/render` / `server/ident-pulse` frames to the caller. Reconnects with exponential
 * backoff + jitter so a control-plane blip or laptop sleep self-heals with no human in the loop.
 *
 * Every inbound frame is parsed at the edge against the shared contract; malformed frames are
 * dropped, never trusted. This module is framework-agnostic (no Vue) on purpose — the renderer
 * just feeds its callbacks into reactive state.
 */
import { PROTOCOL_VERSION, ServerToPlayerMessage, parseMessage } from "@polyptic/protocol";

export type ConnState = "connecting" | "open" | "closed";

export interface PlayerSocketHandlers {
  /** A validated server→player frame arrived. */
  onMessage: (msg: ServerToPlayerMessage) => void;
  /** The connection state changed (drives the dev badge). */
  onState: (state: ConnState) => void;
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export class PlayerSocket {
  private ws: WebSocket | null = null;
  private backoffMs = RECONNECT_MIN_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly screenId: string,
    private readonly handlers: PlayerSocketHandlers,
    /** POL-54 — the screen's bearer token from the launch URL (`?token=`), echoed in every hello so
     *  the gated server admits us. Absent on a dev stack with auth off; reconnects re-present it. */
    private readonly token?: string,
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

  /** Send a contract-shaped frame to the server. Returns false when the socket is down, so callers
   *  that queue (the diag channel) know the frame did NOT go out. */
  send(frame: unknown): boolean {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
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
      // Announce which screen this page is, so the server starts pushing our slice. The token
      // (when the launch URL carried one) is what a POL-54-gated server admits the hello on.
      this.send({
        t: "player/hello",
        protocol: PROTOCOL_VERSION,
        screenId: this.screenId,
        ...(this.token ? { token: this.token } : {}),
      });
    });

    ws.addEventListener("message", (ev) => {
      let msg: ServerToPlayerMessage;
      try {
        msg = parseMessage(ServerToPlayerMessage, ev.data as string);
      } catch (err) {
        console.warn("[player] dropping invalid server frame", err);
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
