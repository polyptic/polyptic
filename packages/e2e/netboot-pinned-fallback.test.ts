/**
 * @polyptic/e2e, NETBOOT initramfs pinned-build fallback (POL-116).
 *
 * The bug (real hardware, 2026-07-14): the offline/Wi-Fi menu baked on the boot medium PINS the root
 * image to one build (`…/builds/<imageId>/rootfs.squashfs`, D67) so the stick's kernel always meets
 * its own /lib/modules — but retention (D54) prunes a build once three newer ones exist, and the
 * medium is only re-pinned AFTER a successful boot. A box off across three rebuilds therefore came
 * back to a 404 it could never boot past, and livenet retried it forever, five seconds apart.
 *
 * The fix heals the box where it still has a network: an initramfs `netroot` hook that probes the pin
 * and, when the depot really has pruned it, re-points livenet at the ACTIVE build (or the unpinned
 * arch root) — loudly, on the splash and via `POST /boot/report`. The decision tree is exercised by
 * the shell suite below (stub curl/plymouth, no dracut, no boot); this file runs it and pins the
 * halves the server and docs depend on: the hook is wired into the dracut module as a `netroot` hook,
 * it never `exit`s (it is SOURCED into /sbin/netroot), and its splash line is one the pre-pivot hook
 * knows how to take back down.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const shTestPath = resolve(repoRoot, "deploy", "live", "test", "pinned-fallback.test.sh");
const liveMod = resolve(repoRoot, "deploy", "live", "usr", "lib", "dracut", "modules.d", "50polyptic-live");
const read = (p: string) => readFileSync(p, "utf8");

describe("netboot pinned-build fallback: shell suite", () => {
  test("deploy/live/test/pinned-fallback.test.sh passes", async () => {
    const proc = Bun.spawn(["sh", shTestPath], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) console.error(out);
    expect(out).toContain("ALL PASS");
    expect(code).toBe(0);
  }, 60_000);
});

describe("netboot pinned-build fallback: the dracut wiring", () => {
  const moduleSetup = read(resolve(liveMod, "module-setup.sh"));
  const hook = read(resolve(liveMod, "polyptic-pinned-fallback.sh"));
  const done = read(resolve(liveMod, "polyptic-progress-done.sh"));

  test("it is a `netroot` hook — the one place dracut sources our code into the shell that owns $netroot", () => {
    expect(moduleSetup).toMatch(/inst_hook netroot \d+ "\$moddir\/polyptic-pinned-fallback\.sh"/);
  });

  test("every external it shells out to is installed into the initramfs (the POL-78 lesson)", () => {
    const insts = moduleSetup.match(/^\s*inst_multiple .*$/gm)?.join(" ") ?? "";
    for (const tool of ["curl", "sed", "sleep", "tr"]) expect(insts).toContain(tool);
  });

  test("it rewrites $netroot rather than patching livenet", () => {
    expect(hook).toMatch(/netroot="livenet:\$polyptic_pin_url"/);
  });

  test("it is sourced, so it never exits and never changes shell options", () => {
    expect(hook).not.toMatch(/^\s*exit\b/m);
    expect(hook).not.toMatch(/^\s*set -[eu]/m);
  });

  test("the splash line it raises is one the pre-pivot hook takes back down (POL-53)", () => {
    const splash = /POLYPTIC_PIN_SPLASH="([^"]+)"/.exec(hook)?.[1];
    expect(splash).toBeTruthy();
    expect(done).toContain(`hide-message --text="${splash}"`);
  });

  test("the splash names no host and no build id — a wall screen is public signage", () => {
    const splash = /POLYPTIC_PIN_SPLASH="([^"]+)"/.exec(hook)?.[1] ?? "";
    expect(splash).not.toMatch(/http|\/dist\/|\d{8}T\d{6}Z/);
  });

  test("only a PINNED builds/ path is ever second-guessed (the wired, unpinned menu is untouched)", () => {
    expect(hook).toContain("/dist/image/*/builds/*/rootfs.squashfs");
  });
});
