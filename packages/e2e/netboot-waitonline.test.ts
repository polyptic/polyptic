/**
 * @polyptic/e2e, NETBOOT initramfs network-online policy (POL-76).
 *
 * The bug: a diskless amd64 box with two onboard NICs (only one cabled) netbooted, and the initramfs
 * then took ~179s before it fetched the root filesystem — an unplugged NIC held up
 * network-online.target. dracut's systemd-networkd module marks EVERY physical NIC RequiredForOnline
 * (routable), and `systemd-networkd-wait-online --any` still blocks on a required link stuck below
 * carrier (systemd#5154). The rootfs already avoids this with netplan `optional: true`
 * (RequiredForOnline=no); the initramfs never had the equivalent.
 *
 * The fix is static config baked into the polyptic-live dracut module, so these are content
 * invariants rather than a live boot (which we cannot do off-hardware). This test pins:
 *   - a wired-link .network sets RequiredForOnline=no and matches ETHER ONLY (Wi-Fi stays required),
 *   - the module installs it ahead of dracut's generated networks,
 *   - the wait-online backstop keeps --any and a bounded --timeout,
 *   - the Wi-Fi .network is NOT weakened (a wlan link must still be waited for until it associates).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const liveMod = resolve(repoRoot, "deploy", "live", "usr", "lib", "dracut", "modules.d", "50polyptic-live");
const netDir = resolve(repoRoot, "deploy", "live", "etc", "systemd", "network");

const read = (p: string) => readFileSync(p, "utf8");

describe("netboot wait-online: wired links must not block on missing carrier", () => {
  const netboot = read(resolve(liveMod, "polyptic-netboot.network"));

  test("wired .network sets RequiredForOnline=no", () => {
    expect(netboot).toMatch(/^\s*RequiredForOnline=no\s*$/m);
  });

  test("it matches WIRED links only (Type=ether), so Wi-Fi keeps the default (required)", () => {
    expect(netboot).toMatch(/^\s*Type=ether\s*$/m);
    // must not broadly match wlan (that would let a Wi-Fi box declare online before association)
    expect(netboot).not.toMatch(/Type=wlan/);
  });

  test("it still leases an address (DHCP=yes) — RequiredForOnline=no only changes the online gate", () => {
    expect(netboot).toMatch(/^\s*DHCP=yes\s*$/m);
  });

  test("the module installs it ahead of dracut's generated 70-*/zzzz-*.network (10- prefix, in /etc)", () => {
    const setup = read(resolve(liveMod, "module-setup.sh"));
    expect(setup).toContain('inst_simple "$moddir/polyptic-netboot.network"');
    expect(setup).toContain("/etc/systemd/network/10-polyptic-netboot.network");
  });
});

describe("netboot wait-online: bounded --any backstop", () => {
  const conf = read(resolve(liveMod, "polyptic-wait-online.conf"));

  test("wait-online runs with --any", () => {
    expect(conf).toMatch(/systemd-networkd-wait-online .*--any/);
  });

  test("the wait is bounded by a --timeout so a genuine single-link failure never hangs for minutes", () => {
    const m = conf.match(/--timeout=(\d+)/);
    expect(m).not.toBeNull();
    const timeout = Number(m![1]);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(45);
  });
});

describe("netboot wait-online: the Wi-Fi path still waits for association", () => {
  test("80-polyptic-wlan.network does NOT set RequiredForOnline=no (a wlan link must be waited for)", () => {
    const wlan = read(resolve(netDir, "80-polyptic-wlan.network"));
    expect(wlan).not.toMatch(/RequiredForOnline=no/);
  });
});
