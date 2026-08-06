/**
 * @polyptic/agent — runtime self-update (POL-160).
 *
 * The agent binary is baked into the netboot squashfs, so an agent-code fix used to reach a box only
 * on a FULL image rebuild + reboot — and a plain `helm upgrade` rebuilds the boot medium, not the
 * image, so nothing reached the fleet and nothing said so (v0.2.41 shipped, every box kept running
 * 0.2.40). This closes that: when the server (which knows both this box's `agentVersion` and the
 * version it bundles) says a newer binary is available, the agent pulls `/dist/agent/<arch>`, verifies
 * it, has the binary swapped, and exits cleanly for systemd (`Restart=always`) to relaunch — no
 * rebuild, no reboot. The relaunched agent reconnects exactly like any other reconnect.
 *
 * SAFETY is the whole risk surface, so it is layered and mostly PURE (unit-tested without a box):
 *   1. Never sideways/backward. {@link planUpdate} re-checks `isNewerAgentVersion` — the server's
 *      offer can only ever move a box FORWARD, and a replayed/older offer is a no-op.
 *   2. Never twice for the same target in one process — a server that keeps offering (every hello)
 *      does not trigger repeated downloads.
 *   3. Only a compiled binary. A dev agent run from source (`bun src/index.ts`) has no single-file
 *      binary to replace and is skipped; {@link isCompiledBinary} answers that from the embedded
 *      filesystem the compiler produced, not from an environment variable.
 *   4. Write-then-rename. The download lands on a staging path this UNPRIVILEGED process can write,
 *      is verified (size, sha256 when given, and a `--version` SELF-CHECK that the new binary
 *      actually runs and reports the target version), and only THEN swapped over the live binary.
 *      A partial or corrupt download never becomes the live binary.
 *   5. Keep the previous binary at `<bin>.bak` and a crash-loop marker, so a new binary that boots but
 *      then keeps crashing fast is rolled BACK to the one that worked ({@link decideStartupAction}),
 *      rather than wedging the box content-less under systemd's relaunch.
 *
 * WHO WRITES THE BINARY (the second half of POL-160's field failure). The agent runs as the
 * unprivileged kiosk user and `/usr/local/bin` is root-owned, so the agent renaming its own binary
 * fails EACCES on every real box. Relocating the binary somewhere the agent can write would hand the
 * agent write access to its own code path, so it does not happen here. Instead the swap goes through
 * the same request-file seam as the POL-55 reboot and the POL-176 install: the agent stages and
 * verifies the binary, then writes one small request into the single kiosk-writable directory, and a
 * root-owned systemd path unit runs a fixed script that performs the swap. The script chooses no
 * paths and runs no command the agent names — see {@link UPDATE_REQUEST_PATH} and
 * setup/templates.ts. A box that can write its own binary (a dev host, a root-run agent) skips the
 * helper and swaps directly; a box with neither route SKIPS the update and says which is missing.
 *
 * This carries ONLY the agent binary. Kernel/OS changes stay on the image rebuild + reboot path.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import { isNewerAgentVersion, sameAgentVersion } from "@polyptic/protocol";

import { stateDir } from "./credential";
import { BAKED_AGENT_VERSION } from "./version";

/** How long a freshly-swapped binary must stay up before we call the update GOOD and drop the backup. */
export const STABLE_UPTIME_MS = 45_000;
/** Boots of a swapped-in binary that never reached {@link STABLE_UPTIME_MS} before we roll back. */
export const MAX_UNSTABLE_BOOTS = 3;

// ── The privileged swap seam ───────────────────────────────────────────────────
//
// Must match setup/templates.ts (a test pins them together): drift here is a request nothing is
// watching for, and an update that silently does nothing.

/** The one directory the kiosk user may write into (0770 root:<kiosk>, created by tmpfiles.d). */
export const UPDATE_REQUEST_DIR = "/run/polyptic/requests";
/** The request the root-owned `polyptic-agent-update.path` unit watches for. */
export const UPDATE_REQUEST_PATH = join(UPDATE_REQUEST_DIR, "agent-update");
/** Where the agent stages the verified binary for the root side to install. A FIXED path: the
 *  request names no file, so there is nothing to point the privileged swap at. */
export const UPDATE_STAGE_PATH = join(UPDATE_REQUEST_DIR, "agent-update.bin");
/** Where the root side writes its answer: `ok` or `failed: <reason>`. */
export const UPDATE_RESULT_PATH = join(UPDATE_REQUEST_DIR, "agent-update.result");
/** How long the privileged swap gets to answer before we call it dead and stay on this binary. */
export const HELPER_TIMEOUT_MS = 180_000;

/** What the agent asks the privileged side to do. Three verbs, no arguments beyond a version. */
export type UpdateRequestAction = "swap" | "rollback" | "commit";

/** PURE — the request file's body: `key=value` lines, so a small shell script can read it safely. */
export function renderUpdateRequest(input: {
  action: UpdateRequestAction;
  version?: string;
  sha256?: string;
}): string {
  const lines = [`action=${input.action}`];
  if (input.version) lines.push(`version=${input.version}`);
  if (input.sha256) lines.push(`sha256=${input.sha256}`);
  return `${lines.join("\n")}\n`;
}

/** PURE — read the privileged side's answer. Anything unparseable is a failure with the raw text,
 *  because a swap we cannot confirm must never be reported as done. */
export function parseUpdateResult(raw: string): ApplyResult {
  const text = raw.trim();
  if (text === "ok" || text.startsWith("ok ")) return { ok: true };
  const detail = text.replace(/^failed:?\s*/i, "").trim();
  return { ok: false, reason: detail.length > 0 ? detail : "the privileged swap gave no answer" };
}

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
  // `v0.6.0` and `0.6.0` are one version — the server tags, the binary bakes the stripped form.
  if (!sameAgentVersion(marker.targetVersion, currentVersion)) return { kind: "none" };
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

// ── "Am I a replaceable single-file binary?" ───────────────────────────────────

/** Bun compiles sources into an embedded filesystem and mounts it under one of these roots, so every
 *  module URL inside a `--compile`d binary carries the marker and no source run ever does. */
const EMBEDDED_FS_MARKERS = ["/$bunfs/", "/~BUN/", "\\~BUN\\"];

/** PURE — does this module URL come from a compiled binary's embedded filesystem? */
export function isEmbeddedModuleUrl(moduleUrl: string): boolean {
  return EMBEDDED_FS_MARKERS.some((marker) => moduleUrl.includes(marker));
}

/**
 * Is this process a bun single-file executable — the thing a self-update can actually REPLACE?
 *
 * Answered from the embedded filesystem the compiler produced (see {@link isEmbeddedModuleUrl}),
 * with the baked version as a second, independent signal. It deliberately does NOT read
 * `POLYPTIC_BUILD_VERSION` off the environment: `--define` substitutes one literal expression at
 * compile time (see ./version.ts), so an env lookup through a parameter is never substituted, always
 * empty at runtime, and made every production box declare itself a "dev/source run" while cheerfully
 * reporting the version the very same define had baked in.
 */
export function isCompiledBinary(
  probe: { moduleUrl?: string; bakedVersion?: string } = {},
): boolean {
  const moduleUrl = probe.moduleUrl ?? import.meta.url;
  const baked = probe.bakedVersion ?? BAKED_AGENT_VERSION;
  return isEmbeddedModuleUrl(moduleUrl) || baked.trim().length > 0;
}

/** Everything {@link selfBinaryPath} looks at, injectable so tests never depend on how they run. */
export interface SelfBinaryProbe {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  moduleUrl?: string;
  bakedVersion?: string;
}

/**
 * The absolute path of the running binary to replace, or null when this process is NOT a compiled
 * single-file binary (a dev agent run from source). `POLYPTIC_AGENT_SELF_PATH` overrides it for
 * tests and for a hand-placed binary.
 */
export function selfBinaryPath(probe: SelfBinaryProbe = {}): string | null {
  const env = probe.env ?? process.env;
  const override = env.POLYPTIC_AGENT_SELF_PATH?.trim();
  if (override) return override;
  const compiled = isCompiledBinary({
    ...(probe.moduleUrl !== undefined ? { moduleUrl: probe.moduleUrl } : {}),
    ...(probe.bakedVersion !== undefined ? { bakedVersion: probe.bakedVersion } : {}),
  });
  if (!compiled) return null;
  return probe.execPath ?? process.execPath;
}

// ── Who performs the swap ──────────────────────────────────────────────────────

/** How this box replaces its own binary. `none` carries the reason the operator needs. */
export type SwapMode =
  | { kind: "direct" }
  | { kind: "helper" }
  | { kind: "none"; reason: string };

/**
 * PURE — pick the swap route. A box that can write the binary's own directory (a dev host, a
 * root-run agent) does it itself; a kiosk box hands the write to the root-owned helper; a box with
 * neither is told exactly what is missing, because "skipped" with no reason is what let this sit
 * broken for a fleet-year.
 */
export function chooseSwapMode(input: {
  binaryDirWritable: boolean;
  helperInstalled: boolean;
  binaryPath: string;
}): SwapMode {
  if (input.binaryDirWritable) return { kind: "direct" };
  if (input.helperInstalled) return { kind: "helper" };
  return {
    kind: "none",
    reason:
      `cannot write ${dirname(input.binaryPath)} and this box has no privileged update helper ` +
      `(${UPDATE_REQUEST_DIR} absent) — re-run \`polyptic-agent setup\` or rebuild the image`,
  };
}

/** What {@link planUpdate} decides to do with an offer. */
export type UpdatePlan =
  | { action: "skip"; reason: string }
  | { action: "apply"; binaryPath: string; swap: SwapMode & { kind: "direct" | "helper" } };

/**
 * PURE — should we act on this offer? Skips when the offer is not strictly newer, when this process
 * is not a compiled binary, when nothing on this box can write the binary, or when we already
 * attempted this exact target in this process.
 */
export function planUpdate(input: {
  currentVersion: string;
  offerVersion: string;
  binaryPath: string | null;
  swapMode: SwapMode;
  attemptedVersions: ReadonlySet<string>;
}): UpdatePlan {
  const { currentVersion, offerVersion, binaryPath, swapMode, attemptedVersions } = input;
  if (!isNewerAgentVersion(offerVersion, currentVersion)) {
    return { action: "skip", reason: `offer ${offerVersion} is not newer than ${currentVersion}` };
  }
  if (!binaryPath) {
    return { action: "skip", reason: "not running as a compiled binary (dev/source run)" };
  }
  if (attemptedVersions.has(offerVersion)) {
    return { action: "skip", reason: `already attempted ${offerVersion} this session` };
  }
  if (swapMode.kind === "none") {
    return { action: "skip", reason: swapMode.reason };
  }
  return { action: "apply", binaryPath, swap: swapMode };
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
  /** Write a small text file (the request for the privileged side). */
  writeText(path: string, text: string): Promise<void>;
  /** Wait for a file to appear and return its contents; null when it never does. */
  waitForText(path: string, timeoutMs: number): Promise<string | null>;
  /** Does this path exist? */
  exists(path: string): Promise<boolean>;
  /** May this process create files in `dir`? */
  dirWritable(dir: string): Promise<boolean>;
}

export type ApplyResult = { ok: true } | { ok: false; reason: string };

/** Where the download lands and how the verified binary becomes the live one. */
export interface SwapPlan {
  kind: "direct" | "helper";
  /** A path this UNPRIVILEGED process can actually write. */
  stagePath: string;
  /** Hand the verified staged binary over. Resolves ok, or a real reason the box stayed put. */
  swap(staged: string): Promise<ApplyResult>;
}

/**
 * The dev/root route: this process writes the binary itself. Stages beside the live binary so the
 * final step is a same-directory rename, and keeps `<bin>.bak` for the crash-loop rollback.
 */
export function directSwapPlan(binaryPath: string, io: UpdateIO): SwapPlan {
  return {
    kind: "direct",
    stagePath: `${binaryPath}.new`,
    async swap(staged) {
      // Copy (not rename) the backup so the live binary is never momentarily absent.
      await io.copy(binaryPath, `${binaryPath}.bak`).catch(() => {}); // best-effort; the swap is the point
      await io.rename(staged, binaryPath);
      return { ok: true };
    },
  };
}

/**
 * The kiosk route: the unprivileged agent stages the binary in the one directory it may write, drops
 * a request, and waits for the root-owned unit's answer. The agent never learns a privileged path and
 * the helper never takes one — both ends are the fixed constants above.
 */
export function helperSwapPlan(
  opts: { targetVersion: string; sha256?: string; timeoutMs?: number },
  io: UpdateIO,
  paths: { request?: string; stage?: string; result?: string } = {},
): SwapPlan {
  const request = paths.request ?? UPDATE_REQUEST_PATH;
  const stage = paths.stage ?? UPDATE_STAGE_PATH;
  const result = paths.result ?? UPDATE_RESULT_PATH;
  return {
    kind: "helper",
    stagePath: stage,
    async swap() {
      // A stale answer from an earlier attempt must never be read as this one's.
      await io.remove(result);
      await io.writeText(
        request,
        renderUpdateRequest({
          action: "swap",
          version: opts.targetVersion,
          ...(opts.sha256 ? { sha256: opts.sha256 } : {}),
        }),
      );
      const answer = await io.waitForText(result, opts.timeoutMs ?? HELPER_TIMEOUT_MS);
      await io.remove(result);
      if (answer === null) {
        await io.remove(request);
        return {
          ok: false,
          reason: `the privileged update helper did not answer within ${Math.round(
            (opts.timeoutMs ?? HELPER_TIMEOUT_MS) / 1000,
          )}s`,
        };
      }
      return parseUpdateResult(answer);
    },
  };
}

/**
 * Ask the privileged side for a `rollback` (restore `<bin>.bak`) or a `commit` (drop `<bin>.bak`,
 * the update having proved itself). Both are fire-and-forget: the answer is read when present, and
 * a helper that says nothing leaves the box exactly as it was.
 */
export async function requestHelperAction(
  action: "rollback" | "commit",
  io: UpdateIO,
  opts: { timeoutMs?: number } = {},
  paths: { request?: string; result?: string } = {},
): Promise<ApplyResult> {
  const request = paths.request ?? UPDATE_REQUEST_PATH;
  const result = paths.result ?? UPDATE_RESULT_PATH;
  await io.remove(result);
  await io.writeText(request, renderUpdateRequest({ action }));
  const answer = await io.waitForText(result, opts.timeoutMs ?? HELPER_TIMEOUT_MS);
  await io.remove(result);
  if (answer === null) {
    await io.remove(request);
    return { ok: false, reason: `the privileged update helper did not answer the ${action}` };
  }
  return parseUpdateResult(answer);
}

/**
 * Download, verify, and swap in the new binary, keeping the old one at `<bin>.bak`. Does NOT exit the
 * process (the caller does, so it can send its status frame first). Every failure leaves the LIVE
 * binary untouched and cleans up the staged file — a bad update can never strand the box.
 */
export async function applyUpdate(
  opts: {
    url: string;
    targetVersion: string;
    sha256?: string;
    sizeBytes?: number;
  },
  io: UpdateIO,
  plan: SwapPlan,
  hooks: { onPhase?: (phase: "downloading" | "verifying" | "swapping") => void } = {},
): Promise<ApplyResult> {
  const staged = plan.stagePath;
  const phase = (p: "downloading" | "verifying" | "swapping"): void => hooks.onPhase?.(p);
  try {
    phase("downloading");
    await io.remove(staged); // a leftover from an interrupted attempt
    const written = await io.download(opts.url, staged);
    if (written <= 0) return fail(io, staged, "download wrote zero bytes");
    if (opts.sizeBytes !== undefined && written !== opts.sizeBytes) {
      return fail(io, staged, `size mismatch: got ${written} bytes, expected ${opts.sizeBytes}`);
    }
    phase("verifying");
    const gotSize = await io.size(staged);
    if (gotSize <= 0) return fail(io, staged, "downloaded file is empty");
    if (opts.sha256) {
      const got = (await io.sha256(staged)).toLowerCase();
      if (got !== opts.sha256.toLowerCase()) {
        return fail(io, staged, `sha256 mismatch: got ${got}, expected ${opts.sha256}`);
      }
    }
    await io.makeExecutable(staged);
    // The decisive guard: the new binary must actually RUN and report the version we were promised.
    // A wrong-arch, truncated, or incompatible binary fails here and never becomes the live binary.
    let reported: string;
    try {
      reported = await io.selfCheck(staged);
    } catch (err) {
      return fail(io, staged, `self-check failed to run: ${(err as Error).message}`);
    }
    // Compare NORMALISED: the server offers the release tag (`v0.6.0`), the binary bakes `0.6.0`.
    if (!sameAgentVersion(reported, opts.targetVersion)) {
      return fail(
        io,
        staged,
        `self-check version mismatch: binary reports "${reported.trim()}", expected "${opts.targetVersion}"`,
      );
    }
    phase("swapping");
    const swapped = await plan.swap(staged);
    if (!swapped.ok) return fail(io, staged, swapped.reason);
    await io.remove(staged); // the helper consumes it, but a direct swap's rename already moved it
    return { ok: true };
  } catch (err) {
    return fail(io, staged, (err as Error).message);
  }
}

async function fail(io: UpdateIO, staged: string, reason: string): Promise<ApplyResult> {
  await io.remove(staged);
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
    async writeText(path, text) {
      await writeFile(path, text, { mode: 0o644 });
    },
    async waitForText(path, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const raw = await readFile(path, "utf8");
          if (raw.trim().length > 0) return raw;
        } catch {
          // not there yet
        }
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    async exists(path) {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    async dirWritable(dir) {
      try {
        await access(dir, fsConstants.W_OK | fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Which route this box has for replacing its binary, probed once per offer. Never throws. */
export async function detectSwapMode(binaryPath: string, io: UpdateIO): Promise<SwapMode> {
  const [binaryDirWritable, helperInstalled] = await Promise.all([
    io.dirWritable(dirname(binaryPath)),
    io.exists(UPDATE_REQUEST_DIR),
  ]);
  return chooseSwapMode({ binaryDirWritable, helperInstalled, binaryPath });
}

// ── Marker persistence ─────────────────────────────────────────────────────────

/**
 * Where the crash-loop marker lives: the agent's own state directory, beside the credential. NOT a
 * sibling of the binary — that directory is root-owned on every real box, so every marker write
 * there failed silently and the rollback guard was never armed.
 */
export function markerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "agent-update.json");
}

export async function readMarker(): Promise<UpdateMarker | null> {
  try {
    const raw = await readFile(markerPath(), "utf8");
    const m = JSON.parse(raw) as UpdateMarker;
    if (typeof m.targetVersion === "string" && typeof m.boots === "number") return m;
    return null;
  } catch {
    return null;
  }
}

export async function writeMarker(marker: UpdateMarker): Promise<void> {
  const path = markerPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => {});
  await writeFile(path, JSON.stringify(marker), "utf8");
}

export async function clearMarker(): Promise<void> {
  await rm(markerPath(), { force: true }).catch(() => {});
}

/**
 * Restore `<bin>.bak` over the live binary (the crash-loop rollback), by whichever route this box
 * has. Returns false when there is no backup to restore or the privileged side refused — then the
 * caller can only keep limping on the current binary, and says so.
 */
export async function rollbackToBackup(
  binaryPath: string,
  mode: SwapMode,
  io: UpdateIO,
): Promise<boolean> {
  if (mode.kind === "helper") {
    const res = await requestHelperAction("rollback", io);
    return res.ok;
  }
  if (mode.kind === "none") return false;
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

/** Drop `<bin>.bak` once an update has proved itself, by whichever route this box has. */
export async function dropBackup(binaryPath: string, mode: SwapMode, io: UpdateIO): Promise<void> {
  if (mode.kind === "helper") {
    await requestHelperAction("commit", io).catch(() => {});
    return;
  }
  if (mode.kind === "none") return;
  await rm(`${binaryPath}.bak`, { force: true }).catch(() => {});
}
