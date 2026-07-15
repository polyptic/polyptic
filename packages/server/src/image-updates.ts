/**
 * Image updates (POL-41): the control plane's half of "a baked image that still gets security fixes".
 *
 * Three jobs:
 *   0. THE FIRST IMAGE (POL-121) — on startup, a depot with no image at all gets ONE automatic full
 *      build, so a fresh install converges to a bootable fleet with no operator clicks. See
 *      {@link ImageUpdates.bootstrapFirstImage} for the guardrails (empty-only, one-shot, latched).
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
 * The kernel stays pinned during a refresh: this pipeline rolls userspace fixes; a kernel bump is a
 * full rebuild (`build-live-image.sh`), which republishes vmlinuz + initrd too (documented in
 * NETBOOT.md).
 */
import { spawn } from "node:child_process";
import { copyFile, link, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyBaseLogger } from "fastify";

import { parseSelector, resolveRolloutImage } from "@polyptic/protocol";
import type { ImageRing } from "@polyptic/protocol";

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
  // POL-105 — no rings: one image for the whole fleet, exactly the pre-POL-105 behaviour.
  rings: [],
  // Weekly FULL rebuild (POL-43): Sundays 02:00 by default — an hour after the daily refresh slot
  // so a both-scheduled Sunday cannot contend (the refresh finishes in ~2 min).
  fullScheduleEnabled: true,
  fullScheduleDay: 0,
  fullScheduleTime: "02:00",
  urgent: false,
  firstBuildAt: null,
  lastBuildStartedAt: null,
  lastBuildFinishedAt: null,
  lastBuildStatus: null,
  lastBuildLog: null,
  lastBuildKind: null,
};

/** The two update cycles: the daily in-place apt refresh (kernel held, ~2 min) and the weekly full
 *  rebuild from the base ISO (kernel + everything, ~15 min) — the one that rolls kernel CVEs. */
export type RebuildKind = "refresh" | "full";

/** Who asked for a build: the schedule, the operator's button, or the FIRST-IMAGE bootstrap — the
 *  one-shot full build the server fires at startup when a fresh install's depot is empty (POL-121). */
export type RebuildTrigger = "schedule" | "manual" | "bootstrap";

/** How the control plane says something out loud — the Live Activity feed (D25). Optional: an
 *  ImageUpdates without one still builds, it just does so silently. */
export type Announce = (severity: "good" | "warn" | "bad", text: string) => void;

/** How much hook output we keep for the Settings card (the tail is where apt's verdict lives). */
const LOG_TAIL_BYTES = 8 * 1024;
/** A rebuild that runs longer than this is presumed wedged and killed. Full rebuilds download the
 *  base ISO on a cold cache, so the ceiling is generous (~15 min build + the download). Overridable
 *  because a cross-arch cluster (POL-75) runs a build PER ARCH sequentially, and an EMULATED
 *  foreign-arch build is far slower than a native one — so a mixed fleet needs a much higher ceiling
 *  (the chart raises POLYPTIC_HOOK_TIMEOUT_MS when imageUpdates.emulation is on). */
const HOOK_TIMEOUT_MS = Number(process.env.POLYPTIC_HOOK_TIMEOUT_MS) || 45 * 60 * 1000;
/** Scheduler resolution. The fire guard is per-minute, so 30s ticks cannot double-fire. */
const TICK_MS = 30 * 1000;

export interface ArchManifest {
  arch: Arch;
  imageId: string;
  builtAt: string;
  sha256: string | null;
}

/** One retained build in the depot (POL-45), read from `<arch>/builds/<imageId>/`. */
export interface ArchBuild extends ArchManifest {
  /** True for the build whose artifacts are hardlinked at the arch root (what the boot chain serves). */
  active: boolean;
  /** Whether this build carries a standalone bootable ISO (`polyptic-live.iso`, D49). */
  hasLiveIso: boolean;
}

/** The artifacts a build owns. The first four are what the netboot chain streams; `initrd-wifi`
 *  (POL-63) is the fat Wi-Fi initramfs that only ever boots from LOCAL media (fetched by the boxes'
 *  update-poll to refresh their boot medium, absent on pre-POL-63 builds); the live ISO is the
 *  standalone bootable alternative (D49) and is absent unless `build-live-iso.sh` ran. */
const BUILD_ARTIFACTS = ["rootfs.squashfs", "vmlinuz", "initrd", "initrd-wifi", "SHA256SUMS"] as const;
const LIVE_ISO = "polyptic-live.iso";
/** The artifact whose presence *defines* a build directory, and whose mtime is its build time. */
const BUILD_PAYLOAD = "rootfs.squashfs";

/**
 * Which artifacts may be HARDLINKED between the arch root and a build directory, and which must be
 * copied. The distinction is not about size, it is about how the build scripts rewrite them:
 *
 *  - `rootfs.squashfs` and the live ISO are always replaced by `mv`/`rm`+create, which allocates a
 *    NEW inode. Old builds keep the one they hold, so sharing is safe — and these are the big
 *    files, so sharing is the whole point of the layout.
 *  - `SHA256SUMS` is written with shell `>` (`refresh-live-image.sh`), and `vmlinuz`/`initrd`/
 *    `initrd-wifi` with `cp`. Both TRUNCATE THE EXISTING INODE IN PLACE, which through a hardlink
 *    would silently rewrite a retained build's artifact to the new build's bytes. So these are
 *    copied. It costs a few hundred MB per retained build against the shared root image, and it
 *    cannot be corrupted by a script that writes in place.
 */
const SHAREABLE = new Set<string>([ BUILD_PAYLOAD, LIVE_ISO ]);
/** Default builds retained per arch before the oldest are pruned (IMAGE_RETAIN_BUILDS). */
export const DEFAULT_RETAIN_BUILDS = 3;

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
    /** Builds retained per arch (IMAGE_RETAIN_BUILDS). The active build is never pruned. */
    readonly retainBuilds: number = DEFAULT_RETAIN_BUILDS,
    /** Push a line to the Live Activity feed (POL-121). The first-image build is the one build an
     *  operator MUST know about — a fresh install cannot netboot anything until it lands — so it
     *  narrates itself into the console's feed rather than only a Job log. */
    private readonly announce: Announce = () => {},
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
      const line = sums.split("\n").find((l) => l.trim().endsWith(BUILD_PAYLOAD));
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

  // ── Build history (POL-45) ───────────────────────────────────────────────────────────────────
  //
  // Depot layout per arch:
  //
  //   <arch>/builds/<imageId>/{rootfs.squashfs,vmlinuz,initrd,SHA256SUMS[,polyptic-live.iso]}
  //   <arch>/{rootfs.squashfs,vmlinuz,initrd,SHA256SUMS[,polyptic-live.iso]}  hardlinks → ACTIVE build
  //   <arch>/image-id.txt                                                     the active build's id
  //
  // The arch root is exactly what it always was, so the boot chain (grub.cfg's `root=live:`, the
  // /dist/image/<arch>/… routes) and every already-written boot medium keep working untouched.
  // Hardlinking means the active build costs no extra bytes. ACTIVATING a build relinks the root
  // and rewrites image-id.txt, and because every netbooted box compares manifest.json's imageId
  // against its own /etc/polyptic/image-id every 5 minutes, that IS the fleet rollback path.

  private buildDir(arch: string, imageId: string): string {
    return join(this.imageDistDir, arch, "builds", imageId);
  }

  /**
   * Put `name` at `dest` from `src`, replacing whatever is there. Shareable artifacts (the ISOs) are
   * hardlinked so the active build costs no extra disk; the rest are copied because the build
   * scripts rewrite them in place (see {@link SHAREABLE}). Hardlinks fall back to a copy across
   * filesystems (EXDEV) — a depot spanning mounts still works, it just uses more space.
   */
  private async place(name: string, src: string, dest: string): Promise<void> {
    await unlink(dest).catch(() => {}); // absent is fine — we are (re)creating it
    if (!SHAREABLE.has(name)) {
      await copyFile(src, dest);
      return;
    }
    try {
      await link(src, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await copyFile(src, dest);
    }
  }

  /** The retained builds for one arch, newest first. Empty when the depot has no `builds/` dir. */
  async builds(arch: string): Promise<ArchBuild[]> {
    if (!(ARCHES as readonly string[]).includes(arch)) return [];
    const root = join(this.imageDistDir, arch, "builds");
    let names: string[];
    try {
      names = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return []; // no builds/ dir yet (pre-POL-45 depot, or nothing built)
    }
    const active = (await this.manifest(arch))?.imageId ?? null;
    const out: ArchBuild[] = [];
    for (const imageId of names) {
      const dir = join(root, imageId);
      // The payload's mtime is the build time; the directory's changes when we prune siblings. A
      // directory without one is a half-written build — or a pre-POL-35 `polyptic.iso` build, which
      // the current boot cmdline cannot use anyway, so it correctly drops out of the history.
      let builtAt: string;
      try {
        builtAt = (await stat(join(dir, BUILD_PAYLOAD))).mtime.toISOString();
      } catch {
        continue; // a half-written or hand-made directory — not a build
      }
      let sha256: string | null = null;
      try {
        const sums = await readFile(join(dir, "SHA256SUMS"), "utf8");
        sha256 = sums.split("\n").find((l) => l.trim().endsWith(BUILD_PAYLOAD))?.trim().split(/\s+/)[0] ?? null;
      } catch {
        // checksums are best-effort metadata; the imageId is the identity
      }
      const hasLiveIso = await stat(join(dir, LIVE_ISO)).then(
        (st) => st.isFile(),
        () => false,
      );
      out.push({ arch: arch as Arch, imageId, builtAt, sha256, active: imageId === active, hasLiveIso });
    }
    return out.sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  }

  /** Retained builds across every arch, newest first. */
  async allBuilds(): Promise<ArchBuild[]> {
    const out: ArchBuild[] = [];
    for (const arch of ARCHES) out.push(...(await this.builds(arch)));
    return out.sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  }

  /**
   * Fold a depot that predates POL-45 — artifacts loose at the arch root, no `builds/` — into the
   * new layout by hardlinking the current image into `builds/<its id>/`. Idempotent, and a no-op
   * when the arch has no published image. Also adopts a build the hook just wrote to the root.
   */
  async adopt(arch: string): Promise<void> {
    const m = await this.manifest(arch);
    if (!m) return;
    const dir = this.buildDir(arch, m.imageId);
    if (await stat(join(dir, BUILD_PAYLOAD)).then(() => true, () => false)) return; // already adopted
    await mkdir(dir, { recursive: true });
    const root = join(this.imageDistDir, arch);
    for (const name of [...BUILD_ARTIFACTS, LIVE_ISO]) {
      const src = join(root, name);
      if (!(await stat(src).then((st) => st.isFile(), () => false))) continue;
      await this.place(name, src, join(dir, name));
    }
    this.log.info({ event: "image.build.adopted", arch, imageId: m.imageId }, "adopted the published image into builds/");
  }

  /**
   * Ensure the ACTIVE build's `builds/<imageId>/` mirror exists (POL-79). This is {@link adopt}
   * exposed under a name the depot serve path can call: a box PINS `root=live:…/builds/<active-id>/`
   * (POL-63/D67), so if that build reached the arch root by a path that never ran a reconcile — an
   * externally-run rebuild Job (`bun deploy/k8s-run-job.ts full amd64` invoked directly), or a
   * partially-failed multi-arch hook run whose non-zero exit skipped the post-rebuild retain — the
   * pinned path 404s until the next server RESTART runs {@link start}'s reconcile. Healing it lazily
   * on the fetch (and on the box's manifest poll) removes that restart dependency: the exact homelab
   * gap POL-79 fixes. Idempotent (an already-mirrored build is one stat and a return) and best-effort
   * at the call site.
   */
  async ensureActiveBuild(arch: string): Promise<void> {
    await this.adopt(arch);
  }

  /**
   * Serve a retained build: relink the arch root at it and publish its id. Every netbooted box on a
   * different image reboots into it on its next 5-minute poll (urgent → minutes, else the nightly
   * window), so activating an OLDER build rolls the fleet back. Throws when the build is unknown.
   */
  async activate(arch: string, imageId: string): Promise<ArchBuild[]> {
    if (!(ARCHES as readonly string[]).includes(arch)) throw new Error(`unknown architecture: ${arch}`);
    const dir = this.buildDir(arch, imageId);
    if (!(await stat(join(dir, BUILD_PAYLOAD)).then((st) => st.isFile(), () => false))) {
      throw new Error(`no retained build ${imageId} for ${arch}`);
    }
    const root = join(this.imageDistDir, arch);
    for (const name of [...BUILD_ARTIFACTS, LIVE_ISO]) {
      const src = join(dir, name);
      if (!(await stat(src).then((st) => st.isFile(), () => false))) {
        // This build has no such artifact (e.g. no live ISO) — drop any stale root link for it.
        await unlink(join(root, name)).catch(() => {});
        continue;
      }
      await this.place(name, src, join(root, name));
    }
    // Last, so a crash mid-relink leaves the OLD id published rather than claiming a partial swap.
    await writeFile(join(root, "image-id.txt"), `${imageId}\n`, "utf8");
    this.log.info(
      { event: "image.build.activated", arch, imageId },
      "activated image — netbooted boxes on another image reboot into it per the roll-out policy",
    );
    await this.prune(arch);
    return this.builds(arch);
  }

  // ── Staged roll-outs (POL-105) ───────────────────────────────────────────────────────────────
  //
  // A RING pins one build for the machines a POL-103 selector matches. `manifest.json?machineId=…`
  // is resolved per machine: first matching ring wins, everyone else gets the arch's ACTIVE build —
  // so a ring can only ever narrow who deviates from the fleet, never widen it, and a box the depot
  // has never heard of (or one that predates the query param) gets exactly today's answer.
  //
  // RETENTION (D54) IS DELIBERATELY LEFT ALONE. Pin-aware retention — "never prune a build some ring
  // still wants" — was rejected once already (D105) and is not re-litigated here: it means a forgotten
  // ring can stop the depot pruning forever. Instead: a ring must name a RETAINED build when it is
  // set (you cannot pin a build the depot cannot serve), and if retention later prunes that build out
  // from under a long-lived ring, the resolver degrades that ring's machines back onto the ACTIVE
  // build and says so out loud. In practice a canary pins the NEWEST build, which prune keeps by
  // definition, and the fleet's active build is never pruned — so the interaction only bites a ring
  // left pinned to an ageing build across `retainBuilds` rebuilds, which is a stale canary anyway.

  /** The operator's roll-out rings, in order. */
  async rings(): Promise<ImageRing[]> {
    return (await this.state()).rings ?? [];
  }

  /**
   * Replace the whole ring list. Every ring is validated: its selector must parse (POL-103's grammar)
   * and its build must be RETAINED for its arch — a ring naming a build the depot cannot serve would
   * point a box at a 404 on its next boot. Throws with a plain sentence on the first bad ring.
   */
  async setRings(rings: ImageRing[]): Promise<PersistedImageRollout> {
    const seen = new Set<string>();
    for (const ring of rings) {
      const parsed = parseSelector(ring.selector);
      if (!parsed.ok) throw new Error(`ring "${ring.selector}": ${parsed.error}`);
      const key = `${ring.arch} ${parsed.selector.tags.join(",")}`;
      if (seen.has(key)) {
        throw new Error(`two rings target ${ring.selector} on ${ring.arch} — a machine must have one answer`);
      }
      seen.add(key);
      const retained = await this.builds(ring.arch);
      if (!retained.some((b) => b.imageId === ring.imageId)) {
        throw new Error(`no retained ${ring.arch} build ${ring.imageId} — pin a build the depot still has`);
      }
    }

    const next: PersistedImageRollout = { ...(await this.state()), rings };
    await this.store.setImageRollout(next);
    this.log.info(
      { event: "image.rings.set", rings: rings.map((r) => `${r.selector}→${r.arch}:${r.imageId}`) },
      "image roll-out rings updated",
    );
    return next;
  }

  /**
   * Resolve the manifest ONE machine should see, given its tags. Falls back to the arch's active
   * build when no ring matches — and also when a matching ring's build has been pruned, which is
   * announced once per (ring, build) so a canary that has silently rejoined the fleet is not silent.
   * Null when the arch has no published image at all.
   */
  async resolveFor(arch: string, tags: readonly string[]): Promise<(ArchManifest & { urgent: boolean }) | null> {
    const active = await this.manifest(arch);
    if (!active) return null;
    const st = await this.state();
    const retained = new Set((await this.builds(arch)).map((b) => b.imageId));
    const resolved = resolveRolloutImage(st.rings ?? [], arch, tags, active.imageId, st.urgent, retained);

    if (resolved.strandedRing) this.warnStranded(resolved.strandedRing, active.imageId);
    if (resolved.imageId === active.imageId) return { ...active, urgent: resolved.urgent };

    // A ring's build: its own identity + checksum, read from its retained build directory. The box
    // then re-pins its medium at `builds/<that id>/` exactly as it does for the fleet build.
    const build = (await this.builds(arch)).find((b) => b.imageId === resolved.imageId);
    if (!build) return { ...active, urgent: st.urgent }; // raced with a prune — the fleet build is always safe
    return {
      arch: build.arch,
      imageId: build.imageId,
      builtAt: build.builtAt,
      sha256: build.sha256,
      urgent: resolved.urgent,
    };
  }

  /** One line per stranded (ring, active) pair — the resolver runs every 5 minutes per box. */
  private readonly strandedWarned = new Set<string>();
  private warnStranded(ring: ImageRing, activeImageId: string): void {
    const key = `${ring.arch} ${ring.selector} ${ring.imageId}`;
    if (this.strandedWarned.has(key)) return;
    this.strandedWarned.add(key);
    this.log.warn(
      { event: "image.ring.stranded", selector: ring.selector, arch: ring.arch, imageId: ring.imageId },
      "a roll-out ring pins a build the depot has pruned — its machines follow the fleet build",
    );
    this.announce(
      "warn",
      `Roll-out ring ${ring.selector} pinned ${ring.arch} build ${ring.imageId}, which has been pruned — those machines now follow the fleet build ${activeImageId}`,
    );
  }

  /**
   * PROMOTE a ring to the whole fleet: activate its build for that arch (the D54 relink → every box
   * on another image reboots into it) and DROP the ring, so the canary machines and everyone else
   * converge on one id. One action, one activity line. `urgent` sets the FLEET switch, because after
   * a promotion the ring's own urgency no longer targets anybody. Throws when no such ring exists.
   */
  async promote(arch: string, selector: string, urgent: boolean): Promise<PersistedImageRollout> {
    const st = await this.state();
    const rings = st.rings ?? [];
    const ring = rings.find((r) => r.arch === arch && r.selector === selector);
    if (!ring) throw new Error(`no roll-out ring ${selector} for ${arch}`);

    await this.activate(arch, ring.imageId);
    const next: PersistedImageRollout = {
      ...(await this.state()),
      urgent,
      rings: rings.filter((r) => r !== ring),
    };
    await this.store.setImageRollout(next);
    this.log.info(
      { event: "image.ring.promoted", arch, selector, imageId: ring.imageId, urgent },
      "promoted a roll-out ring's build to the whole fleet",
    );
    this.announce(
      "good",
      `Promoted ${arch} build ${ring.imageId} from ${selector} to the whole fleet${urgent ? " — boxes reboot within minutes" : " — boxes roll in the nightly window"}`,
    );
    return next;
  }

  /** Adopt + prune every arch. Best-effort: depot bookkeeping must never fail a serve or a build. */
  async retain(): Promise<void> {
    for (const arch of ARCHES) {
      try {
        await this.adopt(arch);
        await this.prune(arch);
      } catch (err) {
        this.log.error({ event: "image.build.retain_error", arch, err: (err as Error).message }, "build retention failed");
      }
    }
  }

  /** Drop all but the newest `retainBuilds` builds for one arch. The active build is never pruned. */
  async prune(arch: string): Promise<void> {
    const builds = await this.builds(arch);
    // `builds` is newest-first, so everything past the cut is a pruning candidate.
    const doomed = builds.slice(this.retainBuilds).filter((b) => !b.active);
    for (const b of doomed) {
      await rm(this.buildDir(arch, b.imageId), { recursive: true, force: true });
      this.log.info({ event: "image.build.pruned", arch, imageId: b.imageId, retain: this.retainBuilds }, "pruned old build");
    }
  }

  /**
   * Kick off the rebuild hook (operator button or the schedule) WITHOUT blocking on it: persists
   * the "running" row, spawns the hook, and returns immediately — a manual trigger is an HTTP
   * request and image builds take ~15 minutes. The completion continuation persists the outcome
   * (status + log tail) for the Settings card; `settled` exposes it for tests. No-ops when a run
   * is already in flight or no hook is configured.
   */
  async trigger(trigger: RebuildTrigger, kind: RebuildKind = "refresh"): Promise<PersistedImageRollout> {
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
    trigger: RebuildTrigger,
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
    // The hook writes the new artifacts to the arch root and stamps image-id.txt; take a retained
    // copy of what it just published (`builds/<active-id>/`, hardlinked), then drop anything past
    // the retention window (POL-45). Reconcile on FAILURE too (POL-79): a multi-arch hook run
    // (`k8s-run-job.ts full` fans out over every arch) exits non-zero if ANY arch fails, yet the
    // arches that DID succeed already published their new arch root — gating retain on overall
    // success left those builds with no `builds/<id>/` mirror, so a box pinning that arch's build
    // 404'd. `retain()` reads the live manifest and mirrors only what is actually at each arch root,
    // so running it unconditionally heals the good arches and is a no-op for the failed one.
    // Never fatal: a depot we cannot file is still a depot we can serve.
    await this.retain();
    this.running = false;
    const manifests = await this.manifests();
    this.log.info(
      { event: "image.rebuild.done", trigger, kind, status, imageIds: manifests.map((m) => `${m.arch}:${m.imageId}`) },
      `image rebuild ${status}`,
    );
    // The FIRST image is the one build the operator has to hear about: until it lands nothing in the
    // fleet can netboot, and the boot medium the install hook baked against an empty depot is the
    // LEAN one (D68). The full-rebuild Job re-bakes the medium as its last step, so a success here
    // means the download is now the full, Wi-Fi-capable stick (POL-121).
    if (trigger === "bootstrap") {
      if (status === "success" && manifests.length > 0) {
        this.announce(
          "good",
          "First OS image built — screens can netboot now, and the downloadable boot medium is the full one",
        );
      } else {
        this.announce(
          "bad",
          "First OS image build failed — screens cannot netboot until an image exists. Retry from Onboard Screens ▸ ⋯ ▸ Full rebuild",
        );
      }
    }
    return finished;
  }

  /**
   * POL-121 — THE FIRST IMAGE. A fresh `helm install` starts with an EMPTY depot, and nothing used to
   * fill it: the nightly cycle only REFRESHES an existing image, and the weekly full rebuild is up to
   * seven days away. So the fleet could not netboot a single screen, and the boot-medium install hook,
   * finding no image, quietly fell back to the LEAN wired-only medium (D68). This closes that: the
   * server itself notices the empty depot at startup and fires the full build ONCE, asynchronously
   * (it is a k8s Job — the server keeps serving), and the Job's own last step re-bakes the boot medium,
   * so the download becomes the full one.
   *
   * The guardrails ARE the feature:
   *  - EMPTY ONLY. One published image anywhere in the depot and this is a no-op — it never overwrites
   *    and never re-triggers against an existing image.
   *  - ONE SHOT, EVER. `firstBuildAt` is claimed in the STORE before the hook is spawned, so a
   *    crash-looping or rescheduled pod re-reads the claim and stands down. A build that fails is
   *    reported, not retried — a retry loop keyed on "the depot is still empty" is precisely the build
   *    storm we must not have. (A `running` row from a previous pod is also respected: the Job it
   *    started outlives the pod that asked for it.)
   *  - OPERATOR'S CHOICE WINS. Weekly cycle switched off, or no `IMAGE_FULL_REBUILD_CMD` (a dev stack,
   *    a laptop server, `imageUpdates.enabled: false`) → no build, ever; just a line saying netboot is
   *    unavailable until an image exists.
   */
  async bootstrapFirstImage(): Promise<void> {
    const st = await this.state();
    if (st.firstBuildAt) return; // already claimed by us or by a previous pod — never twice
    if ((await this.manifests()).length > 0) return; // the depot has an image: nothing to bootstrap

    if (!this.fullRebuildConfigured) {
      this.log.warn(
        { event: "image.bootstrap.unconfigured" },
        "the image depot is empty and no IMAGE_FULL_REBUILD_CMD is configured — netboot is unavailable until an image exists",
      );
      return;
    }
    if (!st.fullScheduleEnabled) {
      this.log.warn(
        { event: "image.bootstrap.disabled" },
        "the image depot is empty but the full-rebuild cycle is switched off — not building behind the operator's back; netboot stays unavailable",
      );
      return;
    }
    if (this.running || st.lastBuildStatus === "running") {
      // A build is already in flight — in this process, or one a previous pod started whose Job is
      // still running (the Job outlives the pod). Either way it will fill the depot.
      this.log.info({ event: "image.bootstrap.busy" }, "a build is already running — not starting a first-image build");
      return;
    }

    // Claim the latch BEFORE spawning: whatever happens next, no other pod starts a second build.
    await this.store.setImageRollout({ ...st, firstBuildAt: new Date().toISOString() });
    this.log.warn(
      { event: "image.bootstrap.start" },
      "image depot is empty — building the first OS image now (screens cannot netboot until it finishes)",
    );
    this.announce("warn", "Building the first OS image — screens can't netboot until this finishes");
    await this.trigger("bootstrap", "full");
  }

  /** Start the schedule ticker (idempotent). Fires at most once per matching minute. */
  start(): void {
    if (this.timer) return;
    // Fold a pre-POL-45 depot (artifacts loose at the arch root) into builds/ so history starts
    // with whatever is already published, rather than staying empty until the next rebuild — then,
    // on a depot that has NOTHING to fold because nothing was ever built, fire the one-shot
    // first-image build (POL-121). Both are async: the server serves while the depot fills.
    void this.retain()
      .then(() => this.bootstrapFirstImage())
      .catch((err) => {
        this.log.error({ event: "image.bootstrap.error", err: (err as Error).message }, "first-image bootstrap failed");
      });
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
