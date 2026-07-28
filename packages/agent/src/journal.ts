/**
 * POL-189 — THE HOST'S OWN LOGS: journald, shipped.
 *
 * POL-187 made the AGENT explicable. It did not make the BOX explicable, and that gap shows up the
 * moment something breaks below us: greetd refused the autologin, sway died on a GPU probe, the NIC
 * never came up, the disk went read-only, an OOM killer took Chrome. The agent's own narration says
 * nothing about any of that, because the agent is downstream of all of it — and in the worst case
 * (the box never got as far as starting the agent) there is no agent narration at all.
 *
 * So we tail journald and put it on the SAME envelope. `journalctl --output=json --follow` is the
 * whole mechanism: one JSON object per entry, already structured, already carrying the box's own
 * clock, the unit, the priority and a resumable cursor.
 *
 * ── The four things that matter here ─────────────────────────────────────────────────────────────
 *
 * 1. **The feedback loop, and why this file would otherwise melt the fleet.** The agent's stdout
 *    goes to journald. If we tail journald and re-log what we read, every line we ship becomes a new
 *    journal entry, which we then read and ship, forever — an exponential amplifier pointed at the
 *    control plane. journalctl has no `--exclude-unit`, so the guard is entirely OURS: every entry
 *    whose unit or identifier is the agent's own is dropped in `consume` before it reaches the
 *    logger. Belt and braces both live here, which is why the check is by substring rather than
 *    exact match — `polyptic-agent.service`, `polyptic-agent` and a bare `polyptic-agent` _COMM all
 *    have to lose. This is not a tidy-up; it is the difference between a feature and an outage.
 *
 *    The second half of the guard is `echo: false` on the write: these lines came FROM the journal,
 *    so echoing them to stdout would put a second copy of every host line back into it — not a loop
 *    (we drop our own unit on the way in), but a steady way to fill the box's journal with itself.
 *
 * 2. **Boot logs.** With no saved cursor we start at `-b` — the beginning of THIS boot — so the
 *    story of a boot that went wrong ships in full rather than starting from whenever the agent
 *    happened to come up. `POLYPTIC_HOST_LOG_BOOTS=2` reaches back through previous boots too,
 *    which needs a PERSISTENT journal (see the setup note below); on a volatile journal there is
 *    simply nothing older than this boot to read, and we say so instead of looking broken.
 *
 * 3. **Permission is the silent killer.** Reading the system journal needs membership of
 *    `systemd-journal` (setup adds the kiosk user to it). Without it `journalctl` cheerfully returns
 *    only the user's OWN entries and exits 0 — no error, just a thin, wrong log. That is the exact
 *    failure this whole feature exists to prevent, so we probe for it explicitly at startup and say
 *    loudly what we can and cannot see.
 *
 * 4. **Volume.** A boot is a few thousand lines. The spool is bounded and the shipper rate-capped,
 *    so a chatty box degrades into "behind" rather than "eating the control plane" — but the caps
 *    are raised when host logs are on, because 300 lines/min would take ten minutes to drain a
 *    single boot. Retention's per-machine size cap is the real backstop.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LogFields, LogLevel } from "@polyptic/protocol";

import { stateDir } from "./credential";
import type { AgentLogger } from "./logger";

/** syslog priority → our level. 0–3 (emerg…err) are errors; 4 warning; 5–6 notice/info; 7 debug. */
export function levelForPriority(priority: number): LogLevel {
  if (priority <= 3) return "error";
  if (priority === 4) return "warn";
  if (priority <= 6) return "info";
  return "debug";
}

/** One parsed journal entry, reduced to what the envelope carries. */
export interface JournalEntry {
  level: LogLevel;
  /** `host:<unit>` — the unit or syslog identifier that spoke, so filtering by subsystem works. */
  subsystem: string;
  /** The box's own clock, from `__REALTIME_TIMESTAMP` (µs since epoch). */
  at: string;
  msg: string;
  fields: LogFields;
  /** journald's opaque resume token; persisted so a restart does not re-ship what we already sent. */
  cursor?: string;
}

/**
 * Parse one `journalctl -o json` line. Returns null for anything unusable, because a malformed
 * entry must never stop the tail — journald emits a few odd records (binary MESSAGE, truncated
 * lines at a rotation boundary) and losing the whole stream over one of them would be absurd.
 */
export function parseJournalLine(raw: string): JournalEntry | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  // MESSAGE is a string, or an array of byte values when the payload is not valid UTF-8.
  const rawMsg = obj.MESSAGE;
  const msg =
    typeof rawMsg === "string"
      ? rawMsg
      : Array.isArray(rawMsg)
        ? Buffer.from(rawMsg as number[]).toString("utf8")
        : null;
  if (msg === null || msg.length === 0) return null;

  const priority = Number.parseInt(String(obj.PRIORITY ?? "6"), 10);
  const unit =
    str(obj._SYSTEMD_UNIT) ?? str(obj.SYSLOG_IDENTIFIER) ?? str(obj._COMM) ?? "kernel";
  // µs since epoch. A box mid-cold-boot may still be at 1970 here — which is FINE and is exactly
  // why the server stamps its own receivedAt and the console flags the disagreement (POL-187).
  const usec = Number.parseInt(String(obj.__REALTIME_TIMESTAMP ?? ""), 10);
  const at = Number.isFinite(usec) ? new Date(usec / 1000).toISOString() : new Date().toISOString();

  const fields: LogFields = { unit: unit.slice(0, 300), priority: Number.isFinite(priority) ? priority : 6 };
  const pid = str(obj._PID);
  if (pid) fields.pid = pid;

  return {
    level: levelForPriority(Number.isFinite(priority) ? priority : 6),
    // `host:` prefixed so an operator can tell the BOX's own voice from the agent's at a glance,
    // and so a subsystem filter can select or exclude the whole class.
    subsystem: `host:${unit}`.slice(0, 40),
    at,
    msg,
    fields,
    ...(str(obj.__CURSOR) ? { cursor: str(obj.__CURSOR) as string } : {}),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export interface JournalOptions {
  logger: AgentLogger;
  machineId: string;
  /** Lowest syslog priority to ship (0–7). Default 6 = everything but debug. */
  maxPriority?: number;
  /** How many boots back to include on a cold start (1 = this boot only). */
  boots?: number;
  /** The agent's own unit/identifier, dropped on the way IN to break the feedback loop. Matched as
   *  a substring, with any `.service` suffix stripped. */
  selfUnit?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests — defaults to spawning the real journalctl. */
  spawnJournal?: (args: string[]) => ChildProcess;
}

/**
 * Tails journald into the shared logger. Start it once at agent startup; it survives journalctl
 * dying (systemd restarts, a log rotation) by re-spawning from the last cursor with backoff.
 */
export class JournalTailer {
  private readonly logger: AgentLogger;
  private readonly maxPriority: number;
  private readonly boots: number;
  private readonly selfName: string;
  private readonly cursorPath: string;
  private readonly spawnJournal: (args: string[]) => ChildProcess;
  private child: ChildProcess | null = null;
  private buffer = "";
  private cursor: string | null = null;
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;

  constructor(opts: JournalOptions) {
    this.logger = opts.logger;
    this.maxPriority = opts.maxPriority ?? 6;
    this.boots = Math.max(1, opts.boots ?? 1);
    // Matched as a SUBSTRING against `host:<unit>`, so it catches `polyptic-agent.service`, the
    // bare syslog identifier and the `_COMM` form alike.
    this.selfName = (opts.selfUnit ?? "polyptic-agent").replace(/\.service$/, "");
    this.cursorPath = join(stateDir(opts.env ?? process.env), `journal-cursor-${opts.machineId}`);
    this.spawnJournal =
      opts.spawnJournal ?? ((args) => spawn("journalctl", args, { stdio: ["ignore", "pipe", "pipe"] }));
    this.cursor = this.loadCursor();
  }

  /** The journalctl arguments for the current state — resume from the cursor, else this boot. */
  args(): string[] {
    const base = [
      "--output=json",
      "--follow",
      "--no-pager",
      `--priority=${this.maxPriority}`,
      // Only the fields we actually put on the envelope — journald carries dozens per entry, and a
      // boot's worth of unread metadata is real bytes off a constrained link.
      `--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_COMM,_PID,__REALTIME_TIMESTAMP,__CURSOR`,
    ];
    if (this.cursor) return [...base, `--after-cursor=${this.cursor}`];
    // Cold start: the whole of this boot (or further back), so a bad boot ships its own story.
    return [...base, `--boot=${this.boots === 1 ? "0" : `-${this.boots - 1}`}`];
  }

  start(): void {
    if (this.stopped || this.child) return;
    const args = this.args();
    let child: ChildProcess;
    try {
      child = this.spawnJournal(args);
    } catch (err) {
      // No journalctl at all (a container, a non-systemd host). Say it ONCE — a missing host log is
      // a thing an operator must know about, not something to discover by its absence.
      this.logger.warn("host-logs", `cannot read the host journal: ${(err as Error).message}`);
      return;
    }
    this.child = child;

    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.logger.warn("host-logs", `journalctl: ${text.slice(0, 300)}`);
    });
    child.on("error", (err) => {
      this.logger.warn("host-logs", `journalctl failed: ${err.message}`);
      this.scheduleRestart();
    });
    child.on("exit", (code) => {
      this.child = null;
      if (this.stopped) return;
      // --follow should never exit on its own; if it did, the journal rotated or was restarted.
      this.logger.warn("host-logs", `journalctl exited (code ${code ?? "?"}) — resuming from the last cursor`);
      this.scheduleRestart();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.child?.kill();
    this.child = null;
    this.saveCursor();
  }

  /** Feed raw stdout in; splits on newlines and emits every complete entry. */
  consume(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const entry = parseJournalLine(line);
      if (!entry) continue;
      // THE feedback-loop guard (see the header). journalctl cannot exclude a unit, so this is the
      // only thing standing between us and shipping our own shipping, forever.
      if (entry.subsystem.includes(this.selfName)) continue;
      // journald's OWN timestamp, and no stdout echo — these lines are already in the journal, so
      // echoing them would write a second copy of every host line into the log we are reading.
      this.logger.write(entry.level, entry.subsystem, entry.msg, entry.fields, {
        at: entry.at,
        echo: false,
      });
      if (entry.cursor) this.cursor = entry.cursor;
    }
    // Cheap: the cursor file is one short line and a boot's worth of entries is one burst.
    this.saveCursor();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    this.restarts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.restarts, 5));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }

  private loadCursor(): string | null {
    try {
      const raw = readFileSync(this.cursorPath, "utf8").trim();
      return raw.length > 0 ? raw : null;
    } catch {
      return null; // first run, or a wiped RAM overlay — start at this boot
    }
  }

  private saveCursor(): void {
    if (!this.cursor) return;
    try {
      writeFileSync(this.cursorPath, this.cursor, { mode: 0o600 });
    } catch {
      // A read-only state dir costs us resume-across-restart, not the tail itself.
    }
  }
}

/**
 * Can this process actually read the SYSTEM journal, or only its own user entries?
 *
 * This exists because the failure is SILENT: without `systemd-journal` membership, `journalctl`
 * exits 0 and returns a thin, user-only view. An operator would see host logs appearing and have no
 * reason to suspect they were missing everything the system said — the precise class of quiet
 * half-truth POL-187 was written to end. So we ask a question only a privileged reader can answer
 * (`--boot=0 --lines=1` against a system-only unit field) and report the answer either way.
 */
export async function probeJournalAccess(
  run: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await run("journalctl", ["--boot=0", "--lines=1", "--output=json", "--no-pager", "_TRANSPORT=kernel"]);
    if (res.code !== 0) {
      return { ok: false, detail: res.stderr.trim().slice(0, 200) || `journalctl exited ${res.code}` };
    }
    if (res.stdout.trim().length === 0) {
      return {
        ok: false,
        detail:
          "journalctl returned no kernel entries — this process is probably not in the `systemd-journal` group, so it can only see its own logs",
      };
    }
    return { ok: true, detail: "reading the full system journal" };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 200) };
  }
}
