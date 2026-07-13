/**
 * Remote-DevTools bridge on the agent side (POL-67).
 *
 * Chrome on this box listens on a LOOPBACK-ONLY `--remote-debugging-port` per output; the server
 * relays an operator's DevTools frontend over the agent's existing WS (the POL-59 shell pattern),
 * and this module is the last hop: it proxies one-shot HTTP GETs (the frontend's files + the target
 * list) and bridges the CDP WebSocket, both against 127.0.0.1 only.
 *
 * The AUTHORITATIVE gate is `backend.devtoolsEndpoint(connector)`: it returns a port only for a
 * RUNNING Chrome on an output an operator ARMED (`server/inspect on`). Every request and every
 * session-open re-checks it, so a disarmed connector goes dark even mid-session on the next frame
 * the operator sends. The server enforces the same policy upstream; this is defense in depth —
 * the debugging port can drive the page, so nothing may reach it except the armed, authenticated
 * tunnel.
 */
import WebSocket from "ws";
import type { DisplayBackend } from "./backends/types";

/** One DevTools frontend tab holds one CDP socket; a few tabs is plenty, more is a bug or abuse. */
const MAX_SESSIONS = 4;
/** Bound one proxied response — the largest frontend bundle is a few MB; 32 MB is a hard stop. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** A CDP socket with no traffic is torn down, so a forgotten tab can't hold the tunnel open. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** How long one proxied HTTP GET may take against loopback Chrome. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface DevtoolsHostHooks {
  /** The answer to one proxied GET (`reqId` matches the server's `server/devtools-request`). */
  onResponse(
    reqId: string,
    res:
      | { ok: true; status: number; contentType?: string; bodyBase64: string }
      | { ok: false; error: string },
  ): void;
  /** The CDP socket for `sessionId` connected (or refused, with the reason). */
  onOpened(sessionId: string, ok: boolean, reason?: string): void;
  /** One CDP frame from Chrome (base64 of the text frame). */
  onData(sessionId: string, dataBase64: string): void;
  /** The CDP socket ended (Chrome closed it, idle, or teardown). */
  onClosed(sessionId: string, reason?: string): void;
}

interface Session {
  connector: string;
  ws: WebSocket;
  opened: boolean;
  idleTimer: ReturnType<typeof setTimeout>;
}

export class DevtoolsManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly backend: DisplayBackend,
    private readonly hooks: DevtoolsHostHooks,
    private readonly log: (msg: string) => void,
  ) {}

  /** Proxy one HTTP GET to the armed connector's DevTools port. Never throws; errors ride the hook. */
  async request(reqId: string, connector: string, path: string): Promise<void> {
    const endpoint = this.backend.devtoolsEndpoint(connector);
    if (!endpoint) {
      this.hooks.onResponse(reqId, {
        ok: false,
        error: `DevTools are not armed for ${connector} (or its browser is not Chrome / not running)`,
      });
      return;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = Buffer.from(await res.arrayBuffer());
      if (body.byteLength > MAX_BODY_BYTES) {
        this.hooks.onResponse(reqId, { ok: false, error: `response too large (${body.byteLength} bytes)` });
        return;
      }
      const contentType = res.headers.get("content-type") ?? undefined;
      this.hooks.onResponse(reqId, {
        ok: true,
        status: res.status,
        ...(contentType ? { contentType } : {}),
        bodyBase64: body.toString("base64"),
      });
    } catch (err) {
      this.hooks.onResponse(reqId, {
        ok: false,
        error: `could not reach Chrome's DevTools port: ${(err as Error).message}`,
      });
    }
  }

  /** Open the CDP WebSocket to Chrome for `sessionId`. The outcome rides `onOpened`. */
  open(sessionId: string, connector: string, path: string): void {
    if (this.sessions.has(sessionId)) {
      this.hooks.onOpened(sessionId, true); // idempotent re-open
      return;
    }
    const endpoint = this.backend.devtoolsEndpoint(connector);
    if (!endpoint) {
      this.hooks.onOpened(
        sessionId,
        false,
        `DevTools are not armed for ${connector} (or its browser is not Chrome / not running)`,
      );
      return;
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      this.hooks.onOpened(sessionId, false, "too many DevTools sessions open on this box");
      return;
    }

    const ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}${path}`);
    const idleTimer = setTimeout(() => this.close(sessionId, "idle timeout"), IDLE_TIMEOUT_MS);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
    const session: Session = { connector, ws, opened: false, idleTimer };
    this.sessions.set(sessionId, session);

    ws.on("open", () => {
      session.opened = true;
      this.hooks.onOpened(sessionId, true);
      this.log(`devtools session ${sessionId} open (${connector} :${endpoint.port})`);
    });
    ws.on("message", (raw) => {
      this.touch(sessionId);
      const buf = Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw);
      this.hooks.onData(sessionId, buf.toString("base64"));
    });
    ws.on("error", (err: Error) => {
      if (!session.opened) {
        // Connect failure: report it as a refused open, not a silent dead session.
        if (this.sessions.delete(sessionId)) {
          clearTimeout(idleTimer);
          this.hooks.onOpened(sessionId, false, `could not connect to Chrome: ${err.message}`);
        }
      } else {
        this.log(`devtools session ${sessionId} error: ${err.message}`);
      }
    });
    ws.on("close", () => {
      if (this.sessions.delete(sessionId)) {
        clearTimeout(idleTimer);
        if (session.opened) this.hooks.onClosed(sessionId, "Chrome closed the connection");
      }
    });
  }

  /** One CDP frame from the operator's frontend → Chrome. Re-checks the arm on EVERY frame. */
  data(sessionId: string, dataBase64: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!this.backend.devtoolsEndpoint(session.connector)) {
      this.close(sessionId, "DevTools disarmed");
      return;
    }
    this.touch(sessionId);
    // CDP frames are TEXT (JSON); Chrome rejects binary frames, so decode before sending.
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(Buffer.from(dataBase64, "base64").toString("utf8"));
    }
  }

  /** Tear a session down (tab closed, screen disarmed, idle). Notifies via onClosed. */
  close(sessionId: string, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.idleTimer);
    try {
      session.ws.close();
    } catch {
      // already gone
    }
    this.hooks.onClosed(sessionId, reason);
  }

  /** Tear down everything (WS dropped, agent shutting down). Silent — the socket that would carry
   *  the notifications is the one that just died. */
  closeAll(): void {
    for (const [, session] of this.sessions) {
      clearTimeout(session.idleTimer);
      try {
        session.ws.close();
      } catch {
        // already gone
      }
    }
    this.sessions.clear();
  }

  private touch(sessionId: string): void {
    this.sessions.get(sessionId)?.idleTimer.refresh?.();
  }
}
