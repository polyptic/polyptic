/**
 * Image updates (POL-41): the control plane's half of "a baked image that still gets security fixes".
 *
 * Two jobs:
 *   1. SCHEDULED REBUILDS — at an operator-chosen server-local time (default 01:00) run the
 *      configured rebuild hook (`IMAGE_REBUILD_CMD`, e.g. `deploy/rebuild-image-docker.sh arm64`,
 *      which apt-upgrades the existing image inside a privileged Linux container and stamps a new
 *      image id — or exits WITHOUT touching artifacts when there is nothing to upgrade). The hook
 *      is a command by contract: the server never assumes it can chroot/mount anything itself
 *      (it may be running on a laptop or in an unprivileged container).
 *   2. PUBLISH THE MANIFEST — per-arch `{imageId, builtAt, sha256, urgent}` read from the image
 *      depot (`image-id.txt` + `SHA256SUMS`, both written by the build/refresh scripts) plus the
 *      operator's URGENT switch. Served ungated at /dist/image/<arch>/manifest.json; every
 *      netbooted box compares it against its own /etc/polyptic/image-id every 5 minutes and
 *      reboots per policy (urgent → now, else the nightly window). A reboot IS the re-pull.
 *
 * The kernel stays pinned (D47): this pipeline rolls userspace fixes; a kernel bump is a full
 * rebuild from a newer base ISO (documented in NETBOOT.md).
 */
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyBaseLogger } from "fastify";

import type { PersistedImageRollout, Store } from "./store/types";

/** The hook runs from the REPO ROOT (…/packages/server/src → repo), so `deploy/…` paths in
 *  IMAGE_REBUILD_CMD work regardless of the server process's own cwd (the dev stack runs from
 *  packages/server; found live when the first hook run failed with "No such file or directory"). */
const HOOK_CWD = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const ARCHES = ["arm64", "amd64"] as const;
type Arch = (typeof ARCHES)[number];

/** Defaults applied until the operator first touches the settings. */
export const IMAGE_ROLLOUT_DEFAULTS: PersistedImageRollout = {
  scheduleEnabled: true,
  scheduleTime: "01:00",
  // Weekly FULL rebuild (POL-43): Sundays 02:00 by default — an hour after the daily refresh slot
  // so a both-scheduled Sunday cannot contend (the refresh finishes in ~2 min).
  fullScheduleEnabled: true,
  fullScheduleDay: 0,
  fullScheduleTime: "02:00",
  urgent: false,
  lastBuildStartedAt: null,
  lastBuildFinishedAt: null,
  lastBuildStatus: null,
  lastBuildLog: null,
  lastBuildKind: null,
};

/** The two update cycles: the daily in-place apt refresh (kernel held, ~2 min) and the weekly full
 *  rebuild from the base ISO (kernel + everything, ~15 min) — the one that rolls kernel CVEs. */
export type RebuildKind = "refresh" | "full";

/** How much hook output we keep for the Settings card (the tail is where apt's verdict lives). */
const LOG_TAIL_BYTES = 8 * 1024;
/** A rebuild that runs longer than this is presumed wedged and killed. Full rebuilds download the
 *  base ISO on a cold cache, so the ceiling is generous (~15 min build + the download). */
const HOOK_TIMEOUT_MS = 45 * 60 * 1000;
/** Scheduler resolution. The fire guard is per-minute, so 30s ticks cannot double-fire. */
const TICK_MS = 30 * 1000;

export interface ArchManifest {
  arch: Arch;
  imageId: string;
  builtAt: string;
  sha256: string | null;
}

export class ImageUpdates {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastFiredMinute = "";

  constructor(
    private readonly store: Store,
    private readonly imageDistDir: string,
    private readonly rebuildCmd: string | undefined,
    private readonly log: FastifyBaseLogger,
    /** The weekly full-rebuild hook (IMAGE_FULL_REBUILD_CMD). Optional — without it the weekly
     *  cycle simply never fires and the console marks it unconfigured. */
    private readonly fullRebuildCmd: string | undefined = undefined,
  ) {}

  /** The persisted state, with defaults before the first mutation. */
  async state(): Promise<PersistedImageRollout> {
    return (await this.store.getImageRollout()) ?? { ...IMAGE_ROLLOUT_DEFAULTS };
  }

  get rebuildConfigured(): boolean {
    return Boolean(this.rebuildCmd && this.rebuildCmd.trim().length > 0);
  }

  get fullRebuildConfigured(): boolean {
    return Boolean(this.fullRebuildCmd && this.fullRebuildCmd.trim().length > 0);
  }

  /** Apply operator changes (schedule enable/time/day, urgency). Returns the new state. */
  async updateSettings(patch: {
    scheduleEnabled?: boolean;
    scheduleTime?: string;
    fullScheduleEnabled?: boolean;
    fullScheduleDay?: number;
    fullScheduleTime?: string;
    urgent?: boolean;
  }): Promise<PersistedImageRollout> {
    const cur = await this.state();
    const next: PersistedImageRollout = {
      ...cur,
      ...(patch.scheduleEnabled !== undefined ? { scheduleEnabled: patch.scheduleEnabled } : {}),
      ...(patch.scheduleTime !== undefined ? { scheduleTime: patch.scheduleTime } : {}),
      ...(patch.fullScheduleEnabled !== undefined ? { fullScheduleEnabled: patch.fullScheduleEnabled } : {}),
      ...(patch.fullScheduleDay !== undefined ? { fullScheduleDay: patch.fullScheduleDay } : {}),
      ...(patch.fullScheduleTime !== undefined ? { fullScheduleTime: patch.fullScheduleTime } : {}),
      ...(patch.urgent !== undefined ? { urgent: patch.urgent } : {}),
    };
    await this.store.setImageRollout(next);
    if (patch.urgent !== undefined) {
      this.log.info(
        { event: "image.urgent", urgent: patch.urgent },
        patch.urgent
          ? "image roll-out marked URGENT: netbooted boxes on a stale image reboot within minutes"
          : "image roll-out urgency cleared: stale boxes wait for the nightly window",
      );
    }
    return next;
  }

  /** The published image for one arch, or null when the depot has none. */
  async manifest(arch: string): Promise<ArchManifest | null> {
    if (!(ARCHES as readonly string[]).includes(arch)) return null;
    const dir = join(this.imageDistDir, arch);
    let imageId: string;
    let builtAt: string;
    try {
      imageId = (await readFile(join(dir, "image-id.txt"), "utf8")).trim();
      if (!imageId) return null;
      builtAt = (await stat(join(dir, "image-id.txt"))).mtime.toISOString();
    } catch {
      return null; // no published image for this arch (or a pre-POL-41 build without an id)
    }
    let sha256: string | null = null;
    try {
      const sums = await readFile(join(dir, "SHA256SUMS"), "utf8");
      const line = sums.split("\n").find((l) => l.trim().endsWith("polyptic.iso"));
      sha256 = line?.trim().split(/\s+/)[0] ?? null;
    } catch {
      // checksums are best-effort metadata; the imageId is the identity
    }
    return { arch: arch as Arch, imageId, builtAt, sha256 };
  }

  /** All published per-arch images (absent arches omitted). */
  async manifests(): Promise<ArchManifest[]> {
    const out: ArchManifest[] = [];
    for (const arch of ARCHES) {
      const m = await this.manifest(arch);
      if (m) out.push(m);
    }
    return out;
  }

  /**
   * Kick off the rebuild hook (operator button or the schedule) WITHOUT blocking on it: persists
   * the "running" row, spawns the hook, and returns immediately — a manual trigger is an HTTP
   * request and image builds take ~15 minutes. The completion continuation persists the outcome
   * (status + log tail) for the Settings card; `settled` exposes it for tests. No-ops when a run
   * is already in flight or no hook is configured.
   */
  async trigger(trigger: "schedule" | "manual", kind: RebuildKind = "refresh"): Promise<PersistedImageRollout> {
    if (this.running) {
      this.log.warn({ event: "image.rebuild.busy", trigger, kind }, "image rebuild already running, ignoring trigger");
      return this.state();
    }
    const cmd = kind === "full" ? this.fullRebuildCmd : this.rebuildCmd;
    if (!cmd || !cmd.trim()) {
      this.log.warn(
        { event: "image.rebuild.unconfigured", trigger, kind },
        `no ${kind === "full" ? "IMAGE_FULL_REBUILD_CMD" : "IMAGE_REBUILD_CMD"} configured — cannot rebuild the image from here`,
      );
      return this.state();
    }

    this.running = true;
    const startedAt = new Date().toISOString();
    const runningState: PersistedImageRollout = {
      ...(await this.state()),
      lastBuildStartedAt: startedAt,
      lastBuildFinishedAt: null,
      lastBuildStatus: "running",
      lastBuildLog: "",
      lastBuildKind: kind,
    };
    await this.store.setImageRollout(runningState);
    this.log.info({ event: "image.rebuild.start", trigger, kind, cmd }, "image rebuild starting");
    this.settled = this.execute(trigger, kind, cmd, startedAt);
    return runningState;
  }

  /** The in-flight run's completion (resolves to the persisted outcome); for tests/await-ers. */
  settled: Promise<PersistedImageRollout> | null = null;

  private async execute(
    trigger: "schedule" | "manual",
    kind: RebuildKind,
    cmd: string,
    startedAt: string,
  ): Promise<PersistedImageRollout> {
    let tail = "";
    const append = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-LOG_TAIL_BYTES);
    };

    const status: "success" | "failure" = await new Promise((resolvePromise) => {
      const child = spawn("/bin/sh", ["-c", cmd], {
        cwd: HOOK_CWD,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const killer = setTimeout(() => {
        append(Buffer.from("\n[image-updates] hook timed out, killing\n"));
        child.kill("SIGKILL");
      }, HOOK_TIMEOUT_MS);
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (err) => {
        clearTimeout(killer);
        append(Buffer.from(`\n[image-updates] spawn error: ${err.message}\n`));
        resolvePromise("failure");
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        resolvePromise(code === 0 ? "success" : "failure");
      });
    });

    const finished: PersistedImageRollout = {
      ...(await this.state()),
      lastBuildStartedAt: startedAt,
      lastBuildFinishedAt: new Date().toISOString(),
      lastBuildStatus: status,
      lastBuildLog: tail,
      lastBuildKind: kind,
    };
    await this.store.setImageRollout(finished);
    this.running = false;
    this.log.info(
      { event: "image.rebuild.done", trigger, kind, status, imageIds: (await this.manifests()).map((m) => `${m.arch}:${m.imageId}`) },
      `image rebuild ${status}`,
    );
    return finished;
  }

  /** Start the schedule ticker (idempotent). Fires at most once per matching minute. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    // Don't hold the process open for the scheduler alone (tests, CLIs).
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    try {
      const st = await this.state();
      if (this.running) return;
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const minuteKey = `${now.toDateString()} ${hhmm}`;
      if (minuteKey === this.lastFiredMinute) return;
      // The weekly FULL rebuild wins a same-minute collision — it supersedes a refresh (it applies
      // everything the refresh would, plus the kernel).
      if (st.fullScheduleEnabled && this.fullRebuildConfigured && now.getDay() === st.fullScheduleDay && hhmm === st.fullScheduleTime) {
        this.lastFiredMinute = minuteKey;
        await this.trigger("schedule", "full");
        return;
      }
      if (st.scheduleEnabled && this.rebuildConfigured && hhmm === st.scheduleTime) {
        this.lastFiredMinute = minuteKey;
        await this.trigger("schedule", "refresh");
      }
    } catch (err) {
      this.log.error({ event: "image.rebuild.tick_error", err: (err as Error).message }, "image update tick failed");
    }
  }
}
