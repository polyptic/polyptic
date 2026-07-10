/**
 * proc — small `node:child_process` helpers shared by the real DisplayBackends (sway / x11).
 *
 * Phase 4. The agent stays a Bun single binary with NO new npm deps (D7); it drives the host
 * by shelling out to system tools (`swaymsg`, `grim`, `xrandr`, `xdotool`, `wmctrl`, `scrot`,
 * `surf`). These helpers wrap that uniformly:
 *   - `run`           — short-lived command, capture text stdout/stderr, never throws on a
 *                       non-zero exit (returns the code so callers can produce clear errors).
 *   - `runOk`         — same, but throws a descriptive error on non-zero / spawn failure.
 *   - `captureStdout` — short-lived command, capture BINARY stdout (screenshots), `null` on
 *                       any failure.
 *   - `spawnChild`    — long-lived child (the kiosk browser, `swaymsg -t subscribe -m`).
 *   - `which`         — PATH lookup with no subprocess (scans `$PATH` for an executable).
 *   - `requireTools`  — assert a set of tools is installed, else one clear error.
 *   - `makeJsonStreamSplitter` — incremental, string-aware brace-depth splitter for the
 *                       (possibly pretty-printed) stream of JSON objects sway emits on a
 *                       `-t subscribe -m` monitor.
 */
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

export interface RunResult {
  /** Process exit code, or `null` if it was killed by a signal / failed to spawn. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Sleep for `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a short-lived command and resolve with its captured text output. Never rejects on a
 * non-zero exit or a spawn error — inspect `code` (`null` ⇒ could not run). Use this when a
 * non-zero exit is an expected outcome (e.g. `pgrep` finding nothing, `xdotool search` empty).
 */
export function run(cmd: string, args: string[] = [], opts: SpawnOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: (err as Error).message });
      return;
    }
    const out: Buffer[] = [];
    const errb: Buffer[] = [];
    proc.stdout?.on("data", (d: Buffer) => out.push(d));
    proc.stderr?.on("data", (d: Buffer) => errb.push(d));
    proc.on("error", (err) => {
      resolve({ code: null, stdout: Buffer.concat(out).toString("utf8"), stderr: (err as Error).message });
    });
    proc.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errb).toString("utf8"),
      });
    });
  });
}

/** Like {@link run} but throws a descriptive error on non-zero exit / spawn failure. */
export async function runOk(cmd: string, args: string[] = [], opts: SpawnOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const why = r.stderr.trim() || `exit ${r.code === null ? "(could not spawn)" : r.code}`;
    throw new Error(`${cmd} ${args.join(" ")} failed: ${why}`);
  }
  return r.stdout;
}

/**
 * Run a short-lived command and capture its raw BINARY stdout (for screenshot grabbers).
 * Resolves `null` on a spawn error, a non-zero exit, or empty output.
 */
export function captureStdout(
  cmd: string,
  args: string[] = [],
  opts: SpawnOptions = {},
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    const out: Buffer[] = [];
    proc.stdout?.on("data", (d: Buffer) => out.push(d));
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const buf = Buffer.concat(out);
      resolve(buf.length > 0 ? buf : null);
    });
  });
}

/**
 * Spawn a long-lived child (the kiosk browser, a sway event subscription). Defaults to piping stdio;
 * pass `{ stdio: "ignore" }` for noisy children (the browser). The caller owns the returned handle
 * (supervision / kill).
 */
export function spawnChild(cmd: string, args: string[] = [], opts: SpawnOptions = {}): ChildProcess {
  return spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/**
 * Is `tool` runnable? Resolves against `$PATH` (or treats a path-like value directly) WITHOUT
 * spawning anything — `command -v` is a shell builtin and `which(1)` isn't guaranteed present
 * on a Server-minimal box, so we scan the PATH ourselves.
 */
export async function which(tool: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (tool.includes("/")) {
    try {
      await access(tool, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    try {
      await access(join(dir, tool), fsConstants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

/** Assert every tool in `tools` is on PATH; throws one clear error listing what's missing. */
export async function requireTools(tools: string[]): Promise<void> {
  const missing: string[] = [];
  for (const t of tools) {
    if (!(await which(t))) missing.push(t);
  }
  if (missing.length > 0) {
    throw new Error(
      `missing required tool(s): ${missing.join(", ")} — install them (see docs/DEPLOY.md / \`polyptic-agent setup\`) or fix PATH`,
    );
  }
}

/** Escape a literal string for safe embedding inside a regular expression. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Incremental splitter for a stream of concatenated JSON objects. `sway`'s
 * `swaymsg -t subscribe -m '["window"]'` emits one JSON object per event, and depending on the
 * build they may be pretty-printed (multi-line) and back-to-back with no delimiter — so we
 * track `{`/`}` depth (ignoring braces inside strings) and emit each complete top-level object.
 */
export function makeJsonStreamSplitter(onObject: (obj: unknown) => void): {
  push(chunk: Buffer | string): void;
} {
  let buf = "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;

  return {
    push(chunk: Buffer | string): void {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i];
        if (ch === undefined) continue;
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') {
          inStr = true;
          continue;
        }
        if (ch === "{") {
          if (depth === 0) start = i;
          depth++;
        } else if (ch === "}") {
          if (depth > 0) depth--;
          if (depth === 0 && start >= 0) {
            const slice = buf.slice(start, i + 1);
            try {
              onObject(JSON.parse(slice));
            } catch {
              // malformed fragment — ignore and keep parsing
            }
            // Drop the consumed prefix and restart the scan from the new start.
            buf = buf.slice(i + 1);
            i = -1;
            start = -1;
          }
        }
      }
      // Defensive: never let the buffer grow unbounded if no object ever completes.
      if (depth === 0 && start === -1 && buf.length > 4_000_000) buf = "";
    },
  };
}
