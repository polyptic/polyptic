/**
 * The GRUB boot splash — POL-47.
 *
 * GRUB runs before Plymouth exists, so it paints its own splash from a theme the control plane
 * serves. That leaves three copies of the same intent in three languages — a TS theme generator, a
 * GRUB shell fragment on the boot medium, and a shell heredoc inside the offload script — plus a
 * committed PNG. None of them can import the others at runtime, and a box that gets a mismatched
 * pair shows the drift on a wall. These tests are the join: they diff the copies against the one
 * source of truth for each fact.
 *
 * (The HTTP routes that serve the theme live in netboot.e2e.test.ts, with the rest of the depot.)
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SPLASH_COLORS } from "../agent/src/setup/plymouth";
import {
  BOOT_LOGO_HEIGHT,
  BOOT_LOGO_WIDTH,
  bootGfxPreamble,
  buildBootThemeTxt,
} from "../server/src/boot-theme";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p: string[]): string => readFileSync(resolve(repoRoot, ...p), "utf8");

const DONGLE_TMPL = read("deploy", "dongle-grub.cfg.tmpl");
const OFFLOAD_SH = read("deploy", "live", "usr", "local", "lib", "polyptic", "offload.sh");

describe("buildBootThemeTxt — the theme GRUB draws", () => {
  const theme = buildBootThemeTxt();

  test("its desktop is the EXACT dark the Plymouth splash paints", () => {
    // The two screens meet at the kernel hand-off. A different dark reads as a flash.
    expect(theme).toContain(`desktop-color: "${SPLASH_COLORS.bg}"`);
  });

  test("references the logo RELATIVELY, so no control-plane URL is baked into it", () => {
    // GRUB resolves a theme's files against the theme's own directory: /boot/theme.txt → /boot/logo.png.
    expect(theme).toContain('file = "logo.png"');
    expect(theme).not.toContain("http://");
    expect(theme).not.toContain("$net");
  });

  test("suppresses GRUB's own banner and wires the countdown label", () => {
    expect(theme).toContain('title-text: ""');
    expect(theme).toContain('id = "__timeout__"');
    expect(theme).toContain("%d"); // GRUB substitutes the remaining seconds
  });

  test("draws the logo at the committed PNG's exact size, so GRUB never rescales it", () => {
    expect(theme).toContain(`width = ${BOOT_LOGO_WIDTH}`);
    expect(theme).toContain(`height = ${BOOT_LOGO_HEIGHT}`);
    expect(theme).toContain(`left = 50%-${BOOT_LOGO_WIDTH / 2}`); // centred
  });

  test("names the font that is actually inside the signed grubnet's memdisk", () => {
    // Read out of the pinned grubnetx64.efi.signed's squashfs memdisk, not out of documentation.
    expect(theme).toContain('"GNU Unifont Regular 16"');
  });
});

describe("the committed boot logo", () => {
  const png = readFileSync(resolve(repoRoot, "packages", "server", "assets", "boot-logo.png"));

  test("is a PNG in a form GRUB's png module can decode", () => {
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR: width, height, bit depth, colour type, …, interlace. GRUB reads 8-bit RGB/RGBA,
    // non-interlaced only — a palette or an Adam7 image would silently fail to draw.
    expect(png.readUInt32BE(16)).toBe(BOOT_LOGO_WIDTH);
    expect(png.readUInt32BE(20)).toBe(BOOT_LOGO_HEIGHT);
    expect(png.readUInt8(24)).toBe(8); // bit depth
    expect([2, 6]).toContain(png.readUInt8(25)); // colour type: truecolour, with or without alpha
    expect(png.readUInt8(28)).toBe(0); // no interlace
  });
});

describe("bootGfxPreamble — the fragment both boot stages emit", () => {
  test("every graphical step hangs off `loadfont`, so a GRUB without it still boots", () => {
    const lines = bootGfxPreamble();
    const guard = lines.findIndex((l) => l.startsWith("if loadfont "));
    expect(guard).toBeGreaterThan(-1);
    expect(lines[lines.length - 1]).toBe("fi");
    // Nothing graphical may sit outside the guard.
    for (const l of lines.slice(0, guard)) expect(l.startsWith("#")).toBe(true);
  });

  test("takes the font from the loader's memdisk, costing no network round trip", () => {
    expect(bootGfxPreamble().join("\n")).toContain("loadfont (memdisk)/fonts/unicode.pf2");
  });

  test("stage 2 sets the theme; stage 1 (no network yet) only sets the background", () => {
    const stage1 = bootGfxPreamble().join("\n");
    const stage2 = bootGfxPreamble("$net/boot/theme.txt").join("\n");
    expect(stage1).not.toContain("set theme=");
    expect(stage1).toContain(`background_color "${SPLASH_COLORS.bg}"`);
    expect(stage2).toContain("set theme=$net/boot/theme.txt");
    expect(stage2).toContain("insmod gfxmenu");
  });

  test("hands GRUB's video mode to the kernel, so Plymouth inherits the framebuffer", () => {
    expect(bootGfxPreamble().join("\n")).toContain("set gfxpayload=keep");
  });
});

describe("the stage-1 config (boot medium + offloaded ESP)", () => {
  test("the dongle template carries bootGfxPreamble() verbatim", () => {
    // Rendered by a shell script at build time, so it cannot import the TS. This diff is the seam.
    expect(DONGLE_TMPL).toContain(bootGfxPreamble().join("\n"));
  });

  test("offload.sh writes the SAME stage-1 config, plus only its ownership marker", () => {
    // The offloaded box boots the identical chain; it just carries the loaders itself. A box has no
    // copy of the repo, so offload.sh embeds the template as a heredoc — which can rot silently.
    const heredoc = OFFLOAD_SH.split("<<'EOF'\n")[1]?.split("\nEOF\n")[0];
    expect(heredoc).toBeDefined();
    const withoutMarker = `${heredoc as string}\n`.replace(/^# polyptic-offload\n/, "");
    expect(withoutMarker).toBe(DONGLE_TMPL);
  });

  test("speaks plain English up front and keeps the diagnostics for the failure path", () => {
    expect(DONGLE_TMPL).toContain('echo "Starting Polyptic ..."');
    expect(DONGLE_TMPL).not.toContain("DHCP on all NICs");
    expect(DONGLE_TMPL).not.toContain('echo "Polyptic: chaining');
    // …but a box that cannot reach its control plane still says so, by name.
    expect(DONGLE_TMPL).toContain("Could not reach the Polyptic control plane at $net");
    expect(DONGLE_TMPL).toContain("--id retry");
  });
});

describe("the offline (Wi-Fi) local menu carries its own splash (POL-74)", () => {
  // render-local-grub.sh is the menu a box paints when it can't reach the server — so it can't fetch
  // the theme the wired path uses, and must set it from a copy baked onto the medium. This proves the
  // shell renderer emits the themed gfx block, pointed at the on-medium path both build-boot-medium.sh
  // and offload.sh write to. Rendered by running the actual script, so it can't drift from what ships.
  const render = spawnSync(
    "sh",
    [resolve(repoRoot, "deploy/live/usr/local/lib/polyptic/render-local-grub.sh"),
      "amd64", "a", "10.0.0.5:8080", "20260101T000000Z-abcd1234", "tok"],
    { encoding: "utf8" },
  );
  const LOCAL_MENU = render.stdout ?? "";

  test("emits the guarded gfx preamble (same discipline as bootGfxPreamble)", () => {
    expect(render.status).toBe(0);
    expect(LOCAL_MENU).toContain("if loadfont (memdisk)/fonts/unicode.pf2 ; then");
    expect(LOCAL_MENU).toContain("terminal_output gfxterm");
    expect(LOCAL_MENU).toContain('background_color "#0b0b0d"'); // the shared dark, no flash at hand-off
    expect(LOCAL_MENU).toContain("insmod gfxmenu"); // needed to draw a theme, as the themed preamble does
  });

  test("sets the theme from the on-medium copy, guarded so a theme-less medium still boots", () => {
    // Device-relative ($root), so it resolves on the USB stick AND an offloaded ESP; guarded by a
    // file-exists check so a LEAN/theme-less medium degrades to a plain menu rather than erroring.
    expect(LOCAL_MENU).toContain(
      "if [ -f ($root)/polyptic/boot/theme/theme.txt ]; then set theme=($root)/polyptic/boot/theme/theme.txt ; fi",
    );
    // The theme is desktop-agnostic (no baked URL), which is exactly why a local copy is legitimate.
    expect(buildBootThemeTxt()).toContain('file = "logo.png"');
    expect(buildBootThemeTxt()).not.toContain("http");
  });
});
