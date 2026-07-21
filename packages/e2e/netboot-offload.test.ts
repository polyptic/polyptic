/**
 * @polyptic/e2e, NETBOOT bootloader install / "offload" (POL-33/D47, hardened by POL-58).
 *
 * `deploy/live/usr/local/lib/polyptic/offload.sh` is what turns a box that netbooted once into a box
 * that netboots forever: it copies the SIGNED shim+GRUB pair onto the machine's existing EFI System
 * Partition and makes that the firmware's first boot option. Nothing is erased — the previous OS stays
 * on disk — and the OS still streams from the control plane into RAM on every boot.
 *
 * POL-58 is the field report that made this file exist: a box "claimed to offload" and then booted
 * straight back into its old Ubuntu. Every abort path exited quietly into a journal on a RAM disk, and
 * the unit laundered exit 1 into success. So the invariant under test is not "the happy path works" —
 * it is that an install which cannot make the firmware boot Polyptic FAILS, says why, and leaves no
 * stamp claiming otherwise.
 *
 * The script is pure-ish: every path is env-overridable and every external command (lsblk, efibootmgr,
 * curl, mount, uname …) is stubbable on PATH, so the full decision tree runs against fixtures on
 * macOS/Linux/CI with no root and no real disks. This test runs that suite and pins the parts of the
 * contract the server and the docs depend on.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const shTestPath = resolve(repoRoot, "deploy", "live", "test", "offload.test.sh");
const offloadPath = resolve(repoRoot, "deploy", "live", "usr", "local", "lib", "polyptic", "offload.sh");
const unitPath = resolve(repoRoot, "deploy", "live", "etc", "systemd", "system", "polyptic-offload.service");

describe("netboot offload: shell suite", () => {
  test("deploy/live/test/offload.test.sh passes", async () => {
    const proc = Bun.spawn(["sh", shTestPath], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) console.error(out);
    expect(out).toContain("ALL PASS");
    expect(code).toBe(0);
  }, 60_000);
});

describe("netboot offload: the unit must not launder a failure into success", () => {
  const unit = readFileSync(unitPath, "utf8");

  test("`SuccessExitStatus=0 1` is gone: a failed install is a failed unit (POL-58)", () => {
    // This one directive is why `systemctl status polyptic-offload` used to agree with a box that had
    // never received a UEFI boot entry. (The comment explaining its removal may still name it.)
    expect(unit).not.toMatch(/^SuccessExitStatus=/m);
  });

  test("nothing Requires= the offload, so failing loudly still boots the wall", () => {
    expect(unit).not.toMatch(/^Requires=/m);
    expect(unit).toContain("Before=greetd.service");
    expect(unit).toContain("ConditionKernelCommandLine=polyptic.offload=1");
  });

  test("TimeoutStartSec=infinity: the failure hold outlives systemd's default start timeout (POL-167)", () => {
    // fail() holds the boot by never returning; without this, systemd kills the oneshot at ~90 s and
    // greetd paints the kiosk over the verdict — the 2026-07-21 field failure, where `no-esp` looked
    // exactly like a success once the wall came up.
    expect(unit).toMatch(/^TimeoutStartSec=infinity$/m);
  });
});

describe("netboot offload: the destructive-action contract", () => {
  const script = readFileSync(offloadPath, "utf8");

  test("the script never formats, repartitions, or wipes anything", () => {
    for (const forbidden of ["mkfs", "sgdisk", "parted", "wipefs", "dd if=", "sfdisk"]) {
      expect(script).not.toContain(forbidden);
    }
  });

  test("the success stamp is written only after the boot order has been re-read and verified", () => {
    const verify = script.indexOf("boot-order-not-first");
    const stamp = script.indexOf(`: > "$STAMP"`);
    expect(verify).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(verify);
  });

  test("the fleet token travels in a header, never in the reported body", () => {
    expect(script).toContain("Authorization: Bearer $token");
    expect(script).not.toMatch(/"token":/);
  });

  test("fail() records the outcome before the hold that never returns (POL-167)", () => {
    // The forever-hold blocks the boot on purpose, so the status file and the control-plane report
    // must already be on record when it starts — order in fail()'s body is the whole guarantee.
    const failBody = script.slice(script.indexOf("fail() {"));
    const report = failBody.indexOf("report false");
    const hold = failBody.indexOf("hold_failure");
    expect(report).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(report);
  });
});
