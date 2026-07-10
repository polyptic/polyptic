/**
 * @polyptic/e2e, NETBOOT Wi-Fi credential layer (POL-63).
 *
 * A Wi-Fi box can't fetch anything until it has associated, so its credentials ride the boot medium
 * as `polyptic/wifi.conf` and are turned into a wpa_supplicant config TWICE per boot: in the dracut
 * initrd (to stream rootfs.squashfs) and again in the rootfs (the supplicant must keep running for
 * WPA rekeying — the Linux-world handoff). Both stages share the same pure-shell helpers
 * (deploy/live/usr/local/lib/polyptic/wifi-*.sh), so they are verifiable off-box.
 *
 * This bun test (a) runs the standalone shell suite and asserts it passes, and (b) pins the
 * escaping contract from JS — an SSID/passphrase must survive byte-exact through an
 * operator-edited file into the supplicant dialect, because a silently mangled PSK is a box that
 * never comes online with nothing on its screen to say why.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const liveLib = resolve(repoRoot, "deploy", "live", "usr", "local", "lib", "polyptic");
const shTestPath = resolve(repoRoot, "deploy", "live", "test", "wifi.test.sh");
const renderPath = resolve(liveLib, "wifi-supplicant-conf.sh");

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
  const dir = mkdtempSync(join(tmpdir(), "polyptic-wifi-"));
  const p = join(dir, "wifi.conf");
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

describe("netboot wifi: shell suite", () => {
  test("deploy/live/test/wifi.test.sh passes", async () => {
    const { code, out } = await run(["sh", shTestPath]);
    if (code !== 0) console.error(out);
    expect(out).toContain("ALL PASS");
    expect(code).toBe(0);
  }, 20_000);
});

describe("netboot wifi: escaping contract", () => {
  test("the SSID is emitted as the exact hex of its bytes (UTF-8 included)", async () => {
    const ssid = 'Café "Wall" 5GHz';
    const conf = writeConf([`WIFI_SSID=${ssid}`, "WIFI_PSK=hunter2hunter2"]);
    const { code, out } = await run(["sh", renderPath, conf]);
    expect(code).toBe(0);
    expect(out).toContain(`ssid=${Buffer.from(ssid, "utf8").toString("hex")}`);
  }, 15_000);

  test("a passphrase with quotes and backslashes survives as a correctly escaped C string", async () => {
    const conf = writeConf(["WIFI_SSID=Net", 'WIFI_PSK=a"b\\c dd ee']);
    const { code, out } = await run(["sh", renderPath, conf]);
    expect(code).toBe(0);
    expect(out).toContain('psk="a\\"b\\\\c dd ee"');
  }, 15_000);

  test("an invalid file renders NOTHING and fails loudly (never a half-configured supplicant)", async () => {
    const conf = writeConf(["WIFI_SSID=Net", "WIFI_PSK=short"]);
    const { code, out, err } = await run(["sh", renderPath, conf]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("8-63");
  }, 15_000);

  test("WPA-Enterprise username/password lands as a PEAP+MSCHAPv2 network block", async () => {
    const conf = writeConf(["WIFI_SSID=Corp", "WIFI_IDENTITY=box@corp.example", "WIFI_PASSWORD=s3cret"]);
    const { code, out } = await run(["sh", renderPath, conf]);
    expect(code).toBe(0);
    expect(out).toContain("key_mgmt=WPA-EAP");
    expect(out).toContain("eap=PEAP");
    expect(out).toContain('identity="box@corp.example"');
    expect(out).toContain('phase2="auth=MSCHAPV2"');
  }, 15_000);
});
