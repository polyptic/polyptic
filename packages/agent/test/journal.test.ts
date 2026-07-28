/**
 * POL-189 — the host journal tail.
 *
 * The properties worth pinning:
 *
 *   - a journal entry keeps JOURNALD's timestamp, not "now". Replaying a boot with `now` stamps a
 *     thousand entries at the instant the agent started, which destroys the ordering that makes a
 *     boot log readable and makes the console's clock-skew flag meaningless;
 *   - the agent's own lines are NEVER read back. The agent's stdout goes to journald, so re-logging
 *     what we read is an exponential amplifier pointed at the control plane — the one bug in this
 *     file that could take out a fleet rather than just a feature;
 *   - host lines are not echoed to stdout, because they came FROM the journal we would be echoing
 *     into;
 *   - priority maps to level the way an operator expects (`err` is an error, `warning` a warning);
 *   - one malformed entry never stops the stream.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JournalTailer, levelForPriority, parseJournalLine, probeJournalAccess } from "../src/journal";
import { AgentLogger } from "../src/logger";
import type { LogEvent } from "@polyptic/protocol";

let dir: string;
let logger: AgentLogger;
let shipped: LogEvent[];

/** A journalctl `-o json` record, as journald actually emits one. */
function entry(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    __CURSOR: "s=abc;i=1;b=xyz",
    __REALTIME_TIMESTAMP: "1785200000000000", // µs
    PRIORITY: "6",
    _SYSTEMD_UNIT: "greetd.service",
    _PID: "412",
    MESSAGE: "greetd: session opened for kiosk",
    ...over,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "polyptic-journal-"));
  logger = new AgentLogger({ machineId: "box-a", spoolPath: join(dir, "spool") });
  shipped = [];
  logger.setShipper((_id, events) => {
    shipped.push(...events);
    return true;
  });
});
afterEach(async () => {
  logger.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("parsing", () => {
  test("keeps journald's own clock, unit and priority", () => {
    const parsed = parseJournalLine(entry());
    expect(parsed?.at).toBe(new Date(1785200000000).toISOString());
    expect(parsed?.subsystem).toBe("host:greetd.service");
    expect(parsed?.level).toBe("info");
    expect(parsed?.fields.unit).toBe("greetd.service");
    expect(parsed?.fields.priority).toBe(6);
    expect(parsed?.cursor).toBe("s=abc;i=1;b=xyz");
  });

  test("maps syslog priority the way an operator reads it", () => {
    expect(levelForPriority(0)).toBe("error"); // emerg
    expect(levelForPriority(3)).toBe("error"); // err
    expect(levelForPriority(4)).toBe("warn"); // warning
    expect(levelForPriority(5)).toBe("info"); // notice
    expect(levelForPriority(6)).toBe("info");
    expect(levelForPriority(7)).toBe("debug");
  });

  test("decodes a non-UTF8 MESSAGE (journald sends it as a byte array)", () => {
    const parsed = parseJournalLine(entry({ MESSAGE: [104, 105] }));
    expect(parsed?.msg).toBe("hi");
  });

  test("falls back through _SYSTEMD_UNIT → SYSLOG_IDENTIFIER → _COMM → kernel", () => {
    expect(parseJournalLine(entry({ _SYSTEMD_UNIT: undefined, SYSLOG_IDENTIFIER: "kernel" }))?.subsystem).toBe("host:kernel");
    expect(parseJournalLine(entry({ _SYSTEMD_UNIT: undefined, SYSLOG_IDENTIFIER: undefined, _COMM: "sway" }))?.subsystem).toBe("host:sway");
  });

  test("returns null rather than throwing on anything unusable", () => {
    expect(parseJournalLine("not json")).toBeNull();
    expect(parseJournalLine(JSON.stringify({ PRIORITY: "6" }))).toBeNull(); // no MESSAGE
    expect(parseJournalLine(JSON.stringify({ MESSAGE: "" }))).toBeNull();
  });
});

describe("the tail", () => {
  function tailer(): JournalTailer {
    return new JournalTailer({
      logger,
      machineId: "box-a",
      env: { POLYPTIC_STATE_DIR: dir } as NodeJS.ProcessEnv,
      // Never spawn a real journalctl in a test.
      spawnJournal: () => ({ stdout: null, stderr: null, on: () => {}, kill: () => {} }) as never,
    });
  }

  test("ships an entry with journald's timestamp, NOT the moment it was read", () => {
    tailer().consume(`${entry()}\n`);
    expect(shipped).toHaveLength(1);
    expect(shipped[0]!.at).toBe(new Date(1785200000000).toISOString());
    expect(shipped[0]!.subsystem).toBe("host:greetd.service");
  });

  test("NEVER reads the agent's own lines back — the feedback loop that would melt the fleet", () => {
    const t = tailer();
    t.consume(`${entry({ _SYSTEMD_UNIT: "polyptic-agent.service", MESSAGE: "panel slept on HDMI-1" })}\n`);
    t.consume(`${entry({ SYSLOG_IDENTIFIER: "polyptic-agent", _SYSTEMD_UNIT: undefined, MESSAGE: "again" })}\n`);
    expect(shipped).toHaveLength(0);
  });

  test("splits on newlines across chunk boundaries", () => {
    const t = tailer();
    const line = entry({ MESSAGE: "split me" });
    t.consume(line.slice(0, 20));
    expect(shipped).toHaveLength(0); // half a line is not a line
    t.consume(`${line.slice(20)}\n`);
    expect(shipped).toHaveLength(1);
    expect(shipped[0]!.msg).toBe("split me");
  });

  test("one malformed entry does not stop the stream", () => {
    const t = tailer();
    t.consume(`${entry({ MESSAGE: "before" })}\nnot json at all\n${entry({ MESSAGE: "after" })}\n`);
    expect(shipped.map((e) => e.msg)).toEqual(["before", "after"]);
  });

  test("a cold start reads THIS boot from the beginning, then resumes from the cursor", () => {
    const first = tailer();
    expect(first.args().some((a) => a === "--boot=0")).toBe(true);
    expect(first.args().some((a) => a.startsWith("--after-cursor"))).toBe(false);

    first.consume(`${entry()}\n`);
    // A restart picks up where the last entry left off rather than re-shipping the boot.
    const resumed = tailer();
    expect(resumed.args()).toContain("--after-cursor=s=abc;i=1;b=xyz");
  });

  test("filters by priority on journalctl's side, not ours", () => {
    const t = new JournalTailer({
      logger,
      machineId: "box-a",
      maxPriority: 4,
      env: { POLYPTIC_STATE_DIR: dir } as NodeJS.ProcessEnv,
      spawnJournal: () => ({ stdout: null, stderr: null, on: () => {}, kill: () => {} }) as never,
    });
    expect(t.args()).toContain("--priority=4");
  });
});

describe("the access probe", () => {
  test("a reader that can see kernel entries is reading the whole system journal", async () => {
    const res = await probeJournalAccess(async () => ({ code: 0, stdout: `${entry()}\n`, stderr: "" }));
    expect(res.ok).toBe(true);
  });

  test("exit 0 with NOTHING is the silent half-truth — reported as not-ok, and why", async () => {
    // This is the failure mode the probe exists for: without `systemd-journal` membership,
    // journalctl succeeds and shows only this user's entries. Nothing errors; the log is just wrong.
    const res = await probeJournalAccess(async () => ({ code: 0, stdout: "", stderr: "" }));
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("systemd-journal");
  });

  test("a missing journalctl is reported, not swallowed", async () => {
    const res = await probeJournalAccess(async () => {
      throw new Error("spawn journalctl ENOENT");
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("ENOENT");
  });
});
