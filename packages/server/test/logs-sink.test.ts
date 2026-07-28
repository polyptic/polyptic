/**
 * POL-187 — the fleet log sink.
 *
 * The properties worth pinning are the ones "why was that panel dark last night" depends on:
 *
 *   - the SERVER's clock decides the partition and the range. A box mid-cold-boot writes `at:
 *     1970`; if that decided anything, "show me last night" would silently miss the very lines the
 *     investigation is about — the single most dangerous failure this design can have, because it
 *     looks exactly like a quiet fleet;
 *   - a re-sent batch after a lost ack lands NOWHERE. That is what lets the agent's rule be as
 *     simple as "drop only on an ack";
 *   - retention enforces BOTH caps, and the size cap is PER MACHINE — a crash-looping box must not
 *     be able to evict the fleet's history;
 *   - a machine id from the wire never escapes LOG_DIR.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LogSink, clockSkewMs, renderLogText, sanitize } from "../src/logs";
import type { LogEvent } from "@polyptic/protocol";

let dir: string;

function line(over: Partial<LogEvent> = {}): LogEvent {
  return {
    source: "agent",
    level: "info",
    subsystem: "power",
    at: "2026-07-27T22:00:00.000Z",
    machineId: "box-a",
    msg: "panel slept on HDMI-1 (dpms off)",
    ...over,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "polyptic-logs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writing", () => {
  test("partitions per machine per UTC day, on the SERVER's clock", async () => {
    // The box says 1970 (a cold boot before timesyncd converged). The server says the 28th. The
    // partition — and therefore every range query — must follow the SERVER.
    const sink = new LogSink({ dir, now: () => new Date("2026-07-28T03:14:00.000Z") });
    await sink.init();
    await sink.write([line({ at: "1970-01-01T00:00:12.000Z", seq: 1 })]);

    expect(await readdir(dir)).toContain("box-a");
    expect(await readdir(join(dir, "box-a"))).toEqual(["2026-07-28.ndjson"]);
  });

  test("dedupes on (machineId, seq), so a re-sent batch after a lost ack lands nowhere", async () => {
    const sink = new LogSink({ dir });
    await sink.init();

    const batch = [line({ seq: 1 }), line({ seq: 2, msg: "second" })];
    expect(await sink.write(batch)).toBe(2);
    // The ack never reached the box, so it sends the same lines again under a fresh batch id.
    expect(await sink.write(batch)).toBe(0);

    const result = await sink.query({ since: "2000-01-01T00:00:00.000Z" });
    expect(result.lines).toHaveLength(2);
  });

  test("the same seq from a DIFFERENT machine is a different line", async () => {
    const sink = new LogSink({ dir });
    await sink.init();
    await sink.write([line({ seq: 1 })]);
    expect(await sink.write([line({ seq: 1, machineId: "box-b" })])).toBe(1);
  });

  test("stamps receivedAt and keeps the box's own clock beside it", async () => {
    const sink = new LogSink({ dir, now: () => new Date("2026-07-28T03:14:00.000Z") });
    await sink.init();
    await sink.write([line({ at: "1970-01-01T00:00:12.000Z" })]);

    const [stored] = (await sink.query({ since: "2000-01-01T00:00:00.000Z" })).lines;
    expect(stored?.receivedAt).toBe("2026-07-28T03:14:00.000Z");
    expect(stored?.at).toBe("1970-01-01T00:00:12.000Z");
    // The skew is itself a finding: a box that thinks it is 1970 fired its schedule at the wrong time.
    expect(clockSkewMs(stored!)).toBeLessThan(-1_000_000_000);
  });

  test("refuses to write when the volume is unwritable, so the box keeps its only copy", async () => {
    const sink = new LogSink({ dir: "/proc/definitely-not-writable/polyptic" });
    await sink.init();
    expect(sink.isWritable()).toBe(false);
    await expect(sink.write([line()])).rejects.toThrow();
  });
});

describe("querying", () => {
  test("ranges, filters and orders newest-first on the server clock", async () => {
    let clock = new Date("2026-07-28T01:00:00.000Z");
    const sink = new LogSink({ dir, now: () => clock });
    await sink.init();

    await sink.write([line({ seq: 1, msg: "first" })]);
    clock = new Date("2026-07-28T02:00:00.000Z");
    await sink.write([line({ seq: 2, msg: "second", level: "warn" })]);
    clock = new Date("2026-07-28T03:00:00.000Z");
    await sink.write([line({ seq: 3, msg: "third", machineId: "box-b" })]);

    const all = await sink.query({ since: "2026-07-28T00:00:00.000Z", until: "2026-07-28T04:00:00.000Z" });
    expect(all.lines.map((l) => l.msg)).toEqual(["third", "second", "first"]);

    const warnings = await sink.query({ since: "2026-07-28T00:00:00.000Z", minLevel: "warn" });
    expect(warnings.lines.map((l) => l.msg)).toEqual(["second"]);

    const oneBox = await sink.query({ since: "2026-07-28T00:00:00.000Z", machineId: "box-b" });
    expect(oneBox.lines.map((l) => l.msg)).toEqual(["third"]);

    const outside = await sink.query({
      since: "2026-07-28T02:30:00.000Z",
      until: "2026-07-28T02:45:00.000Z",
    });
    expect(outside.lines).toHaveLength(0);
  });

  test("searches the message and the fields", async () => {
    const sink = new LogSink({ dir });
    await sink.init();
    await sink.write([
      line({ seq: 1, msg: "panel woken", fields: { connector: "DP-3" } }),
      line({ seq: 2, msg: "browser spawned" }),
    ]);

    const byField = await sink.query({ since: "2000-01-01T00:00:00.000Z", search: "dp-3" });
    expect(byField.lines.map((l) => l.msg)).toEqual(["panel woken"]);
  });

  test("caps the result and says so, rather than returning a truncated list that looks complete", async () => {
    const sink = new LogSink({ dir });
    await sink.init();
    await sink.write(Array.from({ length: 40 }, (_, i) => line({ seq: i + 1, msg: `line ${i}` })));

    const result = await sink.query({ since: "2000-01-01T00:00:00.000Z", limit: 10 });
    expect(result.lines).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  test("lists every machine it holds lines for", async () => {
    const sink = new LogSink({ dir });
    await sink.init();
    await sink.write([line({ seq: 1 }), line({ seq: 2, machineId: "box-b" })]);
    // A control-plane line files under the reserved `server` partition.
    await sink.write([{ source: "server", level: "info", subsystem: "scheduler", at: new Date().toISOString(), msg: "applied a scene" }]);

    expect(await sink.listMachines()).toEqual(["box-a", "box-b", "server"]);
  });
});

describe("retention", () => {
  test("sweeps by AGE, fleet-wide", async () => {
    let clock = new Date("2026-07-01T12:00:00.000Z");
    const sink = new LogSink({ dir, now: () => clock, retention: { maxAgeHours: 48, maxBytesPerMachine: 1024 * 1024 * 1024 } });
    await sink.init();
    await sink.write([line({ seq: 1, msg: "old" })]);

    clock = new Date("2026-07-10T12:00:00.000Z");
    await sink.write([line({ seq: 2, msg: "fresh" })]);

    const swept = await sink.sweep();
    expect(swept.removed).toBe(1);
    expect(await readdir(join(dir, "box-a"))).toEqual(["2026-07-10.ndjson"]);
  });

  test("sweeps by SIZE per machine — a crash-looping box evicts only its own history", async () => {
    let clock = new Date("2026-07-01T00:00:00.000Z");
    const sink = new LogSink({
      dir,
      now: () => clock,
      // Small enough that a couple of days of the chatty box's lines blow it.
      retention: { maxAgeHours: 24 * 365, maxBytesPerMachine: 1024 * 1024 },
    });
    await sink.init();

    // A quiet box, one line, several days ago.
    await sink.write([line({ seq: 1, machineId: "quiet", msg: "hello" })]);

    // A chatty box, three days of ~600KB each.
    const fat = "x".repeat(900);
    for (const day of ["2026-07-02", "2026-07-03", "2026-07-04"]) {
      clock = new Date(`${day}T00:00:00.000Z`);
      await sink.write(
        Array.from({ length: 700 }, (_, i) => line({ machineId: "chatty", seq: Number(day.slice(-2)) * 1000 + i, msg: fat })),
      );
    }

    await sink.sweep();

    // The chatty box lost its OLDEST days, and kept its newest.
    const chatty = await readdir(join(dir, "chatty"));
    expect(chatty).toContain("2026-07-04.ndjson");
    expect(chatty.length).toBeLessThan(3);
    // The quiet box is untouched — that is the whole point of a PER-MACHINE cap.
    expect(await readdir(join(dir, "quiet"))).toEqual(["2026-07-01.ndjson"]);
  });

  test("persists the two numbers beside the data, so they travel with the volume", async () => {
    const first = new LogSink({ dir });
    await first.init();
    await first.setRetention({ maxAgeHours: 12, maxBytesPerMachine: 5 * 1024 * 1024 });

    const second = new LogSink({ dir });
    await second.init();
    expect(second.currentRetention).toEqual({ maxAgeHours: 12, maxBytesPerMachine: 5 * 1024 * 1024 });
  });

  test("reports what the volume holds, for the Settings card", async () => {
    const sink = new LogSink({ dir, now: () => new Date("2026-07-28T03:00:00.000Z") });
    await sink.init();
    await sink.write([line({ seq: 1 })]);

    const info = await sink.info();
    expect(info.writable).toBe(true);
    expect(info.machines).toBe(1);
    expect(info.oldestDay).toBe("2026-07-28");
    expect(info.bytes).toBeGreaterThan(0);
  });
});

describe("safety", () => {
  test("a machine id from the wire never escapes LOG_DIR", async () => {
    const sink = new LogSink({ dir });
    await sink.init();
    await sink.write([line({ machineId: "../../etc/passwd", seq: 1 })]);

    // It landed in a sanitized directory INSIDE the log dir, not two levels up.
    const dirs = await readdir(dir, { withFileTypes: true });
    const machineDirs = dirs.filter((d) => d.isDirectory()).map((d) => d.name);
    expect(machineDirs).toHaveLength(1);
    expect(machineDirs[0]).not.toContain("/");
    expect(machineDirs[0]).not.toContain("..");
    await expect(stat(join(dir, machineDirs[0]!))).resolves.toBeDefined();
  });

  test("sanitize never returns an empty or dot-leading token", () => {
    expect(sanitize("")).toBe("unknown");
    expect(sanitize("...")).toBe("unknown");
    expect(sanitize("a/b:c")).toBe("a-b-c");
  });

  test("a half-written last line does not poison the partition", async () => {
    const sink = new LogSink({ dir, now: () => new Date("2026-07-28T03:00:00.000Z") });
    await sink.init();
    await sink.write([line({ seq: 1, msg: "good" })]);
    // A hard kill mid-append leaves a truncated record behind.
    await writeFile(join(dir, "box-a", "2026-07-28.ndjson"), '{"source":"agent","level"\n', { flag: "a" });

    const result = await sink.query({ since: "2000-01-01T00:00:00.000Z" });
    expect(result.lines.map((l) => l.msg)).toEqual(["good"]);
  });
});

describe("export", () => {
  test("renders oldest-first, flags a wrong box clock, and reads like an account", async () => {
    const text = renderLogText([
      {
        source: "agent",
        level: "warn",
        subsystem: "power",
        at: "1970-01-01T00:00:05.000Z",
        receivedAt: "2026-07-28T03:00:00.000Z",
        machineId: "box-a",
        screenId: "screen-1",
        msg: "panel would not sleep",
        fields: { connector: "HDMI-1" },
      },
      {
        source: "server",
        level: "info",
        subsystem: "scheduler",
        at: "2026-07-28T02:00:00.000Z",
        receivedAt: "2026-07-28T02:00:00.000Z",
        msg: "applied a scene",
      },
    ]);

    const rows = text.split("\n");
    expect(rows[0]).toContain("applied a scene"); // oldest first — a story reads forwards
    expect(rows[1]).toContain("WARN");
    expect(rows[1]).toContain("connector=HDMI-1");
    expect(rows[1]).toContain("box clock 1970-01-01T00:00:05.000Z");
  });
});
