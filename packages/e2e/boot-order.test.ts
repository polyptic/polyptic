/**
 * @polyptic/e2e, the UEFI BOOT-ORDER watch (POL-115).
 *
 * Field pain: real firmware re-prepends its own OS entry to BootOrder after firmware updates and
 * reflashes (the homelab Lenovo does it every single time), so a box that offloaded cleanly months ago
 * silently boots a stale disk OS on its next power-cycle and the wall goes dark. The box that is UP is
 * the only thing that can see this coming — it can read its own NVRAM — so it watches its own boot
 * path on the update poll, reports drift into the Live Activity feed, and (only when the operator has
 * opted in) puts its own entry back at the head of the boot order.
 *
 * This runs the pure-shell suite (which drives the script against a REAL `efibootmgr` capture with
 * stubbed firmware) and then pins the destructive-action contract as source-level invariants: a
 * mangled BootOrder can leave a box unable to boot ANYTHING, so "never create, never delete, never
 * write unless asked" has to be true of the file, not just of the paths a test happened to walk.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const libDir = resolve(repoRoot, "deploy", "live", "usr", "local", "lib", "polyptic");
const shTestPath = resolve(repoRoot, "deploy", "live", "test", "boot-order.test.sh");
const scriptPath = resolve(libDir, "boot-order.sh");
const pollPath = resolve(libDir, "update-poll.sh");
const offloadPath = resolve(libDir, "offload.sh");

describe("boot-order watch: shell suite", () => {
  test("deploy/live/test/boot-order.test.sh passes", async () => {
    const proc = Bun.spawn(["sh", shTestPath], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) console.error(out);
    expect(out).toContain("ALL PASS");
    expect(code).toBe(0);
  }, 60_000);
});

describe("boot-order watch: the destructive-action contract", () => {
  const script = readFileSync(scriptPath, "utf8");

  test("the only NVRAM writes are `-o` (reorder) and `-a` (activate OUR entry)", () => {
    const writes = [...script.matchAll(/efibootmgr[^\n|]*/g)].map((m) => m[0]);
    expect(writes.length).toBeGreaterThan(0);
    for (const call of writes) {
      // -c creates a boot entry, -B deletes one. Neither is ever this script's business: it heals an
      // entry the offload installed, and a box with no such entry is left alone entirely.
      expect(call).not.toMatch(/\s-c(\s|$)/);
      expect(call).not.toMatch(/\s-B(\s|$)/);
    }
  });

  test("the write is gated on the control plane's answer, and the default is report-only", () => {
    expect(script).toContain("reassert=0");
    // The one place `reassert` is turned on is a `"reassert":true` in the policy body — no other path.
    const turnedOn = [...script.matchAll(/reassert=1/g)];
    expect(turnedOn.length).toBe(1);
    expect(script).toContain('/boot/policy');
  });

  test("the boot order is re-read from firmware before anything is claimed", () => {
    const wrote = script.indexOf('efibootmgr -q -o');
    const reread = script.indexOf('final_order="$(boot_order)"');
    const claim = script.indexOf("report true boot-order-reasserted");
    expect(wrote).toBeGreaterThan(-1);
    expect(reread).toBeGreaterThan(wrote);
    expect(claim).toBeGreaterThan(reread);
  });

  test("the entry set is compared before and after — we never lose an entry we did not add", () => {
    expect(script).toContain("before_entries");
    expect(script).toContain("after_entries");
    expect(script).toContain('[ "$before_entries" != "$after_entries" ]');
  });

  test("the fleet token travels in a header, never in the reported body", () => {
    expect(script).toContain("Authorization: Bearer $token");
    expect(script).not.toMatch(/"token":/);
  });

  test("the UEFI label matches the one the offload installs — that is what makes the entry OURS", () => {
    const label = /^LABEL="([^"]+)"$/m;
    const ours = label.exec(script)?.[1];
    const theirs = label.exec(readFileSync(offloadPath, "utf8"))?.[1];
    expect(ours).toBe("Polyptic Netboot");
    expect(theirs).toBe(ours);
  });
});

describe("boot-order watch: it actually runs", () => {
  test("the update poll calls it BEFORE its own early exits (a current box still needs watching)", () => {
    const poll = readFileSync(pollPath, "utf8");
    const call = poll.indexOf('sh "$LIB/boot-order.sh"');
    // The first early exit after the image comparison: a box already running the served image.
    const earlyExit = poll.indexOf('if [ "$SERVED" = "$RUNNING" ]');
    expect(call).toBeGreaterThan(-1);
    expect(earlyExit).toBeGreaterThan(call);
  });

  test("a failing watch can never take the update poll down with it", () => {
    expect(readFileSync(pollPath, "utf8")).toContain('sh "$LIB/boot-order.sh" || true');
  });
});
