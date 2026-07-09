/**
 * @polyptic/e2e, NETBOOT stable diskless identity (POL-33).
 *
 * The whole POL-33 fix: a diskless live image regenerates /etc/machine-id randomly each boot, which would
 * make every cold boot a brand-new PENDING machine with lost placement. The live image instead derives a
 * STABLE POLYPTIC_MACHINE_ID from hardware (DMI product_uuid, MAC-hash fallback) BEFORE the agent starts,
 * so enroll.ts case-4 re-attaches the same approved machine every boot, no server/protocol change.
 *
 * These are pure-shell helpers (deploy/live/usr/local/lib/polyptic/*.sh) with every input path overridable,
 * so they're verifiable off-box. This bun test (a) runs the standalone shell test suite and asserts it
 * passes, and (b) pins the exact derivation contract from JS so a silent change to the hash/shape is caught.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const liveLib = resolve(repoRoot, "deploy", "live", "usr", "local", "lib", "polyptic");
const shTestPath = resolve(repoRoot, "deploy", "live", "test", "identity.test.sh");
const derivePath = resolve(liveLib, "derive-machine-id.sh");

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

describe("netboot identity: shell suite", () => {
  test("deploy/live/test/identity.test.sh passes", async () => {
    const { code, out } = await run(["sh", shTestPath]);
    if (code !== 0) console.error(out);
    expect(out).toContain("ALL PASS");
    expect(code).toBe(0);
  }, 15_000);
});

describe("netboot identity: derivation contract", () => {
  // A MAC seed (with the DMI/route files pointed at nonexistent paths) → mac-<sha256(mac)[:32]>.
  test("MAC fallback hashes exactly sha256(mac) truncated to 32 hex chars", async () => {
    const mac = "aa:bb:cc:dd:ee:ff";
    const { code, out } = await run(["sh", derivePath], {
      POLYPTIC_DMI_UUID_FILE: "/nonexistent/uuid",
      POLYPTIC_ROUTE_FILE: "/nonexistent/route",
      POLYPTIC_NET_DIR: makeNetFixture(mac),
    });
    expect(code).toBe(0);
    const want = "mac-" + createHash("sha256").update(mac).digest("hex").slice(0, 32);
    expect(out.trim()).toBe(want);
  }, 15_000);

  test("a valid DMI product_uuid wins and is lowercased with a dmi- prefix", async () => {
    const uuidFile = writeTmp("uuid", "4C4C4544-0031-3010-8046-B4C04F4E4B32\n");
    const { code, out } = await run(["sh", derivePath], {
      POLYPTIC_DMI_UUID_FILE: uuidFile,
      POLYPTIC_ROUTE_FILE: "/nonexistent/route",
      POLYPTIC_NET_DIR: "/nonexistent/net",
    });
    expect(code).toBe(0);
    expect(out.trim()).toBe("dmi-4c4c4544-0031-3010-8046-b4c04f4e4b32");
  }, 15_000);

  test("the derivation is deterministic across runs (stable across reboots)", async () => {
    const netDir = makeNetFixture("12:34:56:78:9a:bc");
    const env = {
      POLYPTIC_DMI_UUID_FILE: "/nonexistent/uuid",
      POLYPTIC_ROUTE_FILE: "/nonexistent/route",
      POLYPTIC_NET_DIR: netDir,
    };
    const a = await run(["sh", derivePath], env);
    const b = await run(["sh", derivePath], env);
    expect(a.out.trim()).toBe(b.out.trim());
    expect(a.out.trim()).toMatch(/^mac-[0-9a-f]{32}$/);
  }, 15_000);
});

// ── fixture helpers (tmp files under the OS temp dir) ────────────────────────────────────────────

function writeTmp(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "polyptic-id-"));
  const p = join(dir, name);
  writeFileSync(p, contents, "utf8");
  return p;
}

/** A minimal /sys/class/net fixture with a single real eth0 carrying `mac` (+ a skipped lo). */
function makeNetFixture(mac: string): string {
  const dir = mkdtempSync(join(tmpdir(), "polyptic-net-"));
  mkdirSync(join(dir, "eth0"), { recursive: true });
  writeFileSync(join(dir, "eth0", "address"), mac + "\n", "utf8");
  writeFileSync(join(dir, "eth0", "ifindex"), "2\n", "utf8");
  mkdirSync(join(dir, "lo"), { recursive: true });
  writeFileSync(join(dir, "lo", "address"), "00:00:00:00:00:00\n", "utf8");
  writeFileSync(join(dir, "lo", "ifindex"), "1\n", "utf8");
  return dir;
}
