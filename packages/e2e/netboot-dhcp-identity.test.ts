/**
 * @polyptic/e2e, NETBOOT DHCP client identity (2026-08-26 outage).
 *
 * Every installed box shipped the SAME /etc/machine-id: the image build emptied it in step 5, and the
 * site layer's apt-get in step 6 re-minted it. networkd derives its DHCPv4 DUID from the machine-id,
 * so the DHCP failover pair matched every box on one DUID and leased two boxes one address; every
 * socket on both reset every ~2 minutes. Two fixes, both pinned here: the rootfs keys DHCP on the MAC
 * (netplan `dhcp-identifier: mac`, networkd `ClientIdentifier=mac`), and the build script wipes the
 * machine-id LAST and refuses to seal a non-empty one.
 */
import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const shTestPath = resolve(repoRoot, "deploy", "live", "test", "dhcp-identity.test.sh");

describe("netboot DHCP identity: shell suite", () => {
  test("deploy/live/test/dhcp-identity.test.sh passes", async () => {
    const proc = Bun.spawn(["sh", shTestPath], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(out).toContain("ALL PASS");
    expect(code).toBe(0);
  });
});
