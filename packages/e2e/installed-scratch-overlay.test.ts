/**
 * @polyptic/e2e, INSTALLED-BOOT scratch overlay (POL-179).
 *
 * The 2026-07-23 field failure: the first real installed boot painted dracut's "Unable to find a
 * persistent overlay; using a temporary one." across a public wall, and the writable overlay stayed
 * in RAM. Root cause: `rd.live.overlay=LABEL=POLYPTIC-SCRATCH` names the DEVICE, but dmsquash-live
 * (dracut-ng 110) looks for the overlay at a PATH on it — and the installer left the fs bare, so
 * every installed box hit dracut's no-overlay fallback on every boot. Three layers fix it, and this
 * file pins the seams BETWEEN them (each layer alone looks fine to its own test):
 *
 *   1. the cmdline pins the pathspec        → render-disk-grub.sh `…POLYPTIC-SCRATCH:/overlayfs`
 *   2. the installer seeds the layout       → install-to-disk.sh creates `overlayfs/` + `ovlwork/`
 *   3. the initramfs self-heals the layout  → polyptic-scratch-prep.sh, settled hook 04 (before
 *                                             dmsquash-live's own settled job, filename order)
 *
 * The hook's decision logic runs in the pure-shell suite (deploy/live/test/scratch-prep.test.sh);
 * this file runs it under bun/CI.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const read = (...p: string[]): string => readFileSync(resolve(repoRoot, ...p), "utf8");
const liveLib = (f: string): string => read("deploy", "live", "usr", "local", "lib", "polyptic", f);
const dracutMod = (f: string): string =>
  read("deploy", "live", "usr", "lib", "dracut", "modules.d", "50polyptic-live", f);

describe("scratch-prep: shell suite", () => {
  test("deploy/live/test/scratch-prep.test.sh passes", async () => {
    const proc = Bun.spawn(["sh", resolve(repoRoot, "deploy", "live", "test", "scratch-prep.test.sh")], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) console.error(out);
    expect(out).toContain("ALL PASS");
    expect(code).toBe(0);
  }, 60_000);
});

describe("the three layers agree on ONE overlay layout", () => {
  test("the disk cmdline pins dmsquash-live's pathspec to /overlayfs", () => {
    // Without the pathspec, dmsquash-live defaults to `/LiveOS/overlay-<label>-<uuid>` of the LIVE
    // device — a name that changes with the booted slot — never finds it, and warns on the wall.
    expect(liveLib("render-disk-grub.sh")).toContain(
      "rd.live.overlay=LABEL=POLYPTIC-SCRATCH:/overlayfs rd.live.overlay.overlayfs=1 rd.live.overlay.reset=1",
    );
  });

  test("the installer seeds exactly the pair the pathspec names", () => {
    const installer = liveLib("install-to-disk.sh");
    expect(installer).toContain('mkdir -p "$mnt_scratch/overlayfs" "$mnt_scratch/ovlwork"');
  });

  test("the hook re-creates the same pair, and heals by re-mkfs with the LABEL the devspec resolves", () => {
    const hook = dracutMod("polyptic-scratch-prep.sh");
    expect(hook).toContain('mkdir -p "$polyptic_sp_mnt/overlayfs" "$polyptic_sp_mnt/ovlwork"');
    // The re-mkfs must restore the fs label, or dmsquash-live's `LABEL=POLYPTIC-SCRATCH` devspec
    // resolves to nothing on the healed boot.
    expect(hook).toContain("mkfs.ext4 -q -F -L POLYPTIC-SCRATCH");
    // …and the device is found by GPT PARTLABEL: a corrupt fs publishes no LABEL for udev.
    expect(hook).toContain("/dev/disk/by-partlabel/POLYPTIC-SCRATCH");
  });

  test("the hook is installed where it beats dmsquash-live to the device", () => {
    const setup = dracutMod("module-setup.sh");
    // dmsquash-live's own job lands in the SAME settled dir at runtime as `dmsquash-live-root.sh`;
    // settled hooks run in filename order, so `04…` must hold (digits sort before letters).
    expect(setup).toContain('inst_hook initqueue/settled 04 "$moddir/polyptic-scratch-prep.sh"');
    // The self-heal binary is NOT otherwise in a dracut initramfs — naming it is the POL-78 law.
    expect(setup).toMatch(/inst_multiple[^\n]* mkfs\.ext4/);
  });
});
