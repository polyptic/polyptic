/**
 * POL-92 — the agent's host-vitals sampler, against a FIXTURE /proc tree on disk.
 *
 * The sampler is the one part of this feature that reads the real world, so it is pinned hard:
 *
 *   - the parsers (CPU jiffies, meminfo, loadavg, uptime, statm, thermal, and the `/proc/<pid>/stat`
 *     comm field that MAY CONTAIN SPACES AND PARENTHESES — the classic way to misparse a ppid);
 *   - CPU busy % is a DELTA, so the first sample carries none and the second one does;
 *   - THE D77 TELL: `gpuAccel` is true only when something in the browser's process TREE holds an fd
 *     on /dev/dri (Chrome opens it in its GPU process — a CHILD), false when nothing in the tree
 *     does, and ABSENT when we cannot tell. Reporting "unknown" as "software rendering" would page
 *     an operator about a healthy wall;
 *   - a host with no /proc (macOS, where this test suite also runs) samples NOTHING — the heartbeat
 *     then goes out with no `vitals` at all, exactly like a pre-POL-92 agent's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectTree,
  cpuPercentBetween,
  parseLoadavg,
  parseMeminfo,
  parsePpid,
  parseProcStat,
  parseStatmRss,
  parseThermal,
  parseUptime,
  VitalsSampler,
} from "../src/vitals";
import type { BrowserProbe } from "../src/vitals";

// ── a fixture /proc + /sys ───────────────────────────────────────────────────

let root: string;
let procRoot: string;
let sysRoot: string;

/** Write one process into the fixture tree. `driFds` are the fd symlinks it holds. */
async function writeProc(
  pid: number,
  opts: { ppid: number; comm?: string; rssPages?: number; fds?: string[] },
): Promise<void> {
  const dir = join(procRoot, String(pid));
  await mkdir(dir, { recursive: true });
  const comm = opts.comm ?? "chrome";
  // The real format: pid (comm) state ppid pgrp … — comm is parenthesised and may contain anything.
  await writeFile(join(dir, "stat"), `${pid} (${comm}) S ${opts.ppid} 1 1 0 -1 4194560 100 0 0 0\n`);
  await writeFile(join(dir, "statm"), `200000 ${opts.rssPages ?? 1000} 500 1 0 100 0\n`);
  if (opts.fds) {
    const fdDir = join(dir, "fd");
    await mkdir(fdDir, { recursive: true });
    let n = 0;
    for (const target of opts.fds) {
      // Dangling symlinks are fine — readlink reads the link, not the target (and /dev/dri does not
      // exist on the machine running this test, which is the point).
      await symlink(target, join(fdDir, String(n++)));
    }
  }
}

async function writeCpu(user: number, idle: number): Promise<void> {
  await writeFile(procRoot + "/stat", `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 2 3 4\n`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "polyptic-vitals-"));
  procRoot = join(root, "proc");
  sysRoot = join(root, "sys");
  await mkdir(procRoot, { recursive: true });
  await mkdir(join(sysRoot, "class", "thermal", "thermal_zone0"), { recursive: true });
  await writeCpu(1000, 9000);
  await writeFile(join(procRoot, "meminfo"), "MemTotal:       8000000 kB\nMemAvailable:   2000000 kB\nMemFree: 100 kB\n");
  await writeFile(join(procRoot, "loadavg"), "1.25 0.90 0.70 2/415 9999\n");
  await writeFile(join(procRoot, "uptime"), "86400.42 400000.00\n");
  await writeFile(join(sysRoot, "class", "thermal", "thermal_zone0", "temp"), "61200\n");
  await writeFile(join(root, "image-id"), "20260714T101500Z-abcd\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function sampler(): VitalsSampler {
  return new VitalsSampler({
    procRoot,
    sysRoot,
    imageIdPath: join(root, "image-id"),
    // Points at a path that does NOT exist by default, so the general tests see clockSynced omitted
    // (no time client to ask); the dedicated tests below create the fixture dir/file.
    timesyncRunDir: join(root, "timesync"),
    // POL-176 — absent by default (a live box); the staged-image tests below create it.
    updateStatePath: join(root, "update-state"),
    statfs: () => ({ totalBytes: 100 * 1024 ** 3, usedBytes: 22 * 1024 ** 3 }),
    coreCount: () => 4,
  });
}

// ── parsers ──────────────────────────────────────────────────────────────────

describe("parsers", () => {
  test("parseProcStat sums the jiffy columns and folds iowait into idle", () => {
    expect(parseProcStat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 1 1 1\n")).toEqual({
      total: 1000,
      idle: 850,
    });
    expect(parseProcStat("nothing here")).toBeNull();
  });

  test("cpuPercentBetween is a delta; a stalled clock yields null, not a fake zero", () => {
    // 1000 → 2000 jiffies elapsed, 200 of them idle ⇒ 80% busy.
    expect(cpuPercentBetween({ total: 1000, idle: 800 }, { total: 2000, idle: 1000 })).toBe(80);
    expect(cpuPercentBetween({ total: 1000, idle: 800 }, { total: 1000, idle: 800 })).toBeNull();
  });

  test("parseMeminfo uses MemAvailable (not MemFree) for what is actually in use", () => {
    const mem = parseMeminfo("MemTotal:       8000000 kB\nMemFree:          10000 kB\nMemAvailable:   2000000 kB\n");
    expect(mem?.totalBytes).toBe(8_000_000 * 1024);
    expect(mem?.usedBytes).toBe(6_000_000 * 1024);
    expect(mem?.percent).toBe(75);
  });

  test("parseLoadavg / parseUptime", () => {
    expect(parseLoadavg("1.25 0.90 0.70 2/415 9999")).toEqual([1.25, 0.9, 0.7]);
    expect(parseUptime("86400.42 400000.00")).toBe(86400);
  });

  test("parsePpid survives a comm with spaces and parentheses", () => {
    expect(parsePpid("42 (chrome) S 7 42 42 0 -1 4194560")).toBe(7);
    expect(parsePpid("42 (Web Content) S 7 42 42 0 -1")).toBe(7);
    expect(parsePpid("42 (chrome (dev)) S 99 42 42 0")).toBe(99);
  });

  test("parseStatmRss converts resident pages to bytes; parseThermal rejects nonsense", () => {
    expect(parseStatmRss("200000 512 100 1 0 100 0")).toBe(512 * 4096);
    expect(parseThermal("61200\n")).toBe(61.2);
    expect(parseThermal("0")).toBeNull(); // an unpopulated zone reads 0 — that is not 0°C
    expect(parseThermal("garbage")).toBeNull();
  });

  test("collectTree walks children and survives a cycle", () => {
    const kids = new Map<number, number[]>([
      [10, [11, 12]],
      [11, [13]],
      [13, [10]], // a reparent race could produce this; it must not hang
    ]);
    expect(collectTree(kids, 10).sort()).toEqual([10, 11, 12, 13]);
  });
});

// ── the sampler ──────────────────────────────────────────────────────────────

describe("VitalsSampler", () => {
  test("a host with no /proc samples nothing at all (the pre-POL-92 wire shape)", async () => {
    const none = new VitalsSampler({ procRoot: join(root, "no-such-proc") });
    expect(await none.available()).toBe(false);
    expect(await none.sample([])).toBeUndefined();
  });

  test("reads the host's health; CPU% only arrives on the SECOND sample (it is a delta)", async () => {
    const s = sampler();
    const first = await s.sample([]);
    expect(first).toBeDefined();
    expect(first?.cpuPercent).toBeUndefined(); // no previous totals to diff against — say nothing
    expect(first?.cores).toBe(4);
    expect(first?.memPercent).toBe(75);
    expect(first?.memTotalBytes).toBe(8_000_000 * 1024);
    expect(first?.loadavg).toEqual([1.25, 0.9, 0.7]);
    expect(first?.uptimeSec).toBe(86400);
    expect(first?.tempC).toBe(61.2);
    expect(first?.diskPercent).toBe(22);
    expect(first?.imageId).toBe("20260714T101500Z-abcd");
    expect(typeof first?.at).toBe("string");

    // 1000 more busy jiffies, 1000 more idle ⇒ 50%.
    await writeCpu(2000, 10000);
    const second = await s.sample([]);
    expect(second?.cpuPercent).toBe(50);
  });

  test("the hottest thermal zone wins", async () => {
    await mkdir(join(sysRoot, "class", "thermal", "thermal_zone1"), { recursive: true });
    await writeFile(join(sysRoot, "class", "thermal", "thermal_zone1", "temp"), "78500\n");
    expect((await sampler().sample([]))?.tempC).toBe(78.5);
  });

  test("GPU TELL: a DRI fd held by a CHILD (Chrome's GPU process) means hardware rendering", async () => {
    // browser (pid 100) → zygote (200) → gpu process (300), which is the one holding /dev/dri.
    await writeProc(100, { ppid: 1, comm: "chrome", rssPages: 1000 });
    await writeProc(200, { ppid: 100, comm: "chrome (zygote)", rssPages: 500, fds: ["/dev/urandom"] });
    await writeProc(300, { ppid: 200, comm: "chrome", rssPages: 250, fds: ["/dev/dri/renderD128"] });

    const probes: BrowserProbe[] = [{ connector: "DP-1", running: true, pid: 100, respawns: 2 }];
    const v = await sampler().sample(probes);
    const browser = v?.browsers?.[0];
    expect(browser?.connector).toBe("DP-1");
    expect(browser?.gpuAccel).toBe(true);
    expect(browser?.respawns).toBe(2);
    // RSS is summed across the tree (1000 + 500 + 250 pages).
    expect(browser?.rssBytes).toBe(1750 * 4096);
  });

  test("GPU TELL: no DRI fd anywhere in the tree = SOFTWARE rendering (the D77 wall-cooker)", async () => {
    await writeProc(100, { ppid: 1, comm: "surf", rssPages: 900, fds: ["/dev/urandom"] });
    await writeProc(101, { ppid: 100, comm: "WebKitWebProcess", rssPages: 4000, fds: ["socket:[1234]"] });

    const v = await sampler().sample([{ connector: "HDMI-1", running: true, pid: 100, respawns: 0 }]);
    expect(v?.browsers?.[0]?.gpuAccel).toBe(false);
  });

  test("a DRI fd held by an UNRELATED process (sway) does not launder the browser's verdict", async () => {
    await writeProc(50, { ppid: 1, comm: "sway", fds: ["/dev/dri/card1"] }); // the compositor: fine
    await writeProc(100, { ppid: 1, comm: "surf", fds: ["/dev/urandom"] }); // the browser: not fine
    const v = await sampler().sample([{ connector: "HDMI-1", running: true, pid: 100, respawns: 0 }]);
    expect(v?.browsers?.[0]?.gpuAccel).toBe(false);
  });

  test("a browser that is NOT running reports no verdict at all — unknown is not 'broken'", async () => {
    const v = await sampler().sample([{ connector: "DP-2", running: false, pid: null, respawns: 7 }]);
    const browser = v?.browsers?.[0];
    expect(browser?.running).toBe(false);
    expect(browser?.gpuAccel).toBeUndefined();
    expect(browser?.rssBytes).toBeUndefined();
    expect(browser?.respawns).toBe(7); // the respawn count still matters: it is why it's down
  });

  // ── POL-148: the clock-sync tell ────────────────────────────────────────────
  // Three states, from systemd-timesyncd's runtime dir: no dir = no client to ask (OMIT); dir but no
  // `synchronized` stamp = running, not yet synced (false); stamp present = synced (true). An absent
  // flag must never be drawn as "not synced" — only a definite false is.
  test("clockSynced is OMITTED when there is no timesyncd runtime dir (no time client)", async () => {
    const v = await sampler().sample([]);
    expect(v?.clockSynced).toBeUndefined();
  });

  test("clockSynced is false when timesyncd is running but has not synced yet", async () => {
    await mkdir(join(root, "timesync"), { recursive: true });
    const v = await sampler().sample([]);
    expect(v?.clockSynced).toBe(false);
  });

  test("clockSynced is true once the synchronized stamp exists", async () => {
    await mkdir(join(root, "timesync"), { recursive: true });
    await writeFile(join(root, "timesync", "synchronized"), "");
    const v = await sampler().sample([]);
    expect(v?.clockSynced).toBe(true);
  });

  // POL-176 — the staged (inactive-slot) image id rides every sample on an installed box, RE-READ
  // each heartbeat (staging happens at runtime, unlike the immutable booted id). Absent file =
  // absent field: a live box's heartbeat is byte-for-byte what it was before POL-176.
  test("stagedImageId is OMITTED when there is no update-state file (a live box)", async () => {
    const v = await sampler().sample([]);
    expect(v?.stagedImageId).toBeUndefined();
  });

  test("stagedImageId reports the staged= line verbatim — even when it equals running", async () => {
    await writeFile(join(root, "update-state"), "running=20260714T101500Z-abcd\nstaged=20260714T101500Z-abcd\n");
    const v = await sampler().sample([]);
    expect(v?.stagedImageId).toBe("20260714T101500Z-abcd");
  });

  test("a NEWLY staged id shows up on the next sample, not the next process", async () => {
    const s = sampler();
    expect((await s.sample([]))?.stagedImageId).toBeUndefined();
    await writeFile(join(root, "update-state"), "running=A\nstaged=B\n");
    expect((await s.sample([]))?.stagedImageId).toBe("B");
  });
});
