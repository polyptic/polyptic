/**
 * OTA (POL-28) — the agent's UNPRIVILEGED A/B self-update.
 *
 * The kiosk agent keeps its binaries under a kiosk-writable slot tree so a swap never needs root:
 *
 *   ${OTA_ROOT}/
 *     versions/<version>/polyptic-agent   the binary for a version (mode 0755)
 *     current  -> versions/<version>       symlink the systemd unit's ExecStart points at (frozen unit)
 *     previous -> versions/<oldversion>     the retained slot to roll back to
 *     confirm.json                          the confirm marker { version, deadlineMs }
 *     last-rollback.json                    breadcrumb left by the rollback guard, reported once
 *     tmp/                                  download staging
 *
 * An update: download → verify sha256 → write into versions/<target> → flip `current` (recording the
 * old one as `previous`) → write a confirm marker → reboot. On the trial boot the new agent, once it
 * has reconnected + been healthy for a stability window, CLEARS the marker (commit). A standalone
 * systemd user timer runs `polyptic-agent rollback-check` ~5 min after the session starts: if a
 * past-deadline marker persists (the new agent crash-looped / never committed) it reverts
 * current→previous and reboots — this is what makes a bad build self-heal even when the new agent can't
 * run. OTA only ever flips symlinks + drops version dirs in this tree; the systemd unit is never
 * rewritten. Rollback prefers a retained local slot over re-downloading.
 *
 * The filesystem work here is real (tests drive it against a temp dir); only the NETWORK, REBOOT and
 * CLOCK are behind the {@link OtaSys} seam so the update flow is unit-testable without a box.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import type { AgentArch } from "@polyptic/protocol";

import { stateDir } from "./credential";

export const AGENT_BIN_NAME = "polyptic-agent";

/** Root of the OTA slot tree. `POLYPTIC_OTA_DIR` overrides `${stateDir()}/agent` (kiosk-writable). */
export function otaRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.POLYPTIC_OTA_DIR?.trim();
  if (override && override.length > 0) return override;
  return join(stateDir(env), "agent");
}

/** The build arch this process runs on, mapped to the depot's arch names. */
export function currentArch(): AgentArch {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

export interface SlotPaths {
  root: string;
  versionsDir: string;
  currentLink: string;
  previousLink: string;
  markerPath: string;
  rollbackPath: string;
  tmpDir: string;
}

export function slotPaths(root: string): SlotPaths {
  return {
    root,
    versionsDir: join(root, "versions"),
    currentLink: join(root, "current"),
    previousLink: join(root, "previous"),
    markerPath: join(root, "confirm.json"),
    rollbackPath: join(root, "last-rollback.json"),
    tmpDir: join(root, "tmp"),
  };
}

/** Absolute path of a version's binary. */
export function slotBin(root: string, version: string): string {
  return join(root, "versions", version, AGENT_BIN_NAME);
}

export interface ConfirmMarker {
  version: string;
  deadlineMs: number;
}

export interface RollbackBreadcrumb {
  revertedFrom: string;
  revertedTo: string;
  at: number;
}

// ── marker + breadcrumb ─────────────────────────────────────────────────────────

export function readMarker(root: string): ConfirmMarker | null {
  return readJson<ConfirmMarker>(slotPaths(root).markerPath, (v) =>
    typeof v?.version === "string" && typeof v?.deadlineMs === "number"
      ? { version: v.version, deadlineMs: v.deadlineMs }
      : null,
  );
}

export function writeMarker(root: string, marker: ConfirmMarker): void {
  const p = slotPaths(root);
  ensureDir(p.root);
  writeFileSync(p.markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o644 });
}

export function clearMarker(root: string): void {
  rmSync(slotPaths(root).markerPath, { force: true });
}

export function readRollbackBreadcrumb(root: string): RollbackBreadcrumb | null {
  return readJson<RollbackBreadcrumb>(slotPaths(root).rollbackPath, (v) =>
    typeof v?.revertedFrom === "string" && typeof v?.revertedTo === "string" && typeof v?.at === "number"
      ? { revertedFrom: v.revertedFrom, revertedTo: v.revertedTo, at: v.at }
      : null,
  );
}

export function writeRollbackBreadcrumb(root: string, crumb: RollbackBreadcrumb): void {
  const p = slotPaths(root);
  ensureDir(p.root);
  writeFileSync(p.rollbackPath, `${JSON.stringify(crumb)}\n`, { mode: 0o644 });
}

export function clearRollbackBreadcrumb(root: string): void {
  rmSync(slotPaths(root).rollbackPath, { force: true });
}

// ── slot inspection ─────────────────────────────────────────────────────────────

/** The version the `current` symlink points at (basename of its target), or null. */
export function currentVersion(root: string): string | null {
  return linkVersion(slotPaths(root).currentLink);
}

export function previousVersion(root: string): string | null {
  return linkVersion(slotPaths(root).previousLink);
}

/** Version dirs that actually hold a binary. */
export function stagedVersions(root: string): string[] {
  const dir = slotPaths(root).versionsDir;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => isFile(slotBin(root, n)));
}

export function hasStagedVersion(root: string, version: string): boolean {
  return isFile(slotBin(root, version));
}

// ── slot mutation ───────────────────────────────────────────────────────────────

/**
 * Seed the slot tree from a binary already installed on the box (setup calls this with the freshly
 * installed `/usr/local/bin/polyptic-agent`). Idempotent: copies the binary into versions/<version>
 * if absent and points `current` at it only when there is no current yet (so it never clobbers a
 * live OTA state on a setup re-run).
 */
export function seedSlot(root: string, version: string, sourceBinary: string): void {
  const dest = slotBin(root, version);
  ensureDir(join(root, "versions", version));
  if (!isFile(dest)) {
    copyFileSync(sourceBinary, dest);
    chmodSync(dest, 0o755);
  }
  if (currentVersion(root) === null) {
    setLink(slotPaths(root).currentLink, join("versions", version));
  }
}

/** Move a verified binary at `verifiedPath` into versions/<version> and flip `current` to it. */
export function installSlot(root: string, version: string, verifiedPath: string): void {
  const dest = slotBin(root, version);
  ensureDir(join(root, "versions", version));
  // Move within the tree when possible (same filesystem); fall back to copy.
  try {
    renameSync(verifiedPath, dest);
  } catch {
    copyFileSync(verifiedPath, dest);
    rmSync(verifiedPath, { force: true });
  }
  chmodSync(dest, 0o755);
  flipTo(root, version);
}

/** Flip `current` → versions/<version>, recording the old current as `previous`. No-op if already current. */
export function flipTo(root: string, version: string): void {
  const p = slotPaths(root);
  const curTarget = linkTargetRaw(p.currentLink);
  if (curTarget !== null && basename(curTarget) === version) return; // already current
  if (curTarget !== null) setLink(p.previousLink, curTarget);
  setLink(p.currentLink, join("versions", version));
}

/** Keep only the `current` + `previous` version dirs; drop the rest (retain exactly 2 slots). */
export function pruneSlots(root: string): void {
  const keep = new Set([currentVersion(root), previousVersion(root)].filter((v): v is string => !!v));
  const dir = slotPaths(root).versionsDir;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (keep.has(n)) continue;
    rmSync(join(dir, n), { recursive: true, force: true });
  }
}

// ── the update flow (network/reboot/clock behind OtaSys) ─────────────────────────

/** The side-effecting seam: network, sha256, reboot, clock. Faked in tests. */
export interface OtaSys {
  now(): number;
  /** Download `url` to `dest` (overwriting). Throws on any failure. */
  download(url: string, dest: string): Promise<void>;
  /** sha256 hex digest of a file. */
  sha256(path: string): Promise<string>;
  /** Reboot the box (best-effort; never returns meaningfully). */
  reboot(): void;
}

export interface UpdatePlan {
  targetVersion: string;
  /** The arch's artifact from the offer (sha256[+size]); absent for a rollback/retained-slot offer. */
  artifact?: { sha256: string; size?: number };
  /** Where to fetch the binary from when it isn't already staged locally. */
  downloadUrl: string;
  /** Grace period the trial boot has to commit before the standalone guard reverts (ms). */
  confirmWindowMs: number;
}

export type UpdateResult =
  | { ok: true; version: string; usedLocalSlot: boolean }
  | { ok: false; error: string };

/**
 * Stage `plan.targetVersion` into the slot tree and arm the confirm marker (the CALLER reboots after a
 * success). Prefers a retained, already-verified local slot (covers rollback + re-offers) over a
 * download. On a download it verifies the sha256 before the binary is ever placed; a mismatch aborts
 * with the old `current` untouched.
 */
export async function performUpdate(
  root: string,
  sys: OtaSys,
  plan: UpdatePlan,
): Promise<UpdateResult> {
  const { targetVersion, artifact, downloadUrl, confirmWindowMs } = plan;

  // 1 ─ already have a verified slot for the target → just activate it (no download).
  if (hasStagedVersion(root, targetVersion)) {
    flipTo(root, targetVersion);
    armMarker(root, sys, targetVersion, confirmWindowMs);
    pruneSlots(root);
    return { ok: true, version: targetVersion, usedLocalSlot: true };
  }

  // 2 ─ otherwise we must download + verify. A rollback offer with no local slot and no artifact fails.
  if (!artifact) {
    return { ok: false, error: `no retained slot for ${targetVersion} and no download artifact` };
  }

  const p = slotPaths(root);
  ensureDir(p.tmpDir);
  const tmp = join(p.tmpDir, `${targetVersion}.download`);
  try {
    await sys.download(downloadUrl, tmp);
  } catch (err) {
    rmSync(tmp, { force: true });
    return { ok: false, error: `download failed: ${(err as Error).message}` };
  }

  let digest: string;
  try {
    digest = await sys.sha256(tmp);
  } catch (err) {
    rmSync(tmp, { force: true });
    return { ok: false, error: `checksum read failed: ${(err as Error).message}` };
  }
  if (digest !== artifact.sha256) {
    rmSync(tmp, { force: true });
    return { ok: false, error: `checksum mismatch (got ${digest.slice(0, 12)}…, want ${artifact.sha256.slice(0, 12)}…)` };
  }

  installSlot(root, targetVersion, tmp);
  armMarker(root, sys, targetVersion, confirmWindowMs);
  pruneSlots(root);
  return { ok: true, version: targetVersion, usedLocalSlot: false };
}

/**
 * The standalone rollback guard (run by `polyptic-agent rollback-check`). If a confirm marker is past
 * its deadline AND we are still running the version it was staged for (i.e. that trial boot never
 * committed), revert `current` → `previous`, drop a breadcrumb, and return it (the caller reboots). A
 * stale marker (already reverted, or no previous to fall back to) is cleared without reverting.
 */
export function rollbackIfExpired(root: string, nowMs: number): RollbackBreadcrumb | null {
  const marker = readMarker(root);
  if (!marker) return null;
  if (nowMs < marker.deadlineMs) return null; // trial still within its grace period

  const cur = currentVersion(root);
  if (cur !== marker.version) {
    // Current isn't the version the marker guarded (already rolled back, or an unrelated boot) — the
    // marker is stale; clear it so it can't fire again.
    clearMarker(root);
    return null;
  }

  const prev = previousVersion(root);
  if (!prev || prev === cur) {
    // Nothing to fall back to (first-ever version) — the box can't roll back below it. Clear + give up.
    clearMarker(root);
    return null;
  }

  flipTo(root, prev); // current → previous
  clearMarker(root);
  const crumb: RollbackBreadcrumb = { revertedFrom: cur, revertedTo: prev, at: nowMs };
  writeRollbackBreadcrumb(root, crumb);
  return crumb;
}

// ── internals ───────────────────────────────────────────────────────────────────

function armMarker(root: string, sys: OtaSys, version: string, confirmWindowMs: number): void {
  writeMarker(root, { version, deadlineMs: sys.now() + confirmWindowMs });
}

/** basename of a symlink's target if it points into versions/, else null. */
function linkVersion(link: string): string | null {
  const target = linkTargetRaw(link);
  return target === null ? null : basename(target);
}

function linkTargetRaw(link: string): string | null {
  try {
    return readlinkSync(link);
  } catch {
    return null;
  }
}

/** Atomically (re)point a symlink at `target` (relative to the link's dir). */
function setLink(link: string, target: string): void {
  const tmp = `${link}.tmp`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link); // atomic replace
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readJson<T>(path: string, coerce: (v: any) => T | null): T | null {
  try {
    return coerce(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}
