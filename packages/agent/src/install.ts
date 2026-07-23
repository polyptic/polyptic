/**
 * Install-to-disk (POL-176) — the agent's half of turning a netbooted box into an installed one.
 *
 * The agent stays UNPRIVILEGED (D7). Like the POL-55 reboot, the privilege lives in a root-owned
 * systemd pair the image ships: the agent writes ONE request file (`/run/polyptic/requests/install`,
 * a single `device=/dev/sdX` line) into the one directory the kiosk user may write, and the root
 * installer takes it from there — wipes the disk, lays down A/B slots + the ESP, fetches the image,
 * writes the loader and the boot entry, and reports `installed` over /boot/report. There is no
 * command to inject and no argument beyond a device path the installer RE-VALIDATES itself.
 *
 * TRUST MODEL, in order: the operator's explicit confirm in the console (the modal names the disk),
 * the server's re-check against the box's reported inventory, the agent's own validation here
 * (a live box, a known non-removable disk), and finally the root unit's re-validation. Each layer
 * assumes the one above it is compromised.
 *
 * What the agent adds on top of the hand-over is NARRATION: the installer appends
 * `<phase>|<percent>|<detail>` lines to `/run/polyptic/install-status` (0644, truncated at start),
 * and the agent tails that file, forwarding each NEW line as `agent/install-status` — so the
 * operator watches the wipe they authorised instead of a spinner.
 *
 * Everything parseable is a PURE function (the repo's testability idiom — see vitals.ts).
 */
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { BootMode, InstallPhase, MachineDisk } from "@polyptic/protocol";
import { InstallPhase as InstallPhaseSchema } from "@polyptic/protocol";

/** Same directory as the POL-55 reboot request — root-owned, group-writable by the kiosk user. */
export const INSTALL_REQUEST_DIR = "/run/polyptic/requests";
/** The file whose creation the root installer's .path unit watches for. */
export const INSTALL_REQUEST_PATH = join(INSTALL_REQUEST_DIR, "install");
/** Where the root installer narrates its progress (0644, truncated at installer start). */
export const INSTALL_STATUS_PATH = "/run/polyptic/install-status";
/** Where the root update poll records running vs staged image ids on an installed box (0644). */
export const UPDATE_STATE_PATH = "/run/polyptic/update-state";

/** How often the agent polls the status file while an install runs. */
export const INSTALL_POLL_MS = 1_000;
/** An installer that has said nothing terminal after this long is abandoned (the box may have
 *  died mid-wipe; the operator sees the last phase it reached). */
export const INSTALL_TAIL_TIMEOUT_MS = 30 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsers (the unit-tested surface)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POL-176 — HOW this box is running its OS, from its kernel cmdline. `installed` when the cmdline
 * carries `polyptic.bootpath=disk`; `live` on any other box with a Polyptic identity — a
 * `polyptic.*` cmdline parameter (netboot/local chains), a `root=live:` fetch, or a stamped
 * /etc/polyptic/image-id (`hasImageId`). A box with NEITHER (a dev laptop, a hand-rolled Linux
 * host) gets `undefined`: an absent mode is "not a fleet box", never a guess, and the console
 * shows nothing for it.
 */
export function bootModeFromCmdline(cmdline: string | null, hasImageId: boolean): BootMode | undefined {
  if (cmdline === null) return hasImageId ? "live" : undefined;
  const params = cmdline.trim().split(/\s+/);
  if (params.includes("polyptic.bootpath=disk")) return "installed";
  const isPolyptic =
    hasImageId || params.some((p) => p.startsWith("polyptic.") || p.startsWith("root=live:"));
  return isPolyptic ? "live" : undefined;
}

/** The subset of `lsblk -J` output we read. Everything is optional/loose: lsblk's JSON varies by
 *  version and we drop what we cannot read rather than failing the inventory. */
interface LsblkNode {
  name?: unknown;
  type?: unknown;
  size?: unknown;
  model?: unknown;
  rm?: unknown;
  fstype?: unknown;
  label?: unknown;
  children?: unknown;
}

/** lsblk's `rm` is a bool in modern JSON output but "0"/"1" strings in older ones. */
function truthyRm(rm: unknown): boolean {
  return rm === true || rm === 1 || rm === "1" || rm === "true";
}

/** Compose the short human summary of what is on a disk ("ext4 (Ubuntu 24.04), ntfs" / "empty")
 *  from its own fstype and its children's fstype/label. Deduped, order-preserving. */
function summariseContents(node: LsblkNode): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (fstype: unknown, label: unknown): void => {
    if (typeof fstype !== "string" || fstype.trim() === "") return;
    const text =
      typeof label === "string" && label.trim() !== ""
        ? `${fstype} (${label.trim()})`
        : fstype;
    if (seen.has(text)) return;
    seen.add(text);
    parts.push(text);
  };
  add(node.fstype, node.label);
  const walk = (children: unknown): void => {
    if (!Array.isArray(children)) return;
    for (const child of children as LsblkNode[]) {
      add(child?.fstype, child?.label);
      walk(child?.children);
    }
  };
  walk(node.children);
  return parts.length > 0 ? parts.join(", ") : "empty";
}

/**
 * Parse `lsblk -J -b -o NAME,TYPE,SIZE,MODEL,RM,FSTYPE,LABEL` into the wire's disk inventory.
 * Only top-level `type == "disk"` nodes count (partitions ride in as `contents`); zram and loop
 * devices are excluded — RAM compression and squashfs mounts are not install targets. Returns
 * `null` when the JSON does not parse at all (the caller then omits `disks` — unknown, not empty).
 */
export function parseLsblkDisks(json: string): MachineDisk[] | null {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  const devices = (root as { blockdevices?: unknown })?.blockdevices;
  if (!Array.isArray(devices)) return null;

  const disks: MachineDisk[] = [];
  for (const node of devices as LsblkNode[]) {
    if (node?.type !== "disk") continue;
    const name = typeof node.name === "string" ? node.name : "";
    if (name === "" || name.startsWith("zram") || name.startsWith("loop")) continue;
    const size = typeof node.size === "number" ? node.size : Number(node.size);
    if (!Number.isFinite(size) || size < 0) continue;
    const model = typeof node.model === "string" ? node.model.trim() : "";
    disks.push({
      device: name.startsWith("/dev/") ? name : `/dev/${name}`,
      sizeBytes: size,
      ...(model !== "" ? { model } : {}),
      removable: truthyRm(node.rm),
      contents: summariseContents(node),
    });
  }
  return disks;
}

/** Parse `/run/polyptic/update-state` (`running=<id>` / `staged=<id>` lines, one each). Unknown
 *  lines are ignored; a malformed file simply yields nothing — absence of a claim, never a guess. */
export function parseUpdateState(text: string): { running?: string; staged?: string } {
  const out: { running?: string; staged?: string } = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (value === "") continue;
    if (key === "running" && out.running === undefined) out.running = value;
    if (key === "staged" && out.staged === undefined) out.staged = value;
  }
  return out;
}

/** One parsed install-status line, ready for the wire. */
export interface InstallStatusLine {
  phase: InstallPhase;
  percent?: number;
  detail?: string;
}

/**
 * Parse one `<phase>|<percent>|<detail>` line of `/run/polyptic/install-status`. `percent` is
 * 0–100 or `-` (unknown → omitted); the detail may itself contain `|` (only the first two splits
 * are structural). Returns `null` for a line that is not a status line at all (an unknown phase,
 * a torn write) — the tailer skips it rather than forwarding garbage.
 */
export function parseInstallStatusLine(line: string): InstallStatusLine | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const first = trimmed.indexOf("|");
  if (first < 0) return null;
  const second = trimmed.indexOf("|", first + 1);
  const phaseRaw = trimmed.slice(0, first);
  const percentRaw = second < 0 ? trimmed.slice(first + 1) : trimmed.slice(first + 1, second);
  const detailRaw = second < 0 ? "" : trimmed.slice(second + 1);

  const phase = InstallPhaseSchema.safeParse(phaseRaw);
  if (!phase.success) return null;

  const out: InstallStatusLine = { phase: phase.data };
  if (percentRaw !== "-" && percentRaw.trim() !== "") {
    const n = Number(percentRaw);
    if (Number.isFinite(n)) out.percent = Math.max(0, Math.min(100, n));
  }
  const detail = detailRaw.trim();
  if (detail !== "") out.detail = detail;
  return out;
}

/** True once the installer has said its last word: the tail stops on either. */
export function isTerminalPhase(phase: InstallPhase): boolean {
  return phase === "done" || phase === "failed";
}

/**
 * Why this agent may not hand `device` to the installer, or `null` when it may. Pure, like
 * host.ts's `rebootRefusal`: every gate is a legible sentence the console can show verbatim.
 * The bootMode gate is load-bearing — installing over the disk an INSTALLED box is running from
 * would saw off the branch it sits on; only a live (all-in-RAM) box can safely wipe a disk.
 */
export function installRefusal(
  device: string,
  bootMode: BootMode | undefined,
  disks: readonly MachineDisk[] | undefined,
): string | null {
  if (bootMode !== "live") {
    return bootMode === "installed"
      ? "this box already runs from its internal disk — nothing to install"
      : "this box did not boot a Polyptic live image, so there is nothing to install from";
  }
  const disk = disks?.find((d) => d.device === device);
  if (!disk) {
    return `${device} is not a disk this box reported — refusing to touch it`;
  }
  if (disk.removable) {
    return `${device} is removable media — the OS installs to an internal disk only`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot facts (gathered on connect; cheap enough to refresh on reconnect)
// ─────────────────────────────────────────────────────────────────────────────

export interface BootFacts {
  bootMode?: BootMode;
  disks?: MachineDisk[];
  stagedImageId?: string;
}

export interface BootFactsOptions {
  cmdlinePath?: string;
  imageIdPath?: string;
  updateStatePath?: string;
  /** Injectable lsblk runner, so tests never shell out. Resolves to the JSON, or null. */
  runLsblk?: () => Promise<string | null>;
  platform?: string;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function defaultRunLsblk(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "lsblk",
      ["-J", "-b", "-o", "NAME,TYPE,SIZE,MODEL,RM,FSTYPE,LABEL"],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/** The staged image id, read fresh (the update poll rewrites the file at runtime). Exposed for the
 *  heartbeat's vitals as well as the hello. */
export async function readStagedImageId(path: string = UPDATE_STATE_PATH): Promise<string | undefined> {
  const text = await readOrNull(path);
  if (text === null) return undefined;
  return parseUpdateState(text).staged;
}

/**
 * Gather what this box knows about HOW it boots and WHAT it could install to. Non-Linux hosts (and
 * any read that fails) simply omit fields — the hello then says nothing, which the console renders
 * as nothing. Never throws.
 */
export async function readBootFacts(opts: BootFactsOptions = {}): Promise<BootFacts> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return {};

  const facts: BootFacts = {};

  const imageIdPath = opts.imageIdPath ?? "/etc/polyptic/image-id";
  let hasImageId = false;
  try {
    hasImageId = (await stat(imageIdPath)).isFile();
  } catch {
    // no live-image stamp — a dev box, or an agent running outside the image
  }
  const cmdline = await readOrNull(opts.cmdlinePath ?? "/proc/cmdline");
  const bootMode = bootModeFromCmdline(cmdline, hasImageId);
  if (bootMode) facts.bootMode = bootMode;

  const lsblkJson = await (opts.runLsblk ?? defaultRunLsblk)();
  if (lsblkJson !== null) {
    const disks = parseLsblkDisks(lsblkJson);
    if (disks !== null) facts.disks = disks;
  }

  const staged = await readStagedImageId(opts.updateStatePath ?? UPDATE_STATE_PATH);
  if (staged !== undefined) facts.stagedImageId = staged;

  return facts;
}

// ─────────────────────────────────────────────────────────────────────────────
// The hand-over + the tail
// ─────────────────────────────────────────────────────────────────────────────

export interface InstallRequestOutcome {
  accepted: boolean;
  reason?: string;
}

/**
 * Write the install request file for the root installer (the POL-55 escalation pattern: creating
 * ONE file in the one kiosk-writable directory, whose only possible meaning is "install to this
 * disk"). The caller has already validated `device` via {@link installRefusal}. Never throws.
 */
export function requestInstall(
  device: string,
  paths: { dir?: string; file?: string } = {},
): InstallRequestOutcome {
  const dir = paths.dir ?? INSTALL_REQUEST_DIR;
  const file = paths.file ?? INSTALL_REQUEST_PATH;
  if (!existsSync(dir)) {
    return {
      accepted: false,
      reason: `no privileged install helper on this box (${dir} absent) — is this a POL-176 image?`,
    };
  }
  try {
    writeFileSync(file, `device=${device}\n`);
    return { accepted: true, reason: `requested via ${file}` };
  } catch (err) {
    return { accepted: false, reason: `cannot write ${file}: ${(err as Error).message}` };
  }
}

export interface InstallTailerOptions {
  statusPath?: string;
  pollMs?: number;
  timeoutMs?: number;
  /** Injectable reader, for tests. */
  read?: (path: string) => Promise<string | null>;
}

/**
 * Tail `/run/polyptic/install-status`, forwarding each NEW parsed line to `onLine`, until a
 * terminal line (`done`/`failed`) or the timeout. Handles the installer TRUNCATING/recreating the
 * file at start (content shorter than what we already forwarded → start over from the top).
 * Byte-offset-free by design: the file is small (a few dozen short lines), so re-reading it whole
 * each poll and diffing on LINE COUNT is simpler and survives torn reads of the last line.
 */
export function tailInstallStatus(
  onLine: (line: InstallStatusLine) => void,
  onEnd: (why: "done" | "failed" | "timeout") => void,
  opts: InstallTailerOptions = {},
): { stop(): void } {
  const statusPath = opts.statusPath ?? INSTALL_STATUS_PATH;
  const pollMs = opts.pollMs ?? INSTALL_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? INSTALL_TAIL_TIMEOUT_MS;
  const read = opts.read ?? readOrNull;

  let forwarded = 0; // complete lines already sent
  let stopped = false;
  const startedAt = Date.now();

  const finish = (why: "done" | "failed" | "timeout"): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    onEnd(why);
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (Date.now() - startedAt > timeoutMs) {
      finish("timeout");
      return;
    }
    const text = await read(statusPath);
    if (stopped || text === null) return; // not created yet (or vanished) — keep waiting
    // Only COMPLETE lines count: the installer appends, and the last line may be mid-write.
    // (A trailing "\n" leaves an empty final element; without one the final element is the torn
    // line — either way the last array entry is not a forwardable line yet.)
    const complete = text.split("\n").slice(0, -1);
    // Truncation/recreate: fewer complete lines than we forwarded means a fresh file.
    if (complete.length < forwarded) forwarded = 0;
    for (let i = forwarded; i < complete.length; i++) {
      forwarded = i + 1;
      const parsed = parseInstallStatusLine(complete[i] ?? "");
      if (!parsed) continue;
      onLine(parsed);
      if (isTerminalPhase(parsed.phase)) {
        finish(parsed.phase === "done" ? "done" : "failed");
        return;
      }
    }
  };

  const timer = setInterval(() => void poll(), pollMs);
  // A Node/Bun timer must not keep a dying agent alive.
  (timer as { unref?: () => void }).unref?.();
  void poll();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
