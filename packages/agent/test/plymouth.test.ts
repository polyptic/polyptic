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
  plymouthDracutConf,
  plymouthScript,
  plymouthdConf,
} from "../src/setup/plymouth";
import { corePackages } from "../src/setup/distro";

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

describe("substrate packages must include the plymouth LABEL plugin (text renderer, POL-7 crash)", () => {
  // Without the label plugin, the script theme's Image.Text has no renderer → plymouth leaves the
  // console viewer NULL → the script plugin segfaults on it every boot. Required, not optional.
  test("apt splash set includes plymouth-label for a real kiosk backend", () => {
    const pkgs = corePackages("apt", "wayland-sway");
    expect(pkgs).toContain("plymouth-label");
    expect(pkgs).toContain("plymouth");
  });

  test("dnf splash set includes the Fedora label plugin", () => {
    expect(corePackages("dnf", "wayland-sway")).toContain("plymouth-plugin-label");
  });

  test("the x11-i3 backend also gets the splash text renderer", () => {
    expect(corePackages("apt", "x11-i3")).toContain("plymouth-label");
  });

  test("splash=false (opt-out) drops the splash packages entirely", () => {
    expect(corePackages("apt", "wayland-sway", false)).not.toContain("plymouth-label");
  });
});

describe("plymouthDracutConf — force the theme into the dracut initramfs", () => {
  test("emits an install_items line naming every file it's given", () => {
    const conf = plymouthDracutConf(["/etc/plymouth/plymouthd.conf", "/x/script.so", "/t/polyptic.plymouth"]);
    expect(conf).toMatch(/^install_items\+=/m);
    expect(conf).toContain("/etc/plymouth/plymouthd.conf");
    expect(conf).toContain("/x/script.so");
    expect(conf).toContain("/t/polyptic.plymouth");
  });
});

describe("plymouthScript — must never hold an image-less sprite (plymouth 5.x segfault, POL-7)", () => {
  const script = plymouthScript();

  test("does not eagerly create an empty message sprite", () => {
    // The bug: `message.sprite = Sprite();` with no image → plymouth 5.x crashes in
    // script_lib_sprite_refresh on the first frame of a normal boot (no message ever arrives).
    expect(script).not.toContain("message.sprite = Sprite();");
  });

  test("creates the message sprite lazily, WITH an image, on the first message", () => {
    expect(script).toContain("message.have = 0");
    expect(script).toContain("Sprite(img)");
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
