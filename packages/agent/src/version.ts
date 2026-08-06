/**
 * Agent version resolution — the single source of truth for the running agent's version string
 * (used on `agent/hello` AND baked into the boot splash by `polyptic-agent setup`).
 *
 * Order of precedence:
 *   1. {@link BAKED_AGENT_VERSION} — baked at compile time by deploy/build-agent.sh and
 *      deploy/server.Dockerfile via `bun build --define`, so the standalone single binary knows its
 *      version even though it CANNOT read package.json off disk (bun compiles sources into a
 *      virtual FS).
 *   2. `../package.json` — the dev path (`bun src/index.ts`), where the file is really on disk.
 *   3. "0.0.0" — last-ditch default.
 *
 * READ THE CONSTANT, NOT THE ENV. `--define "process.env.POLYPTIC_BUILD_VERSION=\"0.3.6\""` is a
 * compile-time TEXTUAL substitution of that exact expression: it rewrites the literal
 * `process.env.POLYPTIC_BUILD_VERSION` written below, and nothing else. A property access on any
 * other object — `env.POLYPTIC_BUILD_VERSION` on a parameter, a destructured `const { env }` — is a
 * different expression, is never substituted, and reads a real environment that has never had this
 * variable set. That is exactly how the fleet ended up reporting a baked version while telling the
 * server it was "not running as an updatable binary" (see ./update.ts). One substitution site, here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The version the compiler baked in, or "" in a dev/source run. The ONLY `--define` site. */
export const BAKED_AGENT_VERSION: string = (process.env.POLYPTIC_BUILD_VERSION ?? "").trim();

export function agentVersion(): string {
  if (BAKED_AGENT_VERSION.length > 0) return BAKED_AGENT_VERSION;
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
