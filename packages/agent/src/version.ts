/**
 * Agent version resolution — the single source of truth for the running agent's version string
 * (used on `agent/hello` AND baked into the boot splash by `polyptic-agent setup`).
 *
 * Order of precedence:
 *   1. `POLYPTIC_BUILD_VERSION` — baked at compile time by deploy/build-agent.sh via
 *      `bun build --define`, so the standalone single binary knows its version even though it
 *      CANNOT read package.json off disk (bun compiles sources into a virtual FS).
 *   2. `../package.json` — the dev path (`bun src/index.ts`), where the file is really on disk.
 *   3. "0.0.0" — last-ditch default.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function agentVersion(): string {
  const baked = (process.env.POLYPTIC_BUILD_VERSION ?? "").trim();
  if (baked.length > 0) return baked;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    // ignore — fall through to the default
  }
  return "0.0.0";
}
