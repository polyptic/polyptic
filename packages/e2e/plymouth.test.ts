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
  test("covers shutdown/reboot too (POL-7): keys off Plymouth.GetMode with the right status text", () => {
    expect(script).toContain("Plymouth.GetMode()");
    expect(script).toContain('"Shutting down"');
    expect(script).toContain('"Restarting"');
    // boot progress bar is gated so it doesn't show a stuck 0% bar on the way down
    expect(script).toContain("show_bar");
  });

  test("re-lays-out when the window changes size (simpledrm → KMS mode-set, POL-53)", () => {
    // Top-level script code runs ONCE. plymouthd starts from sysinit.target while udev is still
    // probing, so the KMS driver can take over from simpledrm and mode-set AFTER the splash is
    // painted. Read the window size only inside layout(), and re-run layout() from the refresh
    // callback when it changes — otherwise the splash sits small and off-centre in the corner.
    expect(script).toContain("fun layout() {");
    expect(script).toMatch(/fun layout\(\) \{\n\s*sw = Window\.GetWidth\(\);\n\s*sh = Window\.GetHeight\(\);/);
    expect(script).toMatch(/SetRefreshFunction\(fun \(\) \{\n\s*if \(Window\.GetWidth\(\) != sw\) \{\n\s*layout\(\);/);
    expect(script).toMatch(/if \(Window\.GetHeight\(\) != sh\) \{\n\s*layout\(\);/);
    // the sizes must not be captured at the top level, above layout()
    expect(script.indexOf("Window.GetWidth()")).toBeGreaterThan(script.indexOf("fun layout() {"));
  });

  test("layout's shared state is declared at the top level, not created as function locals", () => {
    // Plymouth's DSL makes `x = 1` inside a fun a LOCAL unless `x` already exists in an enclosing
    // scope. layout() assigns sw/sh/cx and draw_status() reads them, so they must be initialised at
    // the top level first — otherwise the readers silently see nothing and draw nothing. Observed:
    // the whole status line disappeared from a real boot.
    const layoutAt = script.indexOf("fun layout() {");
    for (const decl of ["sw = 0;", "sh = 0;", "cx = 0;"]) {
      const at = script.indexOf(decl);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(layoutAt);
    }
  });

  test("every sprite is born with an image (image-less Sprite() segfaults plymouth 5.x, POL-7)", () => {
    const code = script
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/Sprite\(\)/);
    expect(code).toMatch(/= Sprite\(\w/); // …they are all Sprite(<some image>)
  });

  test("text is scaled up for wall legibility and never shrunk", () => {
    expect(script).toContain("scale_text(Image.Text(line");
    expect(script).toContain("sh / 620");
    expect(script).toMatch(/fun scale_text\(img, factor\) \{\n\s*if \(factor < 1\) \{/);
  });

  test("ONE status line: our narration outranks systemd's unit names, and can be taken back down", () => {
    // Two sprites meant the wall showed systemd's raw unit name AND "Downloading the OS image ..."
    // stacked. One line now, sourced from `plymouth display-message` when there is one, else systemd.
    expect(script).toMatch(/fun status_line\(\) \{\n\s*if \(status\.message != ""\) \{\n\s*return status\.message;/);
    expect(script).toContain("return status.system;");
    // a systemd status must not paint over a message that is still up
    expect(script).toMatch(/status\.system = text;\n\s*if \(status\.message == ""\) \{\n\s*draw_status\(\);/);
    // hide-message hands the line back
    expect(script).toMatch(/SetHideMessageFunction\(fun \(text\) \{\n\s*if \(text == status\.message\) \{\n\s*status\.message = "";/);
    // and there is exactly one text sprite
    expect(script).not.toContain("message.sprite");
    expect(script.match(/Sprite\(Image\.Text/g)?.length).toBe(1);
  });

  test("an empty status never blanks the line or hands a sprite a null image (POL-7 segfault)", () => {
    // systemd pushes an empty status when a job settles. Image.Text("") has nothing to draw, and a
    // sprite left image-less segfaults the script plugin on the next frame.
    expect(script).toMatch(/fun draw_status\(\) \{\n\s*line = status_line\(\);\n\s*if \(line != ""\) \{/);
    expect(script).toMatch(/if \(img\.GetHeight\(\) > 0\) \{/);
    expect(script).toMatch(/SetUpdateStatusFunction\(fun \(text\) \{\n\s*if \(text != ""\) \{/);
    expect(script).toMatch(/SetMessageFunction\(fun \(text\) \{\n\s*if \(text != ""\) \{/);
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
