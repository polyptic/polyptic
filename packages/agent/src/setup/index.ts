/**
 * `polyptych-agent setup` entry point.
 *
 * Dispatched from index.ts when argv[2] === "setup". Parses flags, sets up the logger + the dry-run
 * aware `Sys`, enforces the root requirement (for a real run), and runs the install or uninstall
 * flow. Returns a process exit code (0 ok, 1 failure, 2 bad arguments).
 *
 * This module (and everything it imports — distro/browser/templates/install/uninstall) is loaded
 * LAZILY via a dynamic import in index.ts, so the agent's normal boot path never pays for the
 * provisioning machinery. See D26/D27 for the design rationale.
 */
import { createLogger } from "./log";
import { Sys } from "./system";
import { parseArgs, usage } from "./args";
import { runInstall } from "./install";
import { runUninstall } from "./uninstall";
import type { SetupOptions } from "./args";
import type { SetupResult } from "./install";

export async function runSetupCli(argv: string[]): Promise<number> {
  let opts: SetupOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[setup] ${(err as Error).message}\n`);
    console.error(usage());
    return 2;
  }

  if (opts.help) {
    console.log(usage());
    return 0;
  }

  const log = createLogger(opts.dryRun);
  const sys = new Sys(opts.dryRun, log);

  if (!opts.dryRun && !sys.isRoot()) {
    log.error("must run as root. Re-run with sudo, or use --dry-run to preview without changes.");
    return 1;
  }

  try {
    const result: SetupResult =
      opts.mode === "uninstall" ? runUninstall(sys, opts, log) : runInstall(sys, opts, log);

    log.banner(opts.dryRun ? "dry run complete — no changes were made" : `${opts.mode} complete`);

    if (result.assumptions.length > 0) {
      log.info("Assumptions made:");
      for (const a of result.assumptions) log.info(`  - ${a}`);
    }
    if (result.needsVerification.length > 0) {
      log.info("Needs VM/hardware verification:");
      for (const n of result.needsVerification) log.info(`  - ${n}`);
    }
    return 0;
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }
}

// Allow running the setup module directly (`bun src/setup/index.ts ...`) in addition to the
// `polyptych-agent setup` subcommand path. import.meta.main is true only when this file is the
// program entry, so importing it from index.ts is side-effect free.
if (import.meta.main) {
  void runSetupCli(process.argv.slice(2)).then((code) => process.exit(code));
}
