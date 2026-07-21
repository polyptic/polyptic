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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { corePackages } from "../src/setup/distro";
import { compositorLauncher, i3Config, swayConfig } from "../src/setup/templates";

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

describe("corePackages — the cast set ships with wayland-sway only (POL-119)", () => {
  test("apt wayland set carries the receiver, mDNS, and waylandsink", () => {
    const pkgs = corePackages("apt", "wayland-sway");
    expect(pkgs).toContain("uxplay");
    expect(pkgs).toContain("avahi-daemon");
    expect(pkgs).toContain("gstreamer1.0-plugins-bad");
  });

  test("x11-i3 gets none of it — the backend refuses setCast (POL-67 rules out X11 sinks)", () => {
    const pkgs = corePackages("apt", "x11-i3");
    expect(pkgs).not.toContain("uxplay");
    expect(pkgs).not.toContain("avahi-daemon");
  });

  test("dev-open provisions only the base set, as before", () => {
    expect(corePackages("apt", "dev-open")).not.toContain("uxplay");
  });
});

describe("compositorLauncher — auto probes the GPU at boot, never at bake (POL-169/D158)", () => {
  const script = compositorLauncher({
    backend: "wayland-sway",
    sessionCommand: "sway",
    render: "auto",
  });

  test("the baked default stays the REQUESTED mode — auto is never resolved at setup time", () => {
    expect(script).toContain(': "${POLYPTIC_RENDER:=auto}"');
  });

  test("auto calls the on-box probe; explicit modes never do", () => {
    expect(script).toContain("mode=$(probe_gpu_mode)");
    const pinned = compositorLauncher({ backend: "wayland-sway", sessionCommand: "sway", render: "software" });
    expect(pinned).toContain(': "${POLYPTIC_RENDER:=software}"');
    // The probe only runs inside the `[ "$mode" = auto ]` branch, so a pinned mode skips it.
    expect(pinned).toMatch(/if \[ "\$mode" = auto \]; then\n  mode=\$\(probe_gpu_mode\)/);
  });

  /** The probe function, extracted from the generated script and run under real `sh` against a
   *  fixture /sys — the sh code itself is what must be right, not just its presence. */
  function runProbe(cards: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "pol169-drm-"));
    try {
      for (const [card, uevent] of Object.entries(cards)) {
        mkdirSync(join(dir, card, "device"), { recursive: true });
        writeFileSync(join(dir, card, "device", "uevent"), uevent);
      }
      const fn = script.match(/probe_gpu_mode\(\) \{[\s\S]*?\n\}/)?.[0];
      expect(fn).toBeTruthy();
      const out = Bun.spawnSync(["sh", "-c", `${fn}\nprobe_gpu_mode`], {
        env: { ...process.env, POLYPTIC_DRM_SYS: dir },
      });
      return out.stdout.toString().trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a real GPU (the POL-169 test box's i915) probes hardware", () => {
    expect(runProbe({ card0: "DRIVER=i915\nPCI_ID=8086:9A49\n" })).toBe("hardware");
  });

  test("a virtio GPU probes software — its GLES compositor survives, so the crash timer alone would miss it", () => {
    expect(runProbe({ card0: "DRIVER=virtio-pci\nPCI_ID=1AF4:1050\n" })).toBe("software");
  });

  test("a virtual card identified only by PCI vendor still probes software", () => {
    expect(runProbe({ card0: "PCI_ID=1234:1111\n" })).toBe("software");
  });

  test("a mixed box (passthrough real card + virtual) keeps hardware — a real GPU anywhere wins", () => {
    expect(
      runProbe({ card0: "DRIVER=virtio-pci\nPCI_ID=1AF4:1050\n", card1: "DRIVER=amdgpu\nPCI_ID=1002:73FF\n" }),
    ).toBe("hardware");
  });

  test("no DRM cards at all probes hardware — auto's crash-fallback still guards the unknown", () => {
    expect(runProbe({})).toBe("hardware");
  });
});
