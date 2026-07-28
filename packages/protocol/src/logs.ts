/**
 * POL-187 — FLEET LOGGING: one envelope, three emitters, one place to read it.
 *
 * The bug that made this necessary: a wall left asleep and working had dark panels in the morning,
 * and there was nothing to look at. Not because the boxes are silent — `sway.ts` narrates every
 * browser spawn, `power.ts` every DPMS command, the scheduler every verdict — but because every one
 * of those lines was a `console.log` into a systemd USER journal on a diskless box, which a reboot
 * (very often part of the story you are trying to read) takes with it.
 *
 * So this file defines the ONE envelope every emitter uses:
 *
 *   - the AGENT, through its shared logger (which still writes stdout — shipping is ADDITIONAL,
 *     never a replacement, so `journalctl --user -u polyptic-agent` behaves exactly as before),
 *   - the PLAYER, re-homed off the POL-86 `player/diag` line onto this envelope,
 *   - the SERVER, at the decisions that matter (a scheduler verdict, a power command sent, an ack
 *     received or not) — deliberately hand-placed calls, not a transport hook on every HTTP request.
 *
 * ONE SCHEMA, NOT ONE PER EVENT KIND. The temptation is a typed contract per event ("panel.slept",
 * "browser.spawned", …) and it is a trap: the contract explodes, every new line is a protocol
 * change, and cross-box correlation still ends up going through a string. Instead: a level, a
 * subsystem, a message, and a BOUNDED `fields` bag for the handful of things worth filtering on.
 *
 * REDACTION LIVES AT THE EMITTER. Content URLs carry auth tokens the server stamps at send time
 * (POL-24). `redactUrl` (./redact) is promoted here so ONE implementation serves the player, the
 * agent and the server — a log line that reaches an operator's Download button must never carry a
 * live credential.
 */
import { z } from "zod";

/** Levels, ranked. `debug` is emitted but NOT shipped by default (see LOG_SHIP_MIN_LEVEL). */
export const LogLevel = z.enum(["debug", "info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevel>;

/** Rank for "at or above this level" comparisons. */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Does `level` sit at or above `min`? */
export function levelAtLeast(level: LogLevel, min: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

/** Which of the three emitters wrote the line. Also decides how it is addressed on the way in. */
export const LogSource = z.enum(["agent", "player", "server"]);
export type LogSource = z.infer<typeof LogSource>;

/** Caps on the `fields` bag. It is a filtering aid, not a schema by stealth. */
export const LOG_FIELD_MAX_KEYS = 12;
export const LOG_FIELD_KEY_MAX = 40;
export const LOG_FIELD_VALUE_MAX = 300;

/**
 * A bounded bag of structured values. Keys and value lengths are capped and the key COUNT is
 * enforced, so a caller cannot grow an ad-hoc schema in here one line at a time.
 *
 * Conventional keys — use these names when the value fits, so a filter written for one subsystem
 * keeps working across the others:
 *   `connector` · `screenId` · `machineId` · `muralId` · `sceneId` · `surfaceId` · `sourceId`
 *   `url` (REDACTED — origin + path only) · `on` · `reason` · `delivered` · `code` · `durationMs`
 */
export const LogFields = z
  .record(
    z.string().min(1).max(LOG_FIELD_KEY_MAX),
    z.union([z.string().max(LOG_FIELD_VALUE_MAX), z.number(), z.boolean()]),
  )
  .refine((f) => Object.keys(f).length <= LOG_FIELD_MAX_KEYS, {
    message: `at most ${LOG_FIELD_MAX_KEYS} fields`,
  });
export type LogFields = z.infer<typeof LogFields>;

/** Cap on one message. Generous enough for a browser's own error line, bounded enough to batch. */
export const LOG_MSG_MAX = 1000;

/**
 * ONE log line, as it leaves its emitter.
 *
 * `at` is the EMITTER's clock. On a cold-booting box that clock may still be at 1970 (POL-148
 * disciplines it via timesyncd, but there is a convergence window — exactly when this bug happens),
 * so the server stamps its OWN `receivedAt` on arrival and every query orders and partitions by
 * THAT. The box clock is kept beside it, and the console flags a line whose two clocks disagree.
 */
export const LogEvent = z.object({
  source: LogSource,
  level: LogLevel,
  /** Which part of the system spoke: "sway", "power", "scheduler", "player", "panel-power", … */
  subsystem: z.string().min(1).max(40),
  /** Emitter-side ISO-8601 timestamp. NOT trusted for ordering — see the note above. */
  at: z.string().max(40),
  /** The box this line came from. Absent only for control-plane lines (they file under `server`). */
  machineId: z.string().max(120).optional(),
  /** The screen the line is about, when it is about one. */
  screenId: z.string().max(120).optional(),
  msg: z.string().max(LOG_MSG_MAX),
  fields: LogFields.optional(),
  /**
   * Per-machine monotonic sequence number. The server dedupes on `(machineId, seq)`, which is what
   * makes the ack idempotent: a batch that was written but whose ack was lost is re-sent, and the
   * re-send lands nowhere. Absent for server-emitted lines (nothing re-sends those).
   */
  seq: z.number().int().nonnegative().optional(),
});
export type LogEvent = z.infer<typeof LogEvent>;

/** A line as it is STORED and read back: the emitter's envelope plus the server's own clock. */
export const StoredLogEvent = LogEvent.extend({
  /** Server-side ISO-8601 arrival stamp. Queries range, partition and order on this. */
  receivedAt: z.string().max(40),
});
export type StoredLogEvent = z.infer<typeof StoredLogEvent>;

/** Most events one `agent/logs` batch may carry. Bounds the frame and the parse cost. */
export const LOG_BATCH_MAX = 200;

/**
 * Agent → server: a batch from the on-box spool. The agent keeps every line until the matching
 * `server/logs-ack` comes back — THAT is what makes this store-and-FORWARD rather than
 * fire-and-forget, and it is the load-bearing element of the whole ticket. A box shipping into a
 * socket that dies loses nothing; it re-sends, and the sequence numbers make the re-send a no-op.
 */
export const AgentLogs = z.object({
  t: z.literal("agent/logs"),
  machineId: z.string(),
  /** Correlates the ack. Random per batch; a re-send of the same lines uses a FRESH batchId. */
  batchId: z.string().min(1).max(64),
  events: z.array(LogEvent).min(1).max(LOG_BATCH_MAX),
});
export type AgentLogs = z.infer<typeof AgentLogs>;

/** Why the server would not take a batch. `cleartext` is the security posture, not a failure. */
export const LogsAckStatus = z.enum(["accepted", "refused"]);
export type LogsAckStatus = z.infer<typeof LogsAckStatus>;

/**
 * Server → agent: the batch is DURABLE (or was refused, and must stay spooled). The agent drops a
 * batch from its spool on `accepted` and on nothing else.
 */
export const ServerToAgentLogsAck = z.object({
  t: z.literal("server/logs-ack"),
  batchId: z.string().min(1).max(64),
  status: LogsAckStatus,
  /** How many lines were written (duplicates, already stored, are not counted again). */
  written: z.number().int().nonnegative(),
  /** Why the server refused, in words the box can log. */
  reason: z.string().max(200).optional(),
});
export type ServerToAgentLogsAck = z.infer<typeof ServerToAgentLogsAck>;

/**
 * Player → server: one line on the shared envelope (POL-187), replacing POL-86's `player/diag`.
 * The player's localStorage ring already made it store-and-forward — queue while the socket is
 * down, replay the tail of a previous page-life on boot — so re-homing it costs nothing and buys
 * the glass a place in the same merged timeline as the box under it.
 */
export const PlayerLog = z.object({
  t: z.literal("player/log"),
  screenId: z.string(),
  event: LogEvent,
});
export type PlayerLog = z.infer<typeof PlayerLog>;

// ─────────────────────────────────────────────────────────────────────────────
// Reading it back (Console ▸ Logs) — admin-only, always time-bounded.
// ─────────────────────────────────────────────────────────────────────────────

/** Hard ceiling on one query's result, whatever the caller asks for. */
export const LOG_QUERY_MAX_LIMIT = 2000;
/** What a query returns when it does not say. */
export const LOG_QUERY_DEFAULT_LIMIT = 500;

/**
 * A logs query. Every field is optional EXCEPT the implicit time bound: with no `since` the server
 * uses the last hour, because an unbounded fleet-wide scan over files is the rabbit hole this
 * design is built to avoid (partitioned per machine per UTC day, so a range prunes to a handful).
 */
export const LogQuery = z.object({
  /** Inclusive lower bound on the SERVER's `receivedAt`. Default: one hour ago. */
  since: z.string().max(40).optional(),
  /**
   * INCLUSIVE upper bound on `receivedAt`. Default: now.
   *
   * Inclusive on purpose. The default is "now", and an exclusive bound there drops a line stamped
   * in the same millisecond the query ran — which is invisible in production and reliably wrong the
   * moment anything (a test, a replayed range) freezes the clock. Both ends inclusive is also what
   * an operator picking "18:00 to 09:00" means.
   */
  until: z.string().max(40).optional(),
  /** Restrict to one box (`machineId`), or `server` for the control plane's own lines. */
  machineId: z.string().max(120).optional(),
  screenId: z.string().max(120).optional(),
  /** Minimum level — `warn` shows warnings and errors. */
  minLevel: LogLevel.optional(),
  subsystem: z.string().max(40).optional(),
  source: LogSource.optional(),
  /** Case-insensitive substring match over the message (and the fields' values). */
  search: z.string().max(200).optional(),
  limit: z.number().int().positive().max(LOG_QUERY_MAX_LIMIT).optional(),
});
export type LogQuery = z.infer<typeof LogQuery>;

/** The answer: newest-first lines, plus whether the cap bit. */
export const LogQueryResult = z.object({
  lines: z.array(StoredLogEvent),
  /** True when the limit truncated the range — the console offers "load older" rather than lying. */
  truncated: z.boolean(),
  /** Partitions actually read. Surfaced so a slow query is explicable rather than mysterious. */
  filesScanned: z.number().int().nonnegative(),
  /** Every machineId the sink currently holds lines for — the console's filter list. */
  machines: z.array(z.string()),
});
export type LogQueryResult = z.infer<typeof LogQueryResult>;

/**
 * Retention: an AGE cap and a per-machine SIZE cap, whichever bites first. Both, deliberately —
 * age alone lets one crash-looping box fill the volume, and size alone lets a quiet fleet keep
 * months of noise. The size cap is PER MACHINE so a chatty box evicts only its own history, never
 * the fleet's.
 */
export const LogRetention = z.object({
  /** Delete partitions older than this. */
  maxAgeHours: z.number().int().min(1).max(24 * 365),
  /** Per-machine ceiling; the oldest partitions of that machine go first. */
  maxBytesPerMachine: z.number().int().min(1024 * 1024),
});
export type LogRetention = z.infer<typeof LogRetention>;

export const UpdateLogRetentionBody = LogRetention.partial().refine(
  (b) => b.maxAgeHours !== undefined || b.maxBytesPerMachine !== undefined,
  { message: "give at least one of maxAgeHours or maxBytesPerMachine" },
);
export type UpdateLogRetentionBody = z.infer<typeof UpdateLogRetentionBody>;

/** The Settings card's view of the sink: the two numbers, plus what it currently holds. */
export const LogSinkInfo = z.object({
  retention: LogRetention,
  /** Total bytes on the log volume right now. */
  bytes: z.number().int().nonnegative(),
  /** How many machines have at least one partition. */
  machines: z.number().int().nonnegative(),
  /** The oldest line's day partition still held (ISO date), or null when the sink is empty. */
  oldestDay: z.string().nullable(),
  /** False when LOG_DIR could not be created/written — the console says so rather than showing
   *  an empty Logs place that looks like a quiet fleet. */
  writable: z.boolean(),
});
export type LogSinkInfo = z.infer<typeof LogSinkInfo>;
