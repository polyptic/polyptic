/**
 * vitals — what the box knows about ITSELF, sampled cheaply from /proc + /sys on every heartbeat
 * (POL-92).
 *
 * The fleet's known failure modes are physical and, until now, invisible from the console: a browser
 * that lost its GPU path software-renders the wall and pegs the CPU (D77 — surf under Xwayland could
 * not get DRI3, so `WebKitWebProcess` sat at 300%), a wedged page eats the RAM, a crash loop churns
 * the screen. Finding any of them meant arming a remote shell and running `top` by hand.
 *
 * Design constraints, in order:
 *   1. CHEAP. This runs on a modest kiosk box every 10s. We read a handful of /proc files and walk
 *      the browser's process tree — no `top`, no `ps`, no shelling out at all.
 *   2. UNPRIVILEGED. Everything here is readable by the kiosk user that owns the browsers. Nothing
 *      is read from another user's process, and a permission error is simply an absent field.
 *   3. HONEST. Every field is optional and an unknown is OMITTED, never zeroed — a zero on a meter
 *      is a claim, and "we couldn't tell" is not the same claim as "it's idle".
 *
 * THE GPU TELL (the valuable bit). A browser doing hardware rendering holds an open fd on a DRI
 * device node: `/proc/<pid>/fd/*` → `/dev/dri/renderD128` (or `cardN`). Chrome opens it in its GPU
 * process, a CHILD of the process the agent spawned, so we walk the tree. No fd anywhere in the tree
 * = the box is painting the wall on the CPU. That single boolean is what D77 cost a field debugging
 * session to learn.
 *
 * Non-Linux (a dev laptop running `dev-open`) has no /proc: `sample()` returns `undefined` and the
 * heartbeat simply carries no vitals — the same wire shape an old agent sends.
 */
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";

import type { BrowserVitals, MachineVitals } from "@polyptic/protocol";

import { UPDATE_STATE_PATH, readStagedImageId } from "./install";

/** What one supervised browser looks like to the sampler (see SupervisedBrowser). */
export interface BrowserProbe {
  connector: string;
  running: boolean;
  pid: number | null;
  respawns: number;
}

export interface VitalsSamplerOptions {
  /** Root of the proc filesystem. Overridden by tests with a fixture tree. */
  procRoot?: string;
  /** Root of the sys filesystem (thermal zones). */
  sysRoot?: string;
  /** Where the live image stamps the id it booted (`build-live-image.sh`). */
  imageIdPath?: string;
  /** POL-176 — where the root update poll records running vs staged image ids on an installed box.
   *  Re-read EVERY sample (unlike the immutable booted id): staging happens at runtime, and the
   *  "update ready — reboot to apply" badge should appear the heartbeat after the download lands. */
  updateStatePath?: string;
  /** POL-148 — systemd-timesyncd's runtime directory. It exists whenever timesyncd has run this
   *  boot (RuntimeDirectory=systemd/timesync), and gains a `synchronized` file on first sync. We use
   *  the pair to distinguish "no time client to ask" (dir absent → omit) from "running, not yet
   *  synced" (dir present, file absent → false). Overridden by tests with a fixture tree. */
  timesyncRunDir?: string;
  /** The filesystem whose usage we report (the netbooted box's RAM-backed root). */
  rootPath?: string;
  /** Injectable so a test can assert the mapping without depending on the host's real disk. */
  statfs?: (path: string) => { totalBytes: number; usedBytes: number } | null;
  /** Injectable core count (defaults to os.cpus().length). */
  coreCount?: () => number;
}

/** Linux page size we convert `statm` pages with. 4 KiB on every arch we ship (amd64, Ubuntu arm64). */
const PAGE_BYTES = 4096;
/** A thermal reading outside this band is a sensor artefact, not a temperature. */
const TEMP_MIN_C = 1;
const TEMP_MAX_C = 150;

// ─────────────────────────────────────────────────────────────────────────────
// Parsers (pure — the unit-tested surface)
// ─────────────────────────────────────────────────────────────────────────────

export interface CpuTotals {
  /** Sum of every jiffy column. */
  total: number;
  /** Jiffies the CPU spent doing nothing (idle + iowait). */
  idle: number;
}

/** Parse the aggregate `cpu` line of /proc/stat into busy/idle jiffy totals. */
export function parseProcStat(text: string): CpuTotals | null {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const cols = line
    .slice(4)
    .trim()
    .split(/\s+/)
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isFinite(n));
  if (cols.length < 5) return null;
  const total = cols.reduce((a, b) => a + b, 0);
  // user nice system idle iowait irq softirq steal …  → idle = idle + iowait
  const idle = (cols[3] ?? 0) + (cols[4] ?? 0);
  return { total, idle };
}

/**
 * Busy % between two /proc/stat samples. `null` when the totals didn't advance (same jiffy — a
 * heartbeat that fired twice inside one tick) rather than pretending the box was idle.
 */
export function cpuPercentBetween(prev: CpuTotals, next: CpuTotals): number | null {
  const totalDelta = next.total - prev.total;
  const idleDelta = next.idle - prev.idle;
  if (totalDelta <= 0) return null;
  const busy = ((totalDelta - idleDelta) / totalDelta) * 100;
  return clampPercent(busy);
}

export interface MemInfo {
  totalBytes: number;
  usedBytes: number;
  percent: number;
}

/** Parse /proc/meminfo. "Used" is total − MemAvailable — what the kernel says is actually reclaimable,
 *  not the free-memory-is-wasted-memory number that makes every Linux box look full. */
export function parseMeminfo(text: string): MemInfo | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text);
    return m?.[1] ? Number.parseInt(m[1], 10) : null;
  };
  const total = kb("MemTotal");
  if (total === null || total <= 0) return null;
  const available = kb("MemAvailable") ?? kb("MemFree");
  if (available === null) return null;
  const totalBytes = total * 1024;
  const usedBytes = Math.max(0, (total - available) * 1024);
  return { totalBytes, usedBytes, percent: clampPercent((usedBytes / totalBytes) * 100) };
}

/** The three load averages from /proc/loadavg. */
export function parseLoadavg(text: string): [number, number, number] | null {
  const parts = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0] as number, parts[1] as number, parts[2] as number];
}

/** Seconds of uptime from /proc/uptime. */
export function parseUptime(text: string): number | null {
  const first = Number.parseFloat(text.trim().split(/\s+/)[0] ?? "");
  return Number.isFinite(first) ? Math.round(first) : null;
}

/**
 * Parent pid from a /proc/<pid>/stat line. The comm field is parenthesised and MAY CONTAIN SPACES
 * AND PARENTHESES (`(Web Content)`, `(chrome (dev))`), so the fields are counted from the LAST `)`.
 */
export function parsePpid(statLine: string): number | null {
  const close = statLine.lastIndexOf(")");
  if (close < 0) return null;
  const rest = statLine.slice(close + 1).trim().split(/\s+/);
  // rest[0] = state, rest[1] = ppid
  const ppid = Number.parseInt(rest[1] ?? "", 10);
  return Number.isInteger(ppid) ? ppid : null;
}

/** Resident bytes from a /proc/<pid>/statm line (field 2 = resident pages). */
export function parseStatmRss(statm: string): number | null {
  const pages = Number.parseInt(statm.trim().split(/\s+/)[1] ?? "", 10);
  return Number.isInteger(pages) ? pages * PAGE_BYTES : null;
}

/** Milli-degrees (the /sys thermal zone unit) → °C, or null when the reading is nonsense. */
export function parseThermal(text: string): number | null {
  const milli = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(milli)) return null;
  const c = Math.round((milli / 1000) * 10) / 10;
  return c >= TEMP_MIN_C && c <= TEMP_MAX_C ? c : null;
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

// ─────────────────────────────────────────────────────────────────────────────
// The sampler
// ─────────────────────────────────────────────────────────────────────────────

/** Read a file, or `null` on any error (missing, permission, torn read of a dying process). */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function defaultStatfs(path: string): { totalBytes: number; usedBytes: number } | null {
  try {
    const fs = statfsSync(path);
    const total = Number(fs.blocks) * Number(fs.bsize);
    // Used = total − what an UNPRIVILEGED process may still write (bavail), which is what actually
    // constrains the kiosk user; `bfree` would hide the root reserve.
    const used = total - Number(fs.bavail) * Number(fs.bsize);
    if (!Number.isFinite(total) || total <= 0) return null;
    return { totalBytes: total, usedBytes: Math.max(0, used) };
  } catch {
    return null;
  }
}

export class VitalsSampler {
  private readonly procRoot: string;
  private readonly sysRoot: string;
  private readonly imageIdPath: string;
  private readonly updateStatePath: string;
  private readonly timesyncRunDir: string;
  private readonly rootPath: string;
  private readonly statfs: (path: string) => { totalBytes: number; usedBytes: number } | null;
  private readonly coreCount: () => number;

  /** Previous /proc/stat totals — CPU busy % is a DELTA, so the first sample has no percentage. */
  private prevCpu: CpuTotals | null = null;
  /** Read once (an image cannot change under a running agent) and remembered. */
  private imageId: string | null | undefined;

  constructor(opts: VitalsSamplerOptions = {}) {
    this.procRoot = opts.procRoot ?? "/proc";
    this.sysRoot = opts.sysRoot ?? "/sys";
    this.imageIdPath = opts.imageIdPath ?? "/etc/polyptic/image-id";
    this.updateStatePath = opts.updateStatePath ?? UPDATE_STATE_PATH;
    this.timesyncRunDir = opts.timesyncRunDir ?? "/run/systemd/timesync";
    this.rootPath = opts.rootPath ?? "/";
    this.statfs = opts.statfs ?? defaultStatfs;
    this.coreCount = opts.coreCount ?? (() => cpus().length);
  }

  /** Is there a /proc to read at all? (false on macOS/dev, where we simply send no vitals.) */
  async available(): Promise<boolean> {
    try {
      const st = await stat(join(this.procRoot, "stat"));
      return st.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Take one sample. Returns `undefined` when this host exposes nothing we can read (no /proc), so
   * the caller omits `vitals` entirely rather than sending a hollow object. Never throws.
   */
  async sample(browsers: readonly BrowserProbe[] = []): Promise<MachineVitals | undefined> {
    const statText = await readOrNull(join(this.procRoot, "stat"));
    if (statText === null) return undefined;

    const vitals: MachineVitals = { at: new Date().toISOString() };

    // CPU — a delta against the previous heartbeat's totals.
    const totals = parseProcStat(statText);
    if (totals) {
      if (this.prevCpu) {
        const pct = cpuPercentBetween(this.prevCpu, totals);
        if (pct !== null) vitals.cpuPercent = pct;
      }
      this.prevCpu = totals;
    }
    const cores = this.coreCount();
    if (cores > 0) vitals.cores = cores;

    const memText = await readOrNull(join(this.procRoot, "meminfo"));
    const mem = memText ? parseMeminfo(memText) : null;
    if (mem) {
      vitals.memTotalBytes = mem.totalBytes;
      vitals.memUsedBytes = mem.usedBytes;
      vitals.memPercent = mem.percent;
    }

    const loadText = await readOrNull(join(this.procRoot, "loadavg"));
    const load = loadText ? parseLoadavg(loadText) : null;
    if (load) vitals.loadavg = load;

    const uptimeText = await readOrNull(join(this.procRoot, "uptime"));
    const uptime = uptimeText ? parseUptime(uptimeText) : null;
    if (uptime !== null) vitals.uptimeSec = uptime;

    const disk = this.statfs(this.rootPath);
    if (disk && disk.totalBytes > 0) {
      vitals.diskTotalBytes = disk.totalBytes;
      vitals.diskUsedBytes = disk.usedBytes;
      vitals.diskPercent = clampPercent((disk.usedBytes / disk.totalBytes) * 100);
    }

    const temp = await this.hottestZone();
    if (temp !== null) vitals.tempC = temp;

    const imageId = await this.readImageId();
    if (imageId) vitals.imageId = imageId;

    // POL-176 — the staged (inactive-slot) image id, reported verbatim beside the running one so
    // the console can wear "update ready — reboot to apply". Absent file → absent field.
    const staged = await readStagedImageId(this.updateStatePath);
    if (staged !== undefined) vitals.stagedImageId = staged;

    const clockSynced = await this.clockSynced();
    if (clockSynced !== undefined) vitals.clockSynced = clockSynced;

    if (browsers.length > 0) vitals.browsers = await this.sampleBrowsers(browsers);

    return vitals;
  }

  /** The hottest /sys thermal zone in °C, or null when the host exposes none (most VMs). */
  private async hottestZone(): Promise<number | null> {
    const dir = join(this.sysRoot, "class", "thermal");
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return null;
    }
    let hottest: number | null = null;
    for (const entry of entries) {
      if (!entry.startsWith("thermal_zone")) continue;
      const text = await readOrNull(join(dir, entry, "temp"));
      if (text === null) continue;
      const c = parseThermal(text);
      if (c !== null && (hottest === null || c > hottest)) hottest = c;
    }
    return hottest;
  }

  /**
   * POL-148 — is the box's clock synchronised to a time source? `true` when
   * systemd-timesyncd has stamped `<runDir>/synchronized`, `false` when timesyncd is running this
   * boot (its RuntimeDirectory exists) but has NOT synced yet, and `undefined` when there is no time
   * client to ask at all (the dir is absent) — a pre-POL-148 image, or a non-Linux dev host. The
   * distinction matters: an absent flag must never be drawn as "not synced", only a definite `false`.
   */
  private async clockSynced(): Promise<boolean | undefined> {
    let dir;
    try {
      dir = await stat(this.timesyncRunDir);
    } catch {
      return undefined; // no timesyncd this boot — nothing to claim
    }
    if (!dir.isDirectory()) return undefined;
    try {
      await stat(join(this.timesyncRunDir, "synchronized"));
      return true;
    } catch {
      return false; // running, but the clock has not been disciplined yet
    }
  }

  /**
   * POL-105 — the image id this box BOOTED, for `agent/hello`. Same cached read the heartbeat's
   * vitals use (an immutable live image cannot change its id without a reboot, and a reboot is a new
   * process), exposed so the very first frame of a session already carries it: an operator watching
   * a canary reboot should see the new id the moment the box is back, not one heartbeat later.
   */
  async bootedImageId(): Promise<string | undefined> {
    return (await this.readImageId()) ?? undefined;
  }

  /** The image id this box booted, read once. `null` on a box that isn't running a live image. */
  private async readImageId(): Promise<string | null> {
    if (this.imageId !== undefined) return this.imageId;
    const text = await readOrNull(this.imageIdPath);
    this.imageId = text?.trim() || null;
    return this.imageId;
  }

  /** Per-output browser health: RSS across the process tree, respawn count, and the GPU tell. */
  private async sampleBrowsers(probes: readonly BrowserProbe[]): Promise<BrowserVitals[]> {
    // ONE pass over /proc builds the parent→children map every probe then walks. A kiosk box runs a
    // couple of hundred processes, so this is a couple of hundred tiny reads — far cheaper than
    // spawning `ps` once, let alone once per browser.
    const children = await this.readChildMap();
    const out: BrowserVitals[] = [];
    for (const probe of probes) {
      const entry: BrowserVitals = { connector: probe.connector, running: probe.running };
      entry.respawns = probe.respawns;
      if (probe.pid !== null && probe.running) {
        entry.pid = probe.pid;
        const tree = collectTree(children, probe.pid);
        const rss = await this.treeRss(tree);
        if (rss !== null) entry.rssBytes = rss;
        entry.gpuAccel = await this.treeHoldsDri(tree);
      }
      out.push(entry);
    }
    return out;
  }

  /** pid → its children, from every /proc/<pid>/stat we can read. */
  private async readChildMap(): Promise<Map<number, number[]>> {
    const map = new Map<number, number[]>();
    let entries: string[];
    try {
      entries = await readdir(this.procRoot);
    } catch {
      return map;
    }
    for (const entry of entries) {
      const pid = Number.parseInt(entry, 10);
      if (!Number.isInteger(pid) || String(pid) !== entry) continue;
      const text = await readOrNull(join(this.procRoot, entry, "stat"));
      if (text === null) continue; // the process exited between readdir and read — fine
      const ppid = parsePpid(text);
      if (ppid === null) continue;
      const siblings = map.get(ppid);
      if (siblings) siblings.push(pid);
      else map.set(ppid, [pid]);
    }
    return map;
  }

  /** Summed resident bytes of a process tree. Shared pages (Chrome shares a LOT between its
   *  renderers) are counted in each process that maps them, so this is an upper bound — good enough
   *  to spot a browser eating the box, and never presented as an exact figure. */
  private async treeRss(pids: readonly number[]): Promise<number | null> {
    let total = 0;
    let any = false;
    for (const pid of pids) {
      const statm = await readOrNull(join(this.procRoot, String(pid), "statm"));
      if (statm === null) continue;
      const rss = parseStatmRss(statm);
      if (rss === null) continue;
      total += rss;
      any = true;
    }
    return any ? total : null;
  }

  /**
   * THE D77 TELL: does anything in this browser's process tree hold an open fd on a DRI device?
   * Chrome opens `/dev/dri/renderD128` in its GPU process (a child), sway holds `/dev/dri/cardN` in
   * its own. A tree with no DRI fd at all is rendering the wall in SOFTWARE.
   *
   * Short-circuits on the first hit, so a healthy box does a handful of readlinks. An unreadable
   * /proc/<pid>/fd (the process is another user's, or exited mid-walk) is skipped, not failed.
   */
  private async treeHoldsDri(pids: readonly number[]): Promise<boolean> {
    for (const pid of pids) {
      const fdDir = join(this.procRoot, String(pid), "fd");
      let fds: string[];
      try {
        fds = await readdir(fdDir);
      } catch {
        continue;
      }
      for (const fd of fds) {
        let target: string;
        try {
          target = await readlink(join(fdDir, fd));
        } catch {
          continue;
        }
        if (target.startsWith("/dev/dri/")) return true;
      }
    }
    return false;
  }
}

/** BFS a parent→children map from `root` (inclusive). Cycle-safe (a /proc read can race a reparent). */
export function collectTree(children: Map<number, number[]>, root: number): number[] {
  const seen = new Set<number>([root]);
  const queue = [root];
  const out: number[] = [];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    out.push(pid);
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return out;
}
