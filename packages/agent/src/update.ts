/**
 * @polyptic/agent — runtime self-update (POL-160).
 *
 * The agent binary is baked into the netboot squashfs, so an agent-code fix used to reach a box only
 * on a FULL image rebuild + reboot — and a plain `helm upgrade` rebuilds the boot medium, not the
 * image, so nothing reached the fleet and nothing said so (v0.2.41 shipped, every box kept running
 * 0.2.40). This closes that: when the server (which knows both this box's `agentVersion` and the
 * version it bundles) says a newer binary is available, the agent pulls `/dist/agent/<arch>`, verifies
 * it, atomically swaps its own binary, and exits cleanly for systemd (`Restart=always`) to relaunch —
 * no rebuild, no reboot. The relaunched agent reconnects exactly like any other reconnect.
 *
 * SAFETY is the whole risk surface, so it is layered and mostly PURE (unit-tested without a box):
 *   1. Never sideways/backward. {@link planUpdate} re-checks `isNewerAgentVersion` — the server's
 *      offer can only ever move a box FORWARD, and a replayed/older offer is a no-op.
 *   2. Never twice for the same target in one process — a server that keeps offering (every hello)
 *      does not trigger repeated downloads.
 *   3. Only an updatable binary. A dev agent run from source (`bun src/index.ts`) has no compiled
 *      binary to replace and is skipped; only the baked single-file binary (which bakes
 *      `POLYPTIC_BUILD_VERSION`) self-updates.
 *   4. Write-then-rename. The download lands at `<bin>.new`, is verified (size, sha256 when given, and
 *      a `--version` SELF-CHECK that the new binary actually runs and reports the target version),
 *      and only THEN atomically renamed over the live binary. A partial or corrupt download never
 *      becomes the live binary.
 *   5. Keep the previous binary at `<bin>.bak` and a crash-loop marker, so a new binary that boots but
 *      then keeps crashing fast is rolled BACK to the one that worked ({@link decideStartupAction}),
 *      rather than wedging the box content-less under systemd's relaunch.
 *
 * This carries ONLY the agent binary. Kernel/OS changes stay on the image rebuild + reboot path.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import { isNewerAgentVersion } from "@polyptic/protocol";

/** How long a freshly-swapped binary must stay up before we call the update GOOD and drop the backup. */
export const STABLE_UPTIME_MS = 45_000;
/** Boots of a swapped-in binary that never reached {@link STABLE_UPTIME_MS} before we roll back. */
export const MAX_UNSTABLE_BOOTS = 3;

/** The crash-loop marker persisted next to the credential; the pure decision below reads only this. */
export interface UpdateMarker {
  /** The version we swapped IN — the binary that should be running after the re-exec. */
  targetVersion: string;
  /** The version we swapped OUT — what `<bin>.bak` holds, for a rollback. */
  previousVersion: string;
  /** ISO time of the swap. */
  swappedAt: string;
  /** How many times a binary carrying `targetVersion` has BOOTED without yet proving itself stable. */
  boots: number;
  /** True once the new binary survived {@link STABLE_UPTIME_MS} — the update is committed, no rollback. */
  committed: boolean;
}

export type StartupAction =
  | { kind: "none" }
  | { kind: "commit"; marker: UpdateMarker }
  | { kind: "rollback"; marker: UpdateMarker };

/**
 * PURE — decide what a just-started agent should do about a self-update marker, given the version it
 * is actually running now. This is the crash-loop guard's whole brain, so it is testable without ever
 * touching a disk or a process:
 *
 *   - No marker, or an already-committed one, or a marker for a version we are NOT running (a rollback
 *     already happened, or the swap didn't take) → nothing to do; the caller clears any stale marker.
 *   - Running the target, not yet committed, and this boot is still within the crash-loop budget →
 *     COMMIT path: let it run and prove itself (the caller schedules the stable-uptime commit).
 *   - Running the target, not yet committed, and it has now BOOTED too many times without ever
 *     staying up → ROLLBACK: the new binary boots but won't stay alive; restore `<bin>.bak`.
 */
export function decideStartupAction(
  marker: UpdateMarker | null,
  currentVersion: string,
  opts: { maxUnstableBoots?: number } = {},
): StartupAction {
  if (!marker) return { kind: "none" };
  if (marker.committed) return { kind: "none" };
  if (marker.targetVersion !== currentVersion) return { kind: "none" }; // not the binary this marker is about
  const maxBoots = opts.maxUnstableBoots ?? MAX_UNSTABLE_BOOTS;
  // `boots` is incremented to include THIS boot by the caller before deciding; once it exceeds the
  // budget the new binary has had its chances and never stayed up.
  if (marker.boots > maxBoots) return { kind: "rollback", marker };
  return { kind: "commit", marker };
}

/** PURE — the http(s) origin the binary lives under, derived from the ws(s) URL the agent dials. */
export function httpBaseFromServerUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  const proto = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
  return `${proto}//${u.host}`;
}

/** PURE — resolve the offer's URL (a same-origin path, or an absolute URL) against the server URL. */
export function resolveUpdateUrl(serverUrl: string, urlOrPath: string): string {
  if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
  return httpBaseFromServerUrl(serverUrl) + (urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`);
}

/**
 * The absolute path of the running binary to replace, or null when this process is NOT an updatable
 * single-file binary (a dev agent run from source, or a build that did not bake its version). Env
 * override for tests. The baked binary bakes `POLYPTIC_BUILD_VERSION`, so its presence is the signal
 * that `process.execPath` is our own binary rather than the bun runtime running our sources.
 */
export function selfBinaryPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.POLYPTIC_AGENT_SELF_PATH?.trim();
  if (override) return override;
  if (!env.POLYPTIC_BUILD_VERSION?.trim()) return null;
  return process.execPath;
}

/** What {@link planUpdate} decides to do with an offer. */
export type UpdatePlan =
  | { action: "skip"; reason: string }
  | { action: "apply"; binaryPath: string };

/**
 * PURE — should we act on this offer? Skips when the offer is not strictly newer, when this process
 * is not an updatable binary, or when we already attempted this exact target in this process.
 */
export function planUpdate(input: {
  currentVersion: string;
  offerVersion: string;
  binaryPath: string | null;
  attemptedVersions: ReadonlySet<string>;
}): UpdatePlan {
  const { currentVersion, offerVersion, binaryPath, attemptedVersions } = input;
  if (!isNewerAgentVersion(offerVersion, currentVersion)) {
    return { action: "skip", reason: `offer ${offerVersion} is not newer than ${currentVersion}` };
  }
  if (!binaryPath) {
    return { action: "skip", reason: "not running as an updatable binary (dev/source run)" };
  }
  if (attemptedVersions.has(offerVersion)) {
    return { action: "skip", reason: `already attempted ${offerVersion} this session` };
  }
  return { action: "apply", binaryPath };
}

/** Injectable IO for {@link applyUpdate}, so the whole swap sequence is unit-testable with fakes. */
export interface UpdateIO {
  /** Download `url` to `dest`; resolve to the number of bytes written. */
  download(url: string, dest: string): Promise<number>;
  /** Hex sha256 of a file. */
  sha256(path: string): Promise<string>;
  /** File size in bytes. */
  size(path: string): Promise<number>;
  /** Run `<path> --version` and return the version it prints (trimmed). Throws if it cannot run. */
  selfCheck(path: string): Promise<string>;
  /** Make a file executable (0755). */
  makeExecutable(path: string): Promise<void>;
  /** Copy (for the `.bak` backup — the live binary must remain intact until the atomic rename). */
  copy(from: string, to: string): Promise<void>;
  /** Atomic rename within the same directory. */
  rename(from: string, to: string): Promise<void>;
  /** Best-effort delete (cleanup); never throws. */
  remove(path: string): Promise<void>;
}

export type ApplyResult = { ok: true } | { ok: false; reason: string };

/**
 * Download, verify, and atomically swap in the new binary, keeping the old one at `<bin>.bak`. Does
 * NOT exit the process (the caller does, so it can send its status frame first). Every failure leaves
 * the LIVE binary untouched and cleans up the temp file — a bad update can never strand the box.
 */
export async function applyUpdate(
  opts: {
    binaryPath: string;
    url: string;
    targetVersion: string;
    sha256?: string;
    sizeBytes?: number;
  },
  io: UpdateIO,
): Promise<ApplyResult> {
  const tmp = `${opts.binaryPath}.new`;
  const bak = `${opts.binaryPath}.bak`;
  try {
    await io.remove(tmp); // a leftover from an interrupted attempt
    const written = await io.download(opts.url, tmp);
    if (written <= 0) return fail(io, tmp, "download wrote zero bytes");
    if (opts.sizeBytes !== undefined && written !== opts.sizeBytes) {
      return fail(io, tmp, `size mismatch: got ${written} bytes, expected ${opts.sizeBytes}`);
    }
    const gotSize = await io.size(tmp);
    if (gotSize <= 0) return fail(io, tmp, "downloaded file is empty");
    if (opts.sha256) {
      const got = (await io.sha256(tmp)).toLowerCase();
      if (got !== opts.sha256.toLowerCase()) {
        return fail(io, tmp, `sha256 mismatch: got ${got}, expected ${opts.sha256}`);
      }
    }
    await io.makeExecutable(tmp);
    // The decisive guard: the new binary must actually RUN and report the version we were promised.
    // A wrong-arch, truncated, or incompatible binary fails here and never becomes the live binary.
    let reported: string;
    try {
      reported = await io.selfCheck(tmp);
    } catch (err) {
      return fail(io, tmp, `self-check failed to run: ${(err as Error).message}`);
    }
    if (reported.trim() !== opts.targetVersion.trim()) {
      return fail(io, tmp, `self-check version mismatch: binary reports "${reported.trim()}", expected "${opts.targetVersion}"`);
    }
    // Keep the current binary for rollback, THEN atomically replace it. Copy (not rename) the backup so
    // the live binary is never momentarily absent.
    await io.copy(opts.binaryPath, bak).catch(() => {}); // best-effort backup; the swap is the point
    await io.rename(tmp, opts.binaryPath);
    return { ok: true };
  } catch (err) {
    return fail(io, tmp, (err as Error).message);
  }
}

async function fail(io: UpdateIO, tmp: string, reason: string): Promise<ApplyResult> {
  await io.remove(tmp);
  return { ok: false, reason };
}

// ── Real IO ──────────────────────────────────────────────────────────────────

/** The production {@link UpdateIO}: fetch + node fs + a `--version` subprocess self-check. */
export function realUpdateIO(log: (m: string) => void): UpdateIO {
  return {
    async download(url, dest) {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`GET ${url} → HTTP ${res.status}`);
      await mkdir(dirname(dest), { recursive: true }).catch(() => {});
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const ws = createWriteStream(dest, { mode: 0o755 });
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
          .pipe(ws)
          .on("finish", () => resolvePromise())
          .on("error", rejectPromise);
      });
      return (await stat(dest)).size;
    },
    async sha256(path) {
      const buf = await readFile(path);
      return createHash("sha256").update(buf).digest("hex");
    },
    async size(path) {
      return (await stat(path)).size;
    },
    selfCheck(path) {
      return new Promise<string>((resolvePromise, rejectPromise) => {
        const child = spawn(path, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let errOut = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          rejectPromise(new Error("--version timed out"));
        }, 15_000);
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (errOut += d.toString()));
        child.on("error", (err) => {
          clearTimeout(timer);
          rejectPromise(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) resolvePromise(out.trim());
          else rejectPromise(new Error(`--version exited ${code}: ${errOut.trim() || out.trim()}`));
        });
      });
    },
    async makeExecutable(path) {
      await chmod(path, 0o755);
    },
    async copy(from, to) {
      await copyFile(from, to);
      await chmod(to, 0o755).catch(() => {});
    },
    async rename(from, to) {
      await rename(from, to);
    },
    async remove(path) {
      await rm(path, { force: true }).catch(() => {
        log(`could not remove ${path}`);
      });
    },
  };
}

// ── Marker persistence ─────────────────────────────────────────────────────────

/** Where the crash-loop marker lives — a sibling of the binary, in a fixed name. */
export function markerPath(binaryPath: string): string {
  return join(dirname(binaryPath), ".polyptic-agent-update.json");
}

export async function readMarker(binaryPath: string): Promise<UpdateMarker | null> {
  try {
    const raw = await readFile(markerPath(binaryPath), "utf8");
    const m = JSON.parse(raw) as UpdateMarker;
    if (typeof m.targetVersion === "string" && typeof m.boots === "number") return m;
    return null;
  } catch {
    return null;
  }
}

export async function writeMarker(binaryPath: string, marker: UpdateMarker): Promise<void> {
  await writeFile(markerPath(binaryPath), JSON.stringify(marker), "utf8");
}

export async function clearMarker(binaryPath: string): Promise<void> {
  await rm(markerPath(binaryPath), { force: true }).catch(() => {});
}

/** Restore `<bin>.bak` over the live binary (the crash-loop rollback). Returns false when there is no
 *  backup to restore — then the caller can only keep limping on the current binary. */
export async function rollbackToBackup(binaryPath: string): Promise<boolean> {
  const bak = `${binaryPath}.bak`;
  try {
    await stat(bak);
  } catch {
    return false;
  }
  await chmod(bak, 0o755).catch(() => {});
  await rename(bak, binaryPath);
  return true;
}
