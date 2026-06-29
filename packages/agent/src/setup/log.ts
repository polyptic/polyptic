/**
 * Tiny logger for the `polyptych-agent setup` provisioner.
 *
 * Every step is logged with a stable, greppable prefix. In `--dry-run` the prefix flips to
 * `[setup:dry-run]` and mutating steps log `[plan] would …` instead of acting, so an operator can
 * preview the whole provision on a stock box without touching it. ASCII-only markers (no emoji/
 * unicode) so it reads cleanly on a minimal server console / serial line.
 */

export interface Logger {
  /** Section banner. */
  banner(msg: string): void;
  /** A numbered/major step. */
  step(msg: string): void;
  /** Neutral info line. */
  info(msg: string): void;
  /** A change that was applied. */
  ok(msg: string): void;
  /** An idempotent no-op (already in the desired state). */
  skip(msg: string): void;
  /** A change that will/would be applied (prefixes "would " in dry-run). */
  plan(msg: string): void;
  /** Non-fatal warning. */
  warn(msg: string): void;
  /** Error line (does not throw). */
  error(msg: string): void;
}

export function createLogger(dryRun: boolean): Logger {
  const tag = dryRun ? "[setup:dry-run]" : "[setup]";
  return {
    banner: (m) => console.log(`\n${tag} ===== ${m} =====`),
    step: (m) => console.log(`${tag} >> ${m}`),
    info: (m) => console.log(`${tag}    ${m}`),
    ok: (m) => console.log(`${tag}    [ok]   ${m}`),
    skip: (m) => console.log(`${tag}    [skip] ${m}`),
    plan: (m) => console.log(`${tag}    [plan] ${dryRun ? "would " : ""}${m}`),
    warn: (m) => console.warn(`${tag}    [warn] ${m}`),
    error: (m) => console.error(`${tag}    [ERR]  ${m}`),
  };
}
