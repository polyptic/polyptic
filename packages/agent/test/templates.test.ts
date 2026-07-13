/**
 * Unit tests for the compositor config generators in packages/agent/src/setup/templates.ts.
 *
 * The headline case is the POL-60 kiosk input lockdown: a deployed wall must ignore physical input
 * devices wholesale (a walk-up keyboard could otherwise Tab around the dashboard or reach a VT),
 * EXCEPT in a debug boot (`systemd.debug-shell=1`), where a keyboard is the whole point — without
 * it the tty9 root shell is unreachable from the box. The exact shape of these lines is deliberate
 * and easy to break invisibly (sway's exec/comment parsing quirks, XTEST on the X11 path), hence
 * the pinning here.
 */
import { describe, expect, test } from "bun:test";

import { corePackages } from "../src/setup/distro";
import { i3Config, swayConfig } from "../src/setup/templates";

const sway = swayConfig({ outputs: [], sessionTarget: "polyptic-session.target" });
const i3 = i3Config({ outputs: [], sessionTarget: "polyptic-session.target" });

describe("swayConfig — kiosk input lockdown (POL-60)", () => {
  test("disables ALL input devices wholesale (covers hot-plugged keyboards too)", () => {
    expect(sway).toMatch(/^input \* events disabled$/m);
  });

  test("a debug boot re-enables keyboard, pointer, and touch at startup", () => {
    for (const type of ["keyboard", "pointer", "touch"]) {
      expect(sway).toMatch(
        new RegExp(`^exec grep -q systemd\\.debug-shell=1 /proc/cmdline && swaymsg input type:${type} events enabled$`, "m"),
      );
    }
  });

  test("the re-enable execs carry no quotes, commas, or globs (sway exec + sh word-splitting hazards)", () => {
    // sway joins exec args and hands them to `sh -c`; a comma would split the sway command list, a
    // quote may be eaten by the config tokenizer, and an unquoted `*` would glob against $HOME.
    const execs = sway.split("\n").filter((l) => l.startsWith("exec grep"));
    expect(execs.length).toBe(3);
    for (const line of execs) {
      expect(line).not.toMatch(/["',*;]/);
    }
  });

  test("the disable is a directive with no trailing comment (sway parses trailing '#' as arguments)", () => {
    const line = sway.split("\n").find((l) => l.startsWith("input *"));
    expect(line).toBe("input * events disabled");
  });
});

describe("i3Config — kiosk input lockdown (POL-60, X11 best-effort)", () => {
  test("disables physical slave devices unless this is a debug boot", () => {
    expect(i3).toContain("grep -q systemd.debug-shell=1 /proc/cmdline || xinput list");
    expect(i3).toContain("xinput disable");
  });

  test("spares the XTEST virtual devices — the on-screen inspector types through them (POL-50)", () => {
    const line = i3.split("\n").find((l) => l.includes("xinput disable"));
    expect(line).toContain("grep -iv xtest");
  });

  test("only slave devices are touched (masters cannot be disabled; floating devices carry no input)", () => {
    const line = i3.split("\n").find((l) => l.includes("xinput disable"));
    expect(line).toContain('grep -E "slave +(keyboard|pointer)"');
  });
});

describe("corePackages — xinput ships with the x11-i3 backend (POL-60)", () => {
  test("apt/dnf/pacman x11 sets include the xinput tool the i3 lockdown line runs", () => {
    expect(corePackages("apt", "x11-i3")).toContain("xinput");
    expect(corePackages("dnf", "x11-i3")).toContain("xinput");
    expect(corePackages("pacman", "x11-i3")).toContain("xorg-xinput");
  });

  test("the wayland path needs no extra package — the lockdown is sway config", () => {
    expect(corePackages("apt", "wayland-sway")).not.toContain("xinput");
  });
});
