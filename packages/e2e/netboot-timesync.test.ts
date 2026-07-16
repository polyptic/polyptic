/**
 * @polyptic/e2e, NETBOOT clock sync (POL-148).
 *
 * The live image ships no time client, so a netboot box free-runs off its RTC (one drifted an hour
 * ahead and silently broke a relative-range dashboard). POL-148 bakes systemd-timesyncd into the
 * image and points it at the fleet NTP server via this pure-shell helper, which reads the NTP host
 * off the boot cmdline (`polyptic.ntp`, or the `polyptic.server_url` host as a fallback) and writes
 * timesyncd's drop-in BEFORE the daemon starts.
 *
 * This bun test (a) runs the standalone shell suite and asserts it passes, and (b) pins the drop-in
 * contract from JS so a silent change to the host derivation or the file shape is caught.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const helper = resolve(repoRoot, "deploy", "live", "usr", "local", "lib", "polyptic", "timesync-conf.sh");
const shTestPath = resolve(repoRoot, "deploy", "live", "test", "timesync.test.sh");

async function run(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, {
    cwd: repoRoot,
    env: { ...(process.env as Record<string, string>), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

/** Run the helper against a fixture cmdline and return the drop-in it wrote (or "" if none). */
async function confFor(cmdline: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "polyptic-timesync-"));
  const cmdFile = join(dir, "cmdline");
  const confDir = join(dir, "conf");
  writeFileSync(cmdFile, `${cmdline}\n`);
  const { code } = await run(["sh", helper], {
    POLYPTIC_CMDLINE_FILE: cmdFile,
    POLYPTIC_TIMESYNC_CONF_DIR: confDir,
  });
  expect(code).toBe(0);
  try {
    return readFileSync(join(confDir, "10-polyptic.conf"), "utf8");
  } catch {
    return "";
  }
}

describe("netboot clock sync: shell suite", () => {
  test("deploy/live/test/timesync.test.sh passes", async () => {
    const { code, out } = await run(["sh", shTestPath]);
    expect(out).toContain("ALL PASS");
    expect(code).toBe(0);
  });
});

describe("netboot clock sync: the drop-in contract (POL-148)", () => {
  test("explicit polyptic.ntp is written as timesyncd NTP=", async () => {
    const conf = await confFor("root=live:x polyptic.ntp=boot.polyptic.example.com polyptic.server_url=ws://x/agent");
    expect(conf).toContain("[Time]");
    expect(conf).toContain("NTP=boot.polyptic.example.com");
  });

  test("falls back to the server_url host (scheme/port/path stripped) when polyptic.ntp is absent", async () => {
    const conf = await confFor("root=live:x polyptic.server_url=ws://10.0.0.10:8080/agent quiet");
    expect(conf).toContain("NTP=10.0.0.10");
  });

  test("no NTP host on the cmdline writes NOTHING — never a boot failure over a clock", async () => {
    expect(await confFor("root=live:CDLABEL=POLYPTIC quiet splash")).toBe("");
  });
});
