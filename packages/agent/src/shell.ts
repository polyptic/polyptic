/**
 * Remote-shell sessions on the agent side (POL-59).
 *
 * The server relays an operator's terminal over the agent's existing WS; this module owns the PTYs
 * those sessions drive. It is deliberately thin: spawn an UNPRIVILEGED shell (the agent already runs
 * as the kiosk user), pump bytes both ways as base64, honour resize, and tear down on close or exit.
 *
 * Arming is enforced by the SERVER (it won't send `server/shell-open` to a disarmed box); the agent's
 * own guard is capability, not policy — it refuses when there is no real PTY to give (a dev backend,
 * a non-Linux host). A hard session cap stops a buggy or hostile server from spawning shells without
 * bound.
 */
import { spawnPty } from "./pty";
import type { Pty } from "./pty";

/** More than a couple of concurrent operator terminals on one box is never legitimate. */
const MAX_SESSIONS = 4;
/** A shell with no activity is torn down after this long, so a forgotten tab can't hold a PTY open. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface ShellHostHooks {
  /** Emit a chunk of PTY output for `sessionId` (already base64). */
  onData(sessionId: string, dataBase64: string): void;
  /** The session ended (exit or teardown); the server should mark the operator's terminal closed. */
  onClosed(sessionId: string, reason?: string, exitCode?: number): void;
}

interface Session {
  pty: Pty;
  idleTimer: ReturnType<typeof setTimeout>;
}

export class ShellManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly hooks: ShellHostHooks,
    /** The unprivileged shell to launch. `/bin/bash` on the image; `sh` is the fallback. */
    private readonly shell = "/bin/bash",
    private readonly canPty: boolean = true,
  ) {}

  /**
   * Open a PTY for `sessionId`. Returns `{ ok }`; on failure `reason` explains why (no PTY on this
   * host, session cap hit, spawn failure) so the operator sees it instead of a dead terminal.
   */
  open(sessionId: string, cols: number, rows: number): { ok: boolean; reason?: string } {
    if (this.sessions.has(sessionId)) return { ok: true }; // idempotent re-open
    if (!this.canPty) return { ok: false, reason: "this box has no interactive shell (dev/non-Linux backend)" };
    if (this.sessions.size >= MAX_SESSIONS) return { ok: false, reason: "too many shell sessions open on this box" };

    const pty = spawnPty({
      shell: this.shell,
      cols,
      rows,
      cwd: process.env.HOME || "/",
      env: {
        TERM: "xterm-256color",
        HOME: process.env.HOME || "/home/kiosk",
        USER: process.env.USER || "kiosk",
        PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: process.env.LANG || "C.UTF-8",
        // A visible marker so an operator always knows this terminal is the Polyptic remote shell.
        PS1: "[polyptic \\u@\\h \\W]\\$ ",
      },
    });
    if (!pty) return { ok: false, reason: "could not allocate a pseudo-terminal on this box" };

    const idleTimer = setTimeout(() => this.close(sessionId, "idle timeout"), IDLE_TIMEOUT_MS);
    // `.unref()` — a dangling shell must never keep the agent process alive.
    if (typeof idleTimer.unref === "function") idleTimer.unref();
    const session: Session = { pty, idleTimer };
    this.sessions.set(sessionId, session);

    pty.onData((chunk: Buffer) => {
      this.touch(sessionId);
      this.hooks.onData(sessionId, chunk.toString("base64"));
    });
    void pty.exited.then((code) => {
      if (this.sessions.delete(sessionId)) {
        clearTimeout(idleTimer);
        this.hooks.onClosed(sessionId, "shell exited", code ?? undefined);
      }
    });
    return { ok: true };
  }

  /** Operator keystrokes (base64) → the PTY. */
  data(sessionId: string, dataBase64: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.touch(sessionId);
    session.pty.write(Buffer.from(dataBase64, "base64"));
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.pty.resize(cols, rows);
  }

  /** Tear a session down (operator closed it, box disarmed, or idle). Notifies via onClosed. */
  close(sessionId: string, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.idleTimer);
    session.pty.close();
    this.hooks.onClosed(sessionId, reason);
  }

  /** Tear down everything (WS dropped, agent shutting down). Silent — no onClosed spam over a dead socket. */
  closeAll(): void {
    for (const [, session] of this.sessions) {
      clearTimeout(session.idleTimer);
      session.pty.close();
    }
    this.sessions.clear();
  }

  private touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.idleTimer.refresh?.();
  }
}
