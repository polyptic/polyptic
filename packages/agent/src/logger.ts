/**
 * POL-187 — THE AGENT'S ONE LOGGER, and the on-box spool behind it.
 *
 * Before this file the agent had a module-private `log()`/`logError()` pair in `index.ts` and each
 * backend had its own ad-hoc variant (`sway.ts`, `x11.ts`, `power.ts`). All of them wrote
 * `console.log`, which on a box means a systemd USER journal — read only by SSHing in and typing
 * `journalctl --user -u polyptic-agent`, on a netbooted box where that journal is volatile, about a
 * failure whose story very often includes the reboot that erased it. The box knew exactly why that
 * panel did not come on, said so out loud, and threw it away.
 *
 * So every line now goes through here, and lands in TWO places:
 *
 *   1. **stdout, unchanged.** Same prefix, same shape, same journal. Shipping is ADDITIONAL, never a
 *      replacement — a box with no server to talk to must narrate itself exactly as it always did.
 *   2. **The spool**, from which it is shipped to the control plane in batches and dropped ONLY on
 *      an ack. That ack is what makes this store-and-FORWARD: a box shipping into a socket that
 *      dies loses nothing, because nothing is dropped until the server says the lines are durable.
 *
 * ── What this file promises, and what it deliberately does not ───────────────────────────────────
 *
 *   - **Survives an agent crash or restart: yes, on every box.** The spool is a file in the existing
 *     `$HOME/.polyptic` state dir, beside the durable credential, mode 0600.
 *   - **Survives a REBOOT: only on an installed-to-disk box (POL-176).** On a netbooted box `$HOME`
 *     is the RAM overlay, and a reboot takes it. We say so plainly rather than papering over it; the
 *     mitigation is EAGER shipping, so an online box's exposure is seconds, not a night.
 *   - **Bounded, drop-oldest.** A box that cannot reach its server for a week must not fill its own
 *     disk (or, worse, its RAM overlay) with logs. Past the cap the OLDEST lines go — the recent
 *     ones are the ones you are trying to read.
 *   - **Rate-capped.** Lifted from `diag.ts`'s `SEND_CAP_PER_MIN`, for the same reason: a
 *     pathological loop on one box must not be able to flood the control plane.
 *   - **Redacted at the emitter.** Every message and every string field goes through
 *     `redactMessage`, so a POL-24 send-time credential in a content URL cannot reach a log line —
 *     and therefore cannot reach the console's Download button. This is why `sway.ts`'s old raw
 *     `→ ${target.url}` line is safe now without every call site having to remember.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LOG_BATCH_MAX, LogEvent, levelAtLeast, redactMessage, sanitizeLogText } from "@polyptic/protocol";
import type { LogFields, LogLevel } from "@polyptic/protocol";

import { stateDir } from "./credential";

/** Spool ceiling. Sized so a whole boot's host journal (POL-189) survives an offline stretch;
 *  past it the oldest go, because the recent lines are the ones being read for. */
const SPOOL_CAP = Number(process.env.POLYPTIC_LOG_SPOOL_CAP?.trim() || 20_000);
/**
 * Ceiling on lines SHIPPED per minute (the stdout copy is never capped — the journal is local).
 *
 * Sized for POL-189's host-log tail, not just the agent's own narration: a boot is a few thousand
 * journald entries, and at the original 300/min a single boot took ten minutes to drain — so the
 * most interesting minutes of a box's life arrived last. Nothing is lost either way (the spool
 * holds and the cap only defers), but "why was it dark this morning" should not have to wait.
 * `POLYPTIC_LOG_SEND_CAP` tunes it for a constrained link.
 */
const SEND_CAP_PER_MIN = Number(process.env.POLYPTIC_LOG_SEND_CAP?.trim() || 1200);
/** How often the shipper drains the spool. Eager on purpose: on a RAM box, seconds of exposure. */
const SHIP_INTERVAL_MS = 3_000;

/**
 * Ships one batch. Returns true if the batch left the process (an ack is then expected); false when
 * the channel is down or refuses to carry logs, in which case NOTHING is dropped.
 */
export type LogShipper = (batchId: string, events: LogEvent[]) => boolean;

/** One in-flight batch, held until its ack arrives (or the socket dies and it is re-queued). */
interface InFlight {
  batchId: string;
  /** The sequence numbers this batch carried, so an ack drops exactly those lines. */
  seqs: number[];
}

export interface LoggerOptions {
  machineId: string;
  /** Minimum level to SHIP. stdout always gets everything. Default `info`. */
  shipMinLevel?: LogLevel;
  /** Override the spool file location (tests). Defaults to the agent state dir. */
  spoolPath?: string;
  /** Override the drop-oldest ceiling (tests, and a constrained box). Defaults to SPOOL_CAP. */
  spoolCap?: number;
  env?: NodeJS.ProcessEnv;
}

/** The agent's logger: stdout + a durable spool + a shipper the WS wires in when it opens. */
export class AgentLogger {
  private readonly machineId: string;
  private readonly shipMinLevel: LogLevel;
  private readonly spoolPath: string;
  private readonly spoolCap: number;
  /** Lines written but not yet acked, oldest first. THE spool, mirrored to disk. */
  private spool: LogEvent[] = [];
  /** Batches on the wire awaiting an ack. Re-queued wholesale if the socket drops. */
  private inFlight: InFlight[] = [];
  private shipper: LogShipper | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private sentThisMinute = 0;
  private minuteStart = 0;
  /** Set once we have said "not shipping, and here is why" — we say it once, not every batch. */
  private refusalAnnounced = false;
  private writeQueued = false;

  constructor(opts: LoggerOptions) {
    this.machineId = opts.machineId;
    this.shipMinLevel = opts.shipMinLevel ?? "info";
    this.spoolPath =
      opts.spoolPath ?? join(stateDir(opts.env ?? process.env), `log-spool-${opts.machineId}`);
    this.spoolCap = opts.spoolCap ?? SPOOL_CAP;
    this.loadSpool();
  }

  // ── writing ────────────────────────────────────────────────────────────────

  debug(subsystem: string, msg: string, fields?: LogFields): void {
    this.write("debug", subsystem, msg, fields);
  }
  info(subsystem: string, msg: string, fields?: LogFields): void {
    this.write("info", subsystem, msg, fields);
  }
  warn(subsystem: string, msg: string, fields?: LogFields): void {
    this.write("warn", subsystem, msg, fields);
  }
  error(subsystem: string, msg: string, fields?: LogFields): void {
    this.write("error", subsystem, msg, fields);
  }

  /**
   * One line. Written to stdout in the agent's long-standing format (so `journalctl` reads exactly
   * as it always has), redacted, then spooled for shipping if it clears the ship level.
   *
   * `opts.at` overrides the timestamp — REQUIRED for POL-189's host-log tail, whose entries carry
   * journald's own clock. Stamping them "now" would file a whole replayed boot at the moment the
   * agent happened to start, which destroys the ordering that makes a boot log readable and makes
   * the console's clock-skew flag meaningless.
   *
   * `opts.echo: false` suppresses the stdout copy — also for the host tail, and not an optimisation:
   * those lines CAME from journald, so echoing them puts a second copy of every host line back into
   * the journal we are reading. On a box with a size-capped journal that is a slow way to evict the
   * very history we are trying to preserve.
   */
  write(
    level: LogLevel,
    subsystem: string,
    msg: string,
    fields?: LogFields,
    opts: { at?: string; echo?: boolean } = {},
  ): void {
    const at = opts.at ?? new Date().toISOString();
    // Redact secrets, THEN strip control bytes — the host journal and a browser's stderr are not
    // required to be clean text, and a NUL in the middle of a sentence eats the word before it.
    const clean = sanitizeLogText(redactMessage(msg)).slice(0, 1000);

    // 1. stdout — unchanged behaviour, deliberately. Errors keep going to stderr.
    if (opts.echo !== false) {
      const line = `[${at}] [${subsystem}] ${level === "error" ? "ERROR: " : level === "warn" ? "WARN: " : ""}${clean}`;
      if (level === "error") console.error(line);
      else console.log(line);
    }

    // 2. the spool — but only at or above the ship level. The browser firehose (POL-67's
    //    `POLYPTIC_BROWSER_LOG=all`) is debug-level and therefore stays on the box unless someone
    //    deliberately raises the ship level for a lab session.
    if (!levelAtLeast(level, this.shipMinLevel)) return;

    this.seq += 1;
    const event: LogEvent = {
      source: "agent",
      level,
      subsystem: subsystem.slice(0, 40),
      at,
      machineId: this.machineId,
      msg: clean,
      seq: this.seq,
      ...(fields ? { fields: redactFields(fields) } : {}),
    };
    // A line that cannot be represented must never take the agent down — drop it, having already
    // written it to stdout, where it is still readable.
    const parsed = LogEvent.safeParse(event);
    if (!parsed.success) return;

    this.spool.push(parsed.data);
    if (this.spool.length > this.spoolCap) this.spool.splice(0, this.spool.length - this.spoolCap);
    this.queueWrite();
    // Eager: a line worth shipping goes as soon as the channel will take it, so the window in which
    // a reboot could take it with the RAM overlay is seconds.
    this.drain();
  }

  // ── shipping ───────────────────────────────────────────────────────────────

  /**
   * Wire (or unwire, with `null`) the channel that carries batches. Called when the agent socket
   * opens; called with null when it closes, which also RE-QUEUES anything in flight — an unacked
   * batch is by definition a batch we cannot prove landed.
   */
  setShipper(shipper: LogShipper | null): void {
    this.shipper = shipper;
    if (shipper === null) {
      this.requeueInFlight();
      this.stopTimer();
      return;
    }
    this.refusalAnnounced = false;
    this.startTimer();
    this.drain();
  }

  /**
   * Say, once, why nothing is shipping. Used for the cleartext refusal: a deployment whose agent
   * channel is not encrypted ships NOTHING (log lines carry a box's whole story), and it must say
   * so out loud rather than looking like a quiet fleet.
   */
  announceRefusal(reason: string): void {
    if (this.refusalAnnounced) return;
    this.refusalAnnounced = true;
    this.warn("logs", `not shipping logs to the server: ${reason} (they stay spooled on this box)`);
  }

  /**
   * An ack landed. `accepted` drops exactly the lines that batch carried; anything else leaves them
   * spooled for the next attempt — which is the entire difference between this and fire-and-forget.
   */
  onAck(batchId: string, accepted: boolean): void {
    const idx = this.inFlight.findIndex((b) => b.batchId === batchId);
    if (idx === -1) return; // an ack for a batch we already re-queued (socket flap) — the re-send dedupes
    const batch = this.inFlight[idx];
    if (batch === undefined) return;
    this.inFlight.splice(idx, 1);
    if (!accepted) return; // stays spooled; the server told us it did not take them
    const dropped = new Set(batch.seqs);
    this.spool = this.spool.filter((e) => e.seq === undefined || !dropped.has(e.seq));
    this.queueWrite();
  }

  /** How many lines are waiting to be acked (spool + in flight). Exposed for tests and vitals. */
  pending(): number {
    return this.spool.length;
  }

  /** Stop the ship ticker (agent shutdown). */
  stop(): void {
    this.stopTimer();
    this.flushWrite();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.drain(), SHIP_INTERVAL_MS);
    // Never hold the process open for a log ticker.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private requeueInFlight(): void {
    // The lines were never dropped from the spool (that only happens on an ack), so re-queueing is
    // simply forgetting the batch ids. The next drain re-sends them under fresh batch ids, and the
    // server's `(machineId, seq)` dedupe makes the re-send a no-op if they did in fact land.
    this.inFlight = [];
  }

  /** Send as many batches as the rate cap allows, from the oldest unshipped lines. */
  private drain(): void {
    const shipper = this.shipper;
    if (!shipper) return;
    // Lines already on the wire must not be sent twice within one connection.
    const inFlightSeqs = new Set(this.inFlight.flatMap((b) => b.seqs));
    const waiting = this.spool.filter((e) => e.seq === undefined || !inFlightSeqs.has(e.seq));
    if (waiting.length === 0) return;

    for (let i = 0; i < waiting.length; i += LOG_BATCH_MAX) {
      const batch = waiting.slice(i, i + LOG_BATCH_MAX);
      if (!this.allowSend(batch.length)) return; // the rest waits for the next minute
      const batchId = randomBatchId();
      if (!shipper(batchId, batch)) {
        this.giveBackBudget(batch.length); // the socket was down, not a real send
        return;
      }
      this.inFlight.push({
        batchId,
        seqs: batch.map((e) => e.seq).filter((s): s is number => s !== undefined),
      });
    }
  }

  private allowSend(count: number): boolean {
    const now = Date.now();
    if (now - this.minuteStart >= 60_000) {
      this.minuteStart = now;
      this.sentThisMinute = 0;
    }
    if (this.sentThisMinute + count > SEND_CAP_PER_MIN) return false;
    this.sentThisMinute += count;
    return true;
  }

  private giveBackBudget(count: number): void {
    this.sentThisMinute = Math.max(0, this.sentThisMinute - count);
  }

  // ── the spool file ─────────────────────────────────────────────────────────

  private loadSpool(): void {
    try {
      const raw = readFileSync(this.spoolPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const parsed = LogEvent.safeParse(JSON.parse(line));
        if (parsed.success) this.spool.push(parsed.data);
      }
    } catch {
      // No spool yet (first boot), or a truncated/corrupt file after a hard power cut. Either way
      // there is nothing to recover and the agent must start regardless — a logger that refuses to
      // load is a box that will not boot.
      return;
    }
    if (this.spool.length > this.spoolCap) this.spool.splice(0, this.spool.length - this.spoolCap);
    // Continue the sequence where the previous process left off, so a restart cannot re-use a seq
    // the server already stored under a different line.
    this.seq = this.spool.reduce((max, e) => Math.max(max, e.seq ?? 0), 0);
  }

  /**
   * Mirror the spool to disk on the next tick. Coalesced because a burst of lines (a boot) would
   * otherwise rewrite the file once per line; a tick's worth of loss on a hard power cut is the
   * accepted trade, and the shipped copy is the durable one anyway.
   */
  private queueWrite(): void {
    if (this.writeQueued) return;
    this.writeQueued = true;
    setTimeout(() => this.flushWrite(), 250).unref?.();
  }

  private flushWrite(): void {
    this.writeQueued = false;
    try {
      mkdirSync(stateDirOf(this.spoolPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.spoolPath, this.spool.map((e) => JSON.stringify(e)).join("\n"), {
        mode: 0o600,
      });
      try {
        chmodSync(this.spoolPath, 0o600);
      } catch {
        // Best-effort on platforms without POSIX permissions; the write already succeeded.
      }
    } catch {
      // A read-only or full state dir must not take the agent down. stdout still has every line,
      // and shipping (which does not touch this file) carries on.
    }
  }
}

/** The directory a spool path lives in, without pulling in `path.dirname` semantics we don't need. */
function stateDirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "." : path.slice(0, cut);
}

/** Redact string field values the same way messages are — a `url` field is the obvious case. */
function redactFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  let keys = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (keys >= 12) break;
    keys += 1;
    out[key.slice(0, 40)] =
      typeof value === "string" ? sanitizeLogText(redactMessage(value)).slice(0, 300) : value;
  }
  return out;
}

function randomBatchId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The process-wide logger
// ─────────────────────────────────────────────────────────────────────────────
//
// The backends (`sway.ts`, `x11.ts`, `power.ts`) log from deep inside their own object graphs and
// have never been handed a logger. Rather than thread one through every constructor — a large,
// noisy refactor that would touch every backend test — a single process-wide instance is set once
// at startup, and the module-level `log*` helpers below route to it. Before it is set (argument
// parsing, `setup`), they fall back to plain stdout, so nothing is ever silently dropped.

let current: AgentLogger | null = null;

/** Install the process-wide logger (once, at startup, as soon as the machine id is known). */
export function setAgentLogger(logger: AgentLogger): void {
  current = logger;
}

/** The process-wide logger, or null before startup has installed one. */
export function agentLogger(): AgentLogger | null {
  return current;
}

/** Log one line at `level` from `subsystem` — the seam every agent module writes through. */
export function logLine(
  level: LogLevel,
  subsystem: string,
  msg: string,
  fields?: LogFields,
): void {
  const logger = current;
  if (logger) {
    logger.write(level, subsystem, msg, fields);
    return;
  }
  // Pre-startup fallback: same shape, still redacted, just nowhere to spool it yet.
  const line = `[${new Date().toISOString()}] [${subsystem}] ${level === "error" ? "ERROR: " : ""}${redactMessage(msg)}`;
  if (level === "error") console.error(line);
  else console.log(line);
}
