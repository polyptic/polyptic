/**
 * @polyptic/e2e — WHICH medium did this box boot from (the re-install ambiguity).
 *
 * An installed box's ESP is labeled POLYPTIC-BT and carries a `polyptic/medium-id` marker — the same
 * label and the same marker as the universal USB stick, deliberately, because after an install the
 * ESP IS the boot medium. So on a box that already has an install and is booted from the stick to be
 * RE-installed, `/dev/disk/by-label/POLYPTIC-BT` is ambiguous: udev publishes one symlink and which
 * volume wins is not deterministic. When it landed on the internal ESP, install-to-disk.sh refused
 * to install onto the very disk the operator was re-imaging ("carries the boot medium this box
 * booted from") — a nondeterministic refusal, across a fleet being re-imaged.
 *
 * find-boot-medium.sh now asks the RUNNING BOOT CHAIN instead: the live device dmsquash-live mounted
 * (/run/initramfs/live), the cmdline's live root spec (`root=live:LABEL=…`/`CDLABEL=…`), and the
 * `disk-esp-` marker stamp that only an installed box's own ESP wears. The decision tables run in
 * the pure-shell suites; this file runs them under bun/CI and pins the seams between the callers.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const read = (...p: string[]): string => readFileSync(resolve(repoRoot, ...p), "utf8");
const liveLib = (f: string): string => read("deploy", "live", "usr", "local", "lib", "polyptic", f);

async function shellSuite(name: string): Promise<void> {
  const proc = Bun.spawn(["sh", resolve(repoRoot, "deploy", "live", "test", name)], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) console.error(out);
  expect(out).toContain("ALL PASS");
  expect(code).toBe(0);
}

describe("shell suites", () => {
  test("deploy/live/test/find-boot-medium.test.sh passes", () => shellSuite("find-boot-medium.test.sh"), 60_000);
  test("deploy/live/test/install.test.sh passes", () => shellSuite("install.test.sh"), 120_000);
});

describe("the boot chain, not the label, names the booted medium", () => {
  const finder = liveLib("find-boot-medium.sh");

  test("both live-medium signals are read: the live mount and the cmdline root spec", () => {
    expect(finder).toContain("/run/initramfs/live");
    expect(finder).toContain("live:LABEL=");
    expect(finder).toContain("live:CDLABEL=");
  });

  test("an installed ESP's marker is only accepted on a boot that came from that disk", () => {
    // The stamp install-to-disk.sh writes. A USB medium's is `medium-…`, a fielded offloaded ESP's
    // `medium-esp-…` — neither is conditional, so both keep working exactly as before.
    expect(liveLib("install-to-disk.sh")).toContain("printf 'disk-esp-%s\\n'");
    expect(finder).toContain("disk-esp-*)");
    expect(finder).toContain("polyptic.bootpath");
  });

  test("the installer asks the boot chain directly for the disk it must never wipe", () => {
    const installer = liveLib("install-to-disk.sh");
    expect(installer).toContain('find-boot-medium.sh" --booted-disk');
    // The guard stands: a match still refuses, still says nothing was erased, and now says what it
    // took the boot chain to be so a wrong answer is diagnosable at the console.
    expect(installer).toContain("is the disk this box booted from");
    expect(installer).toContain("nothing was erased");
  });

  test("no tool the initramfs does not carry (POL-78: the initrd shipped no `dirname`)", () => {
    // 51polyptic-wifi/module-setup.sh installs this script and a named tool list. Anything outside
    // it is a binary that exists in every off-box test and in none of the initrds.
    const setup = read("deploy", "live", "usr", "lib", "dracut", "modules.d", "51polyptic-wifi", "module-setup.sh");
    expect(setup).toContain("inst_simple /usr/local/lib/polyptic/find-boot-medium.sh");
    const code = finder
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    for (const tool of ["lsblk", "awk", "dirname", "realpath", "findmnt", "udevadm", "python", "bash"]) {
      expect(code).not.toMatch(new RegExp(`\\b${tool}\\b`));
    }
    for (const tool of ["mount", "umount", "blkid", "readlink", "head"]) {
      expect(setup).toMatch(new RegExp(`inst_multiple[^\\n]* ${tool}\\b`));
    }
  });
});
