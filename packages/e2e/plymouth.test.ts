/**
 * Unit tests for the boot-splash (Plymouth) theme generators — POL-7.
 *
 * These are pure string generators (the agent binary carries the whole theme as source and writes
 * it out at provision time), so they're testable without a booting VM. The VISUAL cold-boot property
 * (splash shows from early boot to the player with no console text) is a separate VM/hardware check,
 * flagged by `polyptic-agent setup` in its "needs verification" list.
 */
import { describe, expect, test } from "bun:test";
import {
  PLYMOUTH_THEME_DIR,
  PLYMOUTH_THEME_NAME,
  SPLASH_CMDLINE_TOKENS,
  logoSvg,
  mergeCmdlineTxt,
  mergeGrubCmdline,
  plymouthQuitDropin,
  plymouthScript,
  plymouthTheme,
  splashAssets,
  stampSvg,
} from "../agent/src/setup/plymouth";

describe("logoSvg — the swappable vector asset", () => {
  const svg = logoSvg();
  test("is a self-contained SVG", () => {
    expect(svg.startsWith("<?xml")).toBe(true);
    expect(svg).toContain("<svg");
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
  test("carries the Polyptic mark (two side panels + centre bar) and the wordmark", () => {
    expect(svg).toContain("<polygon"); // the two hinged side panels
    expect(svg).toContain("<rect"); // holder + centre bar
    expect(svg).toContain(">Polyptic<");
    expect(svg).toContain(">DISPLAY NODE<");
  });
});

describe("stampSvg — hostname + build version", () => {
  test("renders host and a v-prefixed version", () => {
    const svg = stampSvg({ hostname: "reception-pc", version: "0.1.0" });
    expect(svg).toContain(">reception-pc<");
    expect(svg).toContain(">v0.1.0<");
  });
  test("does not double the v prefix", () => {
    expect(stampSvg({ hostname: "h", version: "v2.3.1" })).toContain(">v2.3.1<");
  });
  test("XML-escapes an exotic hostname so it cannot break the SVG", () => {
    const svg = stampSvg({ hostname: 'a<b>&"c', version: "1.0.0" });
    expect(svg).toContain("a&lt;b&gt;&amp;&quot;c");
    expect(svg).not.toContain("<b>");
  });
});

describe("splashAssets", () => {
  const assets = splashAssets({ hostname: "h", version: "1.0.0" });
  test("declares the four theme images", () => {
    expect(assets.map((a) => a.base).sort()).toEqual(["bar-fill", "bar-track", "logo", "stamp"]);
  });
  test("forces an explicit height only on the thin bars", () => {
    const byBase = Object.fromEntries(assets.map((a) => [a.base, a]));
    expect(byBase.logo?.height).toBeUndefined();
    expect(byBase.stamp?.height).toBeUndefined();
    expect(byBase["bar-track"]?.height).toBe(8);
    expect(byBase["bar-fill"]?.height).toBe(8);
  });
  test("every asset has a positive rasterise width and non-empty SVG", () => {
    for (const a of assets) {
      expect(a.width).toBeGreaterThan(0);
      expect(a.svg.startsWith("<?xml")).toBe(true);
    }
  });
});

describe("plymouthTheme descriptor", () => {
  const theme = plymouthTheme();
  test("selects the script plugin and points at our dir + script", () => {
    expect(theme).toContain("ModuleName=script");
    expect(theme).toContain(`ImageDir=${PLYMOUTH_THEME_DIR}`);
    expect(theme).toContain(`ScriptFile=${PLYMOUTH_THEME_DIR}/${PLYMOUTH_THEME_NAME}.script`);
  });
});

describe("plymouthScript — the live splash program", () => {
  const script = plymouthScript();
  test("draws all four images", () => {
    for (const f of ["logo.png", "bar-track.png", "bar-fill.png", "stamp.png"]) {
      expect(script).toContain(`Image("${f}")`);
    }
  });
  test("wires the LIVE boot callbacks (status, progress, messages)", () => {
    expect(script).toContain("Plymouth.SetUpdateStatusFunction");
    expect(script).toContain("Plymouth.SetBootProgressFunction");
    expect(script).toContain("Plymouth.SetRefreshFunction");
    expect(script).toContain("Plymouth.SetMessageFunction");
  });
  test("sets a solid dark background and sizes everything off the window", () => {
    expect(script).toContain("Window.SetBackgroundTopColor");
    expect(script).toContain("Window.GetWidth()");
    expect(script).toContain("Window.GetHeight()");
  });
});

describe("plymouthQuitDropin — seamless hand-off", () => {
  test("resets ExecStart and retains the final splash frame", () => {
    const dropin = plymouthQuitDropin();
    expect(dropin).toContain("ExecStart=\n"); // clears the packaged ExecStart first
    expect(dropin).toContain("plymouth quit --retain-splash");
  });
});

describe("mergeGrubCmdline", () => {
  test("appends the splash tokens, preserving what was there", () => {
    const out = mergeGrubCmdline('GRUB_CMDLINE_LINUX_DEFAULT="maybe-ubuntu"\nGRUB_TIMEOUT=5\n');
    expect(out).toContain(
      'GRUB_CMDLINE_LINUX_DEFAULT="maybe-ubuntu quiet splash plymouth.ignore-serial-consoles"',
    );
    expect(out).toContain("GRUB_TIMEOUT=5"); // untouched
  });
  test("is idempotent", () => {
    const once = mergeGrubCmdline("GRUB_CMDLINE_LINUX_DEFAULT=\"foo\"\n");
    expect(mergeGrubCmdline(once)).toBe(once);
  });
  test("does not duplicate a token that is already present", () => {
    const out = mergeGrubCmdline('GRUB_CMDLINE_LINUX_DEFAULT="quiet foo"\n');
    expect(out.match(/quiet/g)?.length).toBe(1);
    expect(out).toContain("splash");
  });
  test("adds the key when it is absent entirely", () => {
    const out = mergeGrubCmdline("GRUB_TIMEOUT=5\n");
    expect(out).toContain('GRUB_CMDLINE_LINUX_DEFAULT="quiet splash plymouth.ignore-serial-consoles"');
    expect(out).toContain("GRUB_TIMEOUT=5");
  });
  test("preserves single-quote style", () => {
    const out = mergeGrubCmdline("GRUB_CMDLINE_LINUX_DEFAULT='foo'\n");
    expect(out).toContain("GRUB_CMDLINE_LINUX_DEFAULT='foo quiet splash plymouth.ignore-serial-consoles'");
  });
});

describe("mergeCmdlineTxt (Raspberry Pi / u-boot)", () => {
  test("appends tokens to the single cmdline line", () => {
    const out = mergeCmdlineTxt("console=tty1 root=PARTUUID=x rootwait\n");
    expect(out.trim()).toBe(
      `console=tty1 root=PARTUUID=x rootwait ${SPLASH_CMDLINE_TOKENS.join(" ")}`,
    );
  });
  test("is idempotent", () => {
    const once = mergeCmdlineTxt("console=tty1\n");
    expect(mergeCmdlineTxt(once)).toBe(once);
  });
});
