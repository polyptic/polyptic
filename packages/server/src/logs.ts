/**
 * POL-187 — THE SINK. Where the fleet's logs land, and how they are read back.
 *
 * STORAGE IS FILES, NOT POSTGRES, and deliberately: logs are append-heavy, read rarely, deleted on
 * a schedule, and never joined against anything. NDJSON on a volume gives all of that for free, plus
 * the property that made it worth choosing — you can `grep` it. The No-Gos are the other half of the
 * decision: no Loki, no Elasticsearch, no index service. Files and filters.
 *
 * PARTITIONED PER MACHINE PER UTC DAY:
 *
 *     LOG_DIR/<machineId>/<YYYY-MM-DD>.ndjson
 *
 * which is what keeps a fleet-wide query from scanning everything: a time range prunes to a handful
 * of files, and the per-machine size cap can evict ONE box's history without touching the fleet's.
 * The control plane's own lines file under the reserved id `server` (see SERVER_PARTITION).
 *
 * THE DAY IS THE SERVER'S, NOT THE BOX'S. A box booting before timesyncd converges (POL-148 gives
 * it an NTP host, but there is a window, and it is exactly the window this bug happens in) writes
 * `at: 1970-01-01`. Partition or order by that and "show me last night" silently misses the very
 * lines you are looking for. So every line is stamped with the server's `receivedAt` on arrival, and
 * partitioning, ranging and ordering ALL run on that. The box's own clock is kept beside it, and the
 * console flags a line whose two clocks disagree — the skew is itself a finding.
 *
 * DEDUPE MAKES THE ACK IDEMPOTENT. A batch whose ack was lost is re-sent by the box, and would
 * otherwise land twice. Each line carries a per-machine monotonic `seq`; the sink remembers the
 * recent ones per machine and drops a repeat. That is what lets the agent's rule be as simple as
 * "drop only on an ack" without the sink filling with carbon copies.
 *
 * SAFETY. `machineId` never reaches the filesystem raw — it is sanitized to a safe token and the
 * resolved path is asserted to stay INSIDE the log dir, copying `media.ts`'s discipline. At-rest
 * encryption is a STORAGE-layer concern (LOG_DIR wants an encrypted volume) — encrypting the files
 * in the app would break the grep-a-file property, create a key-management problem we do not
 * otherwise have, and do nothing about the real exposure, which is the Download button.
 */
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve, sep } from "node:path";

import {
  LOG_QUERY_DEFAULT_LIMIT,
  LOG_QUERY_MAX_LIMIT,
  LogRetention as LogRetentionSchema,
  StoredLogEvent,
  levelAtLeast,
} from "@polyptic/protocol";
import type {
  LogEvent,
  LogQuery,
  LogQueryResult,
  LogRetention,
  LogSinkInfo,
  StoredLogEvent as StoredLogEventType,
} from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";

/** The reserved partition the control plane's own decisions file under. */
export const SERVER_PARTITION = "server";

/**
 * The narrow seam the control plane's own decision points write through (POL-187, element 6).
 *
 * Deliberately a hand-placed call at the decisions that MATTER — a scheduler verdict, a power
 * command sent, an ack received or not — rather than a transport hook on pino. Folding in "the
 * server log" wholesale would mean folding in every HTTP request, and the signal that explains a
 * dark panel would drown in it. Decisions, not noise.
 *
 * Optional at every call site so a test can construct a scheduler without a volume.
 */
export interface FleetLogger {
  record(event: LogEvent): void;
}

/** Build one control-plane line. `machineId`/`screenId` file it beside the box's own narration. */
export function serverEvent(
  level: LogEvent["level"],
  subsystem: string,
  msg: string,
  extra: { machineId?: string; screenId?: string; fields?: LogEvent["fields"] } = {},
): LogEvent {
  return {
    source: "server",
    level,
    subsystem,
    at: new Date().toISOString(),
    msg,
    ...(extra.machineId ? { machineId: extra.machineId } : {}),
    ...(extra.screenId ? { screenId: extra.screenId } : {}),
    ...(extra.fields ? { fields: extra.fields } : {}),
  };
}

/** Defaults for the two retention numbers. Both are operator-settable (Console ▸ Settings). */
export const DEFAULT_RETENTION: LogRetention = {
  // A week. The bug that motivated this happens overnight and is looked at in the morning — but not
  // always the NEXT morning, and a Friday-night failure read on Monday must still be there.
  maxAgeHours: 24 * 7,
  // Per machine, so a crash-looping box evicts only its own history and never the fleet's.
  maxBytesPerMachine: 128 * 1024 * 1024,
};

/** How many recent sequence numbers to remember per machine for the dedupe. Several batches' worth. */
const SEQ_MEMORY = 2000;

/** How often the retention sweeper runs. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface LogSinkOptions {
  dir: string;
  retention?: LogRetention;
  log?: FastifyBaseLogger;
  /** Injected so retention and partitioning are testable without waiting for midnight. */
  now?: () => Date;
}

/** One machine's day partition, as the sweeper sees it. */
interface Partition {
  machine: string;
  day: string;
  path: string;
  bytes: number;
}

export class LogSink {
  private readonly dir: string;
  private readonly log: FastifyBaseLogger | undefined;
  private readonly now: () => Date;
  private retention: LogRetention;
  /** machineId → the recent `seq` values already written (the idempotent-ack dedupe). */
  private readonly seen = new Map<string, Set<number>>();
  /** Serializes appends so two concurrent batches cannot interleave inside one NDJSON line. */
  private writeChain: Promise<void> = Promise.resolve();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  /** False when LOG_DIR could not be created — the console says so rather than showing an empty
   *  Logs place, which reads as a quiet fleet and is the one lie this feature cannot afford. */
  private writable = false;

  constructor(opts: LogSinkOptions) {
    this.dir = resolve(opts.dir);
    this.retention = opts.retention ?? DEFAULT_RETENTION;
    this.log = opts.log;
    this.now = opts.now ?? (() => new Date());
  }

  /** Create the log directory. Never throws: a server that cannot log must still serve walls. */
  async init(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      // Prove it is actually writable, not merely present (a read-only mount passes mkdir).
      const probe = join(this.dir, ".writable");
      await writeFile(probe, "");
      await rm(probe, { force: true });
      this.writable = true;
      await this.loadRetention();
    } catch (err) {
      this.writable = false;
      this.log?.error(
        { event: "logs.sink.unwritable", dir: this.dir, err: String(err) },
        "LOG_DIR is not writable — fleet logs will NOT be stored (the boxes keep spooling theirs)",
      );
    }
  }

  /** Is the sink able to store anything? Surfaced to operators; also gates the agent's ack. */
  isWritable(): boolean {
    return this.writable;
  }

  get currentRetention(): LogRetention {
    return this.retention;
  }

  /**
   * Change the two numbers and sweep immediately, so an operator who shortens retention sees the
   * volume shrink rather than waiting an hour to find out whether it took.
   *
   * The setting is persisted as a sidecar INSIDE the log volume, not in Postgres — the same
   * reasoning as `media.ts`'s `index.json`: the policy belongs to the volume it governs, so moving
   * the volume moves its retention with it, and no DB migration is needed for two integers.
   */
  async setRetention(next: LogRetention): Promise<void> {
    this.retention = next;
    await this.saveRetention();
    await this.sweep();
  }

  private settingsPath(): string {
    return join(this.dir, "retention.json");
  }

  private async loadRetention(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath(), "utf8");
      const parsed = LogRetentionSchema.safeParse(JSON.parse(raw));
      if (parsed.success) this.retention = parsed.data;
    } catch {
      // No sidecar yet (a fresh volume) — the defaults stand until an operator changes them.
    }
  }

  private async saveRetention(): Promise<void> {
    try {
      await writeFile(this.settingsPath(), JSON.stringify(this.retention, null, 2), "utf8");
    } catch (err) {
      this.log?.warn(
        { event: "logs.retention.save-failed", err: String(err) },
        "could not persist the log retention settings",
      );
    }
  }

  /** Start the retention sweeper (and sweep once now, so a restart tidies immediately). */
  start(): void {
    if (this.sweeper) return;
    void this.sweep();
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    (this.sweeper as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = null;
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /**
   * Write a batch. Returns how many lines were actually stored — a duplicate (same machine, same
   * `seq`, already written) is counted as handled but not written again, which is what makes a
   * re-sent batch after a lost ack a no-op rather than a double entry.
   *
   * Throws only if the volume itself fails, which the caller turns into a `refused` ack so the box
   * keeps the lines rather than dropping them into a hole.
   */
  async write(events: LogEvent[]): Promise<number> {
    if (!this.writable) throw new Error("the log volume is not writable");
    const receivedAt = this.now().toISOString();
    const day = receivedAt.slice(0, 10);

    /** partition path → the lines to append there. */
    const byPartition = new Map<string, string[]>();
    let written = 0;

    for (const event of events) {
      const machine = event.machineId ?? SERVER_PARTITION;
      if (event.seq !== undefined && this.alreadySeen(machine, event.seq)) continue;
      const stored: StoredLogEventType = { ...event, receivedAt };
      const parsed = StoredLogEvent.safeParse(stored);
      if (!parsed.success) continue; // never let one malformed line reject a whole batch
      const path = this.partitionPath(machine, day);
      const lines = byPartition.get(path);
      if (lines) lines.push(JSON.stringify(parsed.data));
      else byPartition.set(path, [JSON.stringify(parsed.data)]);
      written += 1;
    }

    if (byPartition.size === 0) return written;

    // Serialized: two concurrent batches appending to the same file could otherwise interleave
    // mid-line and produce an unparseable record.
    const task = this.writeChain.then(async () => {
      for (const [path, lines] of byPartition) {
        await mkdir(dirOf(path), { recursive: true });
        await appendFile(path, `${lines.join("\n")}\n`, "utf8");
      }
    });
    this.writeChain = task.catch(() => {}); // a failed write must not poison the chain
    await task;
    return written;
  }

  /** Write one control-plane line. Fire-and-forget by design — a decision must not await a disk. */
  record(event: LogEvent): void {
    void this.write([event]).catch((err) => {
      this.log?.warn({ event: "logs.sink.write-failed", err: String(err) }, "could not store a log line");
    });
  }

  private alreadySeen(machine: string, seq: number): boolean {
    let set = this.seen.get(machine);
    if (!set) {
      set = new Set();
      this.seen.set(machine, set);
    }
    if (set.has(seq)) return true;
    set.add(seq);
    if (set.size > SEQ_MEMORY) {
      // Drop the lowest half — sequences only ever grow, so the oldest are the safe ones to forget.
      const sorted = [...set].sort((a, b) => a - b);
      for (const s of sorted.slice(0, Math.floor(SEQ_MEMORY / 2))) set.delete(s);
    }
    return false;
  }

  // ── reading ────────────────────────────────────────────────────────────────

  /**
   * Query the sink. ALWAYS time-bounded (an absent `since` means the last hour) and ALWAYS capped,
   * because an unbounded fleet-wide scan over files is precisely the rabbit hole the partitioning
   * exists to avoid. Newest first.
   */
  async query(q: LogQuery): Promise<LogQueryResult> {
    const until = q.until ? Date.parse(q.until) : this.now().getTime();
    const since = q.since ? Date.parse(q.since) : until - 60 * 60 * 1000;
    const limit = Math.min(q.limit ?? LOG_QUERY_DEFAULT_LIMIT, LOG_QUERY_MAX_LIMIT);
    const machines = await this.listMachines();

    const wanted = q.machineId ? machines.filter((m) => m === sanitize(q.machineId ?? "")) : machines;
    const days = daysBetween(since, until);
    const search = q.search?.toLowerCase();

    const lines: StoredLogEventType[] = [];
    let filesScanned = 0;
    let truncated = false;

    // Newest day first, newest machine-partition first: we can stop as soon as the cap is reached
    // and still be showing the operator the most recent lines, which are the ones they asked for.
    for (const day of [...days].reverse()) {
      for (const machine of wanted) {
        const path = this.partitionPath(machine, day);
        let found: StoredLogEventType[];
        try {
          found = await readPartition(path);
        } catch {
          continue; // a day this machine did not speak on — the common case, not an error
        }
        filesScanned += 1;
        for (const line of found) {
          const at = Date.parse(line.receivedAt);
          if (!Number.isFinite(at) || at < since || at > until) continue; // both ends inclusive
          if (q.screenId && line.screenId !== q.screenId) continue;
          if (q.minLevel && !levelAtLeast(line.level, q.minLevel)) continue;
          if (q.subsystem && line.subsystem !== q.subsystem) continue;
          if (q.source && line.source !== q.source) continue;
          if (search && !matchesSearch(line, search)) continue;
          lines.push(line);
        }
      }
      // Sort + trim per day so a long range never holds the whole fleet's week in memory at once.
      lines.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      if (lines.length > limit) {
        truncated = true;
        lines.length = limit;
        break;
      }
    }

    return { lines, truncated, filesScanned, machines };
  }

  /** Every machine the sink currently holds lines for (the console's filter list). */
  async listMachines(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** What the Settings card shows: the two numbers, plus what the volume actually holds. */
  async info(): Promise<LogSinkInfo> {
    const partitions = await this.partitions();
    const bytes = partitions.reduce((sum, p) => sum + p.bytes, 0);
    const machines = new Set(partitions.map((p) => p.machine));
    const oldestDay = partitions.reduce<string | null>(
      (oldest, p) => (oldest === null || p.day < oldest ? p.day : oldest),
      null,
    );
    return {
      retention: this.retention,
      bytes,
      machines: machines.size,
      oldestDay,
      writable: this.writable,
    };
  }

  // ── retention ──────────────────────────────────────────────────────────────

  /**
   * Enforce BOTH caps, whichever bites first:
   *
   *   - AGE: any partition whose day is older than `maxAgeHours` goes, fleet-wide.
   *   - SIZE, PER MACHINE: once a machine's partitions exceed its byte cap, its OLDEST go until it
   *     is under. Per machine on purpose — a box stuck in a crash loop must not be able to evict
   *     every other box's history, which is exactly what a single global cap would let it do.
   */
  async sweep(): Promise<{ removed: number; bytesFreed: number }> {
    if (!this.writable) return { removed: 0, bytesFreed: 0 };
    const partitions = await this.partitions();
    const cutoff = new Date(this.now().getTime() - this.retention.maxAgeHours * 3600_000)
      .toISOString()
      .slice(0, 10);

    const doomed: Partition[] = [];
    const survivors = new Map<string, Partition[]>();
    for (const p of partitions) {
      if (p.day < cutoff) {
        doomed.push(p);
        continue;
      }
      const list = survivors.get(p.machine);
      if (list) list.push(p);
      else survivors.set(p.machine, [p]);
    }

    for (const [, list] of survivors) {
      let total = list.reduce((sum, p) => sum + p.bytes, 0);
      if (total <= this.retention.maxBytesPerMachine) continue;
      // Oldest first — the freshest day is the one someone is about to read.
      for (const p of [...list].sort((a, b) => a.day.localeCompare(b.day))) {
        if (total <= this.retention.maxBytesPerMachine) break;
        doomed.push(p);
        total -= p.bytes;
      }
    }

    let bytesFreed = 0;
    for (const p of doomed) {
      try {
        await rm(p.path, { force: true });
        bytesFreed += p.bytes;
      } catch {
        // A partition we cannot delete is not worth failing a sweep over; the next one retries.
      }
    }
    if (doomed.length > 0) {
      this.log?.info(
        { event: "logs.retention.swept", removed: doomed.length, bytesFreed, cutoff },
        "swept expired log partitions",
      );
    }
    return { removed: doomed.length, bytesFreed };
  }

  /** Every partition on the volume, with its size. */
  private async partitions(): Promise<Partition[]> {
    const out: Partition[] = [];
    for (const machine of await this.listMachines()) {
      let files: string[];
      try {
        files = await readdir(join(this.dir, machine));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".ndjson")) continue;
        const path = join(this.dir, machine, file);
        try {
          const s = await stat(path);
          out.push({ machine, day: file.slice(0, -".ndjson".length), path, bytes: s.size });
        } catch {
          // Raced against the sweeper — it is gone, which is the outcome we wanted anyway.
        }
      }
    }
    return out;
  }

  /**
   * The absolute path of one partition. `machineId` is sanitized to a safe token and the resolved
   * path is asserted to stay inside the log dir — the same never-trust-an-id discipline `media.ts`
   * applies to uploads, for the same reason: this id arrives over a socket.
   */
  private partitionPath(machineId: string, day: string): string {
    const safeMachine = sanitize(machineId);
    const safeDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "unknown";
    const path = resolve(join(this.dir, safeMachine, `${safeDay}.ndjson`));
    if (path !== this.dir && !path.startsWith(this.dir + sep)) {
      throw new Error("refusing a log path outside LOG_DIR");
    }
    return path;
  }
}

/** A machine id reduced to a filesystem-safe token. Never empty, never a traversal. */
export function sanitize(machineId: string): string {
  const cleaned = machineId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    // No `..` anywhere, not merely at the front: the path assertion below is the real guard, but a
    // partition directory literally named `-..-etc-passwd` is a thing no one should have to reason
    // about twice when they are looking at a volume at 8am.
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "unknown";
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf(sep);
  return cut <= 0 ? path : path.slice(0, cut);
}

/**
 * Every UTC day (YYYY-MM-DD) the range touches, oldest first.
 *
 * Enumerated BACKWARDS from `until` and then reversed, so that when a pathological range (a decade)
 * hits the guard, the days dropped are the OLDEST — never the newest. Walking forwards from `since`
 * and truncating at the cap is the same code with one catastrophic difference: it silently returns
 * a window ending years ago, so a fleet-wide "everything" query comes back EMPTY and reads exactly
 * like a quiet fleet. That is the one lie this feature cannot afford to tell.
 */
function daysBetween(sinceMs: number, untilMs: number): string[] {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || untilMs < sinceMs) return [];
  const MAX_DAYS = 400;
  const startOfDay = (ms: number): number => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const floor = startOfDay(sinceMs);
  const days: string[] = [];
  for (let cursor = startOfDay(untilMs); cursor >= floor && days.length < MAX_DAYS; cursor -= 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days.reverse();
}

/** Read one NDJSON partition into parsed lines, skipping anything unparseable. */
async function readPartition(path: string): Promise<StoredLogEventType[]> {
  await stat(path); // throws for a partition that does not exist — the caller treats that as "skip"
  const out: StoredLogEventType[] = [];
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = StoredLogEvent.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // A half-written last line after a hard kill. Skip it; the rest of the file is fine.
    }
  }
  return out;
}

/** Case-insensitive match over the message, subsystem and the fields' values. */
function matchesSearch(line: StoredLogEventType, needle: string): boolean {
  if (line.msg.toLowerCase().includes(needle)) return true;
  if (line.subsystem.toLowerCase().includes(needle)) return true;
  if (line.screenId?.toLowerCase().includes(needle)) return true;
  if (line.machineId?.toLowerCase().includes(needle)) return true;
  if (line.fields) {
    for (const value of Object.values(line.fields)) {
      if (String(value).toLowerCase().includes(needle)) return true;
    }
  }
  return false;
}

/**
 * Render a query result as the plain text an operator pastes into a ticket. Deliberately NOT JSON:
 * the point of Download is a readable account of last night, and every line is already redacted at
 * its emitter (POL-24 credentials never make it this far).
 */
export function renderLogText(lines: StoredLogEventType[]): string {
  // Oldest first — a story reads forwards, even though the UI shows newest first.
  return [...lines]
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    .map((l) => {
      const who = l.machineId ?? SERVER_PARTITION;
      const skew = clockSkewMs(l);
      const drift = skew !== null && Math.abs(skew) > 120_000 ? ` (box clock ${l.at})` : "";
      const fields = l.fields
        ? ` ${Object.entries(l.fields)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(" ")}`
        : "";
      const screen = l.screenId ? ` ${l.screenId}` : "";
      return `${l.receivedAt} ${l.level.toUpperCase().padEnd(5)} ${who}${screen} [${l.subsystem}] ${l.msg}${fields}${drift}`;
    })
    .join("\n");
}

/**
 * How far the emitter's clock is from the server's, in ms, or null if either is unparseable. A box
 * mid-cold-boot (POL-148's convergence window) can be YEARS out; the console flags it, because a
 * wildly wrong box clock is itself a finding about why a schedule fired at the wrong time.
 */
export function clockSkewMs(line: StoredLogEventType): number | null {
  const at = Date.parse(line.at);
  const received = Date.parse(line.receivedAt);
  if (!Number.isFinite(at) || !Number.isFinite(received)) return null;
  return at - received;
}
