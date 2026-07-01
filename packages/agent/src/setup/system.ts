/**
 * System primitives for the setup provisioner: command execution + filesystem mutation that are
 * idempotent and dry-run aware. No new npm deps — only node builtins (D7: the agent stays a single
 * self-contained binary).
 *
 * Two execution modes keep `--dry-run` honest:
 *   - `probe()`  — READ-ONLY commands (which/getent/dpkg-query/readlink). Always run, even in dry-run,
 *                  so detection/idempotency decisions are real. Never throws.
 *   - `exec()`   — MUTATING commands. In dry-run they are logged (`[plan] would run: …`) and skipped.
 *
 * File writes are idempotent: identical content is a skip; a foreign pre-existing file is backed up
 * once to `<path>.pre-polyptic` (so `setup --uninstall` can restore it).
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import type { Logger } from "./log";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Human description; logged before running (or as the dry-run plan). */
  desc?: string;
  /** Return the failing result instead of throwing. */
  allowFail?: boolean;
  /** Optional stdin. */
  input?: string;
  /** Extra env on top of the inherited environment. */
  env?: Record<string, string>;
}

export interface WriteOptions {
  mode?: number;
  owner?: string;
  group?: string;
  /** Friendlier name used in logs (defaults to the path). */
  desc?: string;
  /** Back up a pre-existing (foreign) file to `<path>.pre-polyptic` before overwriting. */
  backupOriginal?: boolean;
}

/** Suffix used to preserve a file's pre-Polyptic contents for `--uninstall` restore. */
export const PRE_BACKUP_SUFFIX = ".pre-polyptic";

function bufToStr(b: Buffer | string | undefined | null): string {
  if (b == null) return "";
  return typeof b === "string" ? b : b.toString("utf8");
}

export class Sys {
  constructor(
    readonly dryRun: boolean,
    readonly log: Logger,
  ) {}

  // ── identity / detection ─────────────────────────────────────────────────────

  isRoot(): boolean {
    return typeof process.getuid === "function" ? process.getuid() === 0 : false;
  }

  /** Resolve a binary on PATH (read-only; works in dry-run). */
  which(bin: string): string | null {
    const path =
      process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    for (const dir of path.split(":")) {
      if (!dir) continue;
      const full = `${dir}/${bin}`;
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        // keep looking
      }
    }
    return null;
  }

  exists(path: string): boolean {
    return existsSync(path);
  }

  readText(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  /** Resolve a symlink's immediate target, or null if not a symlink / missing. */
  readlinkSafe(path: string): string | null {
    try {
      return readlinkSync(path);
    } catch {
      return null;
    }
  }

  // ── command execution ────────────────────────────────────────────────────────

  /** READ-ONLY probe. Always executes (even in dry-run). Never throws. */
  probe(cmd: string, args: string[] = []): RunResult {
    try {
      const stdout = execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
      const code = typeof e.status === "number" ? e.status : 127;
      return { code, stdout: bufToStr(e.stdout), stderr: bufToStr(e.stderr) };
    }
  }

  /** MUTATING command. Skipped (logged) in dry-run. Throws on failure unless `allowFail`. */
  exec(cmd: string, args: string[], opts: ExecOptions = {}): RunResult {
    const pretty = `${cmd} ${args.join(" ")}`.trim();
    if (this.dryRun) {
      this.log.plan(`run: ${opts.desc ? `${opts.desc} — ` : ""}${pretty}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (opts.desc) this.log.info(`run: ${pretty}`);
    try {
      const stdout = execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        input: opts.input,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as {
        status?: number | null;
        stdout?: Buffer | string;
        stderr?: Buffer | string;
        message?: string;
      };
      const code = typeof e.status === "number" ? e.status : 1;
      const res: RunResult = { code, stdout: bufToStr(e.stdout), stderr: bufToStr(e.stderr) };
      if (opts.allowFail) return res;
      const detail = res.stderr || res.stdout || e.message || "";
      throw new Error(`command failed (exit ${code}): ${pretty}${detail ? `\n  ${detail.trim()}` : ""}`);
    }
  }

  // ── filesystem mutation ──────────────────────────────────────────────────────

  ensureDir(path: string, opts: { mode?: number; owner?: string; group?: string } = {}): void {
    if (existsSync(path)) {
      if (opts.owner || opts.group) this.chown(path, opts.owner, opts.group);
      return;
    }
    if (this.dryRun) {
      this.log.plan(`mkdir -p ${path}${opts.mode ? ` (mode ${opts.mode.toString(8)})` : ""}`);
      return;
    }
    mkdirSync(path, { recursive: true, mode: opts.mode });
    if (opts.mode !== undefined) chmodSync(path, opts.mode);
    if (opts.owner || opts.group) this.chown(path, opts.owner, opts.group);
    this.log.ok(`created directory ${path}`);
  }

  /** Idempotent file write. Identical content → skip. Optionally backs up a foreign original. */
  writeFile(path: string, content: string, opts: WriteOptions = {}): void {
    const mode = opts.mode ?? 0o644;
    const label = opts.desc ?? path;
    const exists = existsSync(path);
    const current = exists ? this.readText(path) : null;

    if (current === content) {
      this.log.skip(`${label} already current`);
      if (!this.dryRun) {
        try {
          chmodSync(path, mode);
        } catch {
          // best-effort perm enforcement
        }
        if (opts.owner || opts.group) this.chown(path, opts.owner, opts.group);
      }
      return;
    }

    if (this.dryRun) {
      this.log.plan(
        `write ${path} (${Buffer.byteLength(content)} bytes, mode ${mode.toString(8)})${exists ? " [replaces existing]" : ""}`,
      );
      return;
    }

    this.ensureDir(dirname(path));
    if (exists && opts.backupOriginal && !existsSync(path + PRE_BACKUP_SUFFIX)) {
      copyFileSync(path, path + PRE_BACKUP_SUFFIX);
      this.log.info(`backed up original ${path} -> ${path}${PRE_BACKUP_SUFFIX}`);
    }
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    if (opts.owner || opts.group) this.chown(path, opts.owner, opts.group);
    this.log.ok(`wrote ${label}`);
  }

  /** Idempotently (re)point a symlink at `target` (atomic replace). Dry-run aware. */
  symlink(target: string, link: string): void {
    if (this.readlinkSafe(link) === target) {
      this.log.skip(`symlink ${link} already → ${target}`);
      return;
    }
    if (this.dryRun) {
      this.log.plan(`symlink ${link} → ${target}`);
      return;
    }
    this.ensureDir(dirname(link));
    const tmp = `${link}.tmp`;
    rmSync(tmp, { force: true });
    symlinkSync(target, tmp);
    renameSync(tmp, link); // atomic replace
    this.log.ok(`symlinked ${link} → ${target}`);
  }

  /** Recursively/forcefully remove a path (file, symlink, or directory). */
  remove(path: string): void {
    if (!existsSync(path) && this.readlinkSafe(path) === null) {
      this.log.skip(`${path} absent`);
      return;
    }
    if (this.dryRun) {
      this.log.plan(`remove ${path}`);
      return;
    }
    rmSync(path, { recursive: true, force: true });
    this.log.ok(`removed ${path}`);
  }

  /** Restore a `<path>.pre-polyptic` backup over `path`. Returns true if a backup existed. */
  restoreBackup(path: string): boolean {
    const bak = path + PRE_BACKUP_SUFFIX;
    if (!existsSync(bak)) return false;
    if (this.dryRun) {
      this.log.plan(`restore ${path} from ${bak}`);
      return true;
    }
    copyFileSync(bak, path);
    rmSync(bak, { force: true });
    this.log.ok(`restored original ${path}`);
    return true;
  }

  /** chown via the system tool (avoids needing numeric uid/gid). Best-effort. */
  chown(path: string, owner?: string, group?: string, recursive = false): void {
    if (!owner && !group) return;
    const spec = `${owner ?? ""}:${group ?? ""}`;
    const args = recursive ? ["-R", spec, path] : [spec, path];
    this.exec("chown", args, { allowFail: true });
  }
}
