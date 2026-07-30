/**
 * @polyptic/e2e, the SITE LAYER (POL-190).
 *
 * A self-hosted fleet lands on somebody else's corporate network, and their security function requires
 * its own endpoint tooling on every box. The site layer is the one generic seam that goes through:
 * a declarative bundle installs packages at BUILD time, and the box registers itself at BOOT time from
 * `firstboot.d/`, with credentials that arrive on the boot medium and live only in RAM.
 *
 * The split is forced rather than stylistic. `rootfs.squashfs` is served ungated (a box has no session
 * before it boots, so the boot chain cannot authenticate), so a registration performed during the build
 * would write its own bearer credential into a downloadable artifact.
 *
 * This bun test (a) runs the standalone shell suite and asserts it passes, and (b) pins the two
 * contracts worth re-stating from JS, because both are the kind of thing a well-meaning refactor
 * quietly breaks: the secrets file is PARSED and never sourced, and a value arrives byte-exact with no
 * invented trailing newline.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const liveLib = resolve(repoRoot, "deploy", "live", "usr", "local", "lib", "polyptic");
const shTestPath = resolve(repoRoot, "deploy", "live", "test", "site.test.sh");
const confPath = resolve(liveLib, "site-conf.sh");

async function run(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(argv, {
    cwd: repoRoot,
    env: { ...(process.env as Record<string, string>), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out, err };
}

function writeConf(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "polyptic-site-"));
  const p = join(dir, "site.conf");
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

describe("site layer: shell suite", () => {
  test("deploy/live/test/site.test.sh passes", async () => {
    const { code, out } = await run(["sh", shTestPath]);
    if (code !== 0) console.error(out);
    expect(out).toContain("all checks passed");
    expect(code).toBe(0);
  }, 30_000);
});

describe("site layer: the secrets file is data, not code", () => {
  test("a command substitution in a value stays literal and does not execute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polyptic-site-rce-"));
    const canary = join(dir, "canary");
    const conf = writeConf([`SITE_TOKEN=$(touch ${canary})`, `SITE_OTHER=\`touch ${canary}2\``]);
    const { code, out } = await run(["sh", confPath, conf]);
    expect(code).toBe(0);
    expect(out).toContain("SITE_TOKEN=$(touch");
    expect(existsSync(canary)).toBe(false);
    expect(existsSync(`${canary}2`)).toBe(false);
  }, 15_000);

  test("a token keeps its spaces, quotes, equals and dollars byte-exact", async () => {
    const token = 'a b"c=d$e/f+g==';
    const conf = writeConf([`SITE_TOKEN=${token}`]);
    const { code, out } = await run(["sh", confPath, conf]);
    expect(code).toBe(0);
    expect(out).toContain(`SITE_TOKEN=${token}`);
  }, 15_000);

  test("a key without the SITE_ prefix fails loudly and yields nothing", async () => {
    // The silent-skip version of this is the worst failure the feature can have: the box boots,
    // renders perfectly, and is enrolled in nothing, which nobody notices until an audit.
    const conf = writeConf(["SITE_TENANT=acme", "TENANT_ID=typo"]);
    const { code, out, err } = await run(["sh", confPath, conf]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("missing the SITE_ prefix");
  }, 15_000);
});
