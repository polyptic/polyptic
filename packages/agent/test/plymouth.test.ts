/**
 * Unit tests for the boot-splash (POL-7) config generators in packages/agent/src/setup/plymouth.ts.
 *
 * The headline case is the dracut regression: on Ubuntu 26.04 there is NO `plymouth-set-default-theme`
 * helper and the initramfs is built by dracut, which reads the theme from `plymouthd.conf`
 * (`[Daemon] Theme=`). Setup MUST write that file — depending on the helper left the splash on the
 * stock theme. The cmdline merges are pinned so `quiet splash` is added once, idempotently, without
 * disturbing an operator's existing kernel arguments.
 */
import { describe, expect, test } from "bun:test";

import {
  PLYMOUTH_THEME_NAME,
  SPLASH_CMDLINE_TOKENS,
  mergeCmdlineTxt,
  mergeGrubCmdline,
  plymouthdConf,
} from "../src/setup/plymouth";

describe("plymouthdConf — the portable, dracut-honoured theme selector", () => {
  const conf = plymouthdConf();

  test("declares the [Daemon] section and selects our theme", () => {
    expect(conf).toContain("[Daemon]");
    expect(conf).toContain(`Theme=${PLYMOUTH_THEME_NAME}`);
  });

  test("the section header is uncommented (a bare '#[Daemon]' would leave the theme unset)", () => {
    // Regression guard: Ubuntu ships plymouthd.conf with a COMMENTED '#[Daemon]', which is why the
    // theme was never applied. Our generated file must have a live section header.
    expect(conf).toMatch(/^\[Daemon\]$/m);
  });
});

describe("mergeGrubCmdline — GRUB_CMDLINE_LINUX_DEFAULT", () => {
  test("appends the key with every splash token when it is absent", () => {
    const out = mergeGrubCmdline("");
    expect(out).toContain('GRUB_CMDLINE_LINUX_DEFAULT="');
    for (const t of SPLASH_CMDLINE_TOKENS) expect(out).toContain(t);
  });

  test("adds only the missing tokens, preserving the operator's existing arguments", () => {
    const body = 'GRUB_CMDLINE_LINUX_DEFAULT="quiet nomodeset"\n';
    const out = mergeGrubCmdline(body);
    expect(out).toContain("nomodeset"); // operator arg kept
    expect(out).toContain("splash"); // ours added
    expect(out).toContain("plymouth.ignore-serial-consoles");
    // `quiet` was already present — not duplicated
    expect(out.match(/quiet/g)?.length).toBe(1);
  });

  test("is idempotent — a second pass changes nothing", () => {
    const once = mergeGrubCmdline("");
    expect(mergeGrubCmdline(once)).toBe(once);
  });
});

describe("mergeCmdlineTxt — bare cmdline.txt (Pi / u-boot)", () => {
  test("appends the missing tokens onto the single cmdline line", () => {
    const out = mergeCmdlineTxt("console=serial0,115200 root=/dev/mmcblk0p2\n");
    expect(out).toContain("root=/dev/mmcblk0p2");
    for (const t of SPLASH_CMDLINE_TOKENS) expect(out).toContain(t);
  });

  test("is idempotent", () => {
    const once = mergeCmdlineTxt("root=/dev/sda1\n");
    expect(mergeCmdlineTxt(once)).toBe(once);
  });
});
