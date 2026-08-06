/**
 * @polyptic/e2e — the operator's own logo on the boot screens (POL-194).
 *
 * The feature is one function (`logoSvg`) with two extra inputs, plus the wiring that gets a
 * customer's SVG to the three things that rasterise it. What is worth pinning is therefore the
 * VALIDATOR (every refusal is a boot-path hazard we chose to name rather than discover on a wall),
 * the composition (the mark must land in the slot the GRUB theme paints at a fixed size), and the
 * wiring itself — that the four surfaces named in the pitch actually reach the brand.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOOT_BRAND_MARK_MAX_BYTES,
  BOOT_BRAND_WORDMARK_MAX,
  SPLASH_COLORS,
  logoSvg,
  validateBrandMark,
  wordmarkFontSize,
} from "@polyptic/protocol";

import { splashAssets } from "../agent/src/setup/plymouth";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const read = (p: string): string => readFileSync(resolve(repoRoot, p), "utf8");

/** A minimal, valid customer mark: one path, a viewBox, no text. */
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z" fill="#f43f5e"/></svg>';

describe("validateBrandMark — every refusal names the thing that is wrong", () => {
  test("accepts an ordinary flattened mark", () => {
    expect(validateBrandMark(MARK)).toEqual({ ok: true });
  });

  test("rejects a raster upload, because SVG-only is the decision the whole feature rests on", () => {
    const png = "\x89PNG\r\n\x1a\n\x00\x00";
    const check = validateBrandMark(png);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("not an SVG");
  });

  test("rejects a mark with no viewBox — there is nothing to scale into the fixed slot", () => {
    const check = validateBrandMark('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h1v1z"/></svg>');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("viewBox");
  });

  test("rejects live <text> and says to convert it to paths", () => {
    const check = validateBrandMark(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text x="0" y="0">Acme</text></svg>`);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("paths");
  });

  // The rabbit hole the pitch called out: rsvg-convert RESOLVES external references, so the server
  // would fetch an attacker-chosen URL from inside the cluster, and a box would fetch something that
  // cannot exist on an offline boot.
  test.each([
    ['<image href="https://evil.example/x.png"/>', "a remote <image>"],
    ['<use xlink:href="http://evil.example/x#a"/>', "a remote xlink:href"],
    ['<rect fill="url(https://evil.example/g)"/>', "a remote url() paint"],
  ])("rejects %s (%s)", (payload) => {
    const check = validateBrandMark(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${payload}</svg>`);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("no network");
  });

  test("allows a #fragment and a data: URI — the two references that resolve offline", () => {
    const local = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <linearGradient id="g"><stop offset="0"/></linearGradient>
      <rect fill="url(#g)" width="24" height="24"/>
      <image href="data:image/png;base64,iVBOR" width="4" height="4"/>
    </svg>`;
    expect(validateBrandMark(local).ok).toBe(true);
  });

  test.each([
    ["<script>alert(1)</script>", "<script>"],
    ["<foreignObject><b>hi</b></foreignObject>", "<foreignObject>"],
    ['<style>@import url("x.css");</style>', "@import"],
  ])("rejects %s", (payload) => {
    expect(validateBrandMark(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${payload}</svg>`).ok).toBe(false);
  });

  test("rejects an event handler — inert on the boot chain, an XSS payload in the console preview", () => {
    const check = validateBrandMark('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0h1v1z"/></svg>');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("event handler");
  });

  test("rejects an entity declaration (the XXE vector) before anything else parses the file", () => {
    const check = validateBrandMark('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 1 1"/>');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("entity");
  });

  test("caps the upload size", () => {
    const huge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${"<path d='M0 0h1v1z'/>".repeat(20_000)}</svg>`;
    expect(huge.length).toBeGreaterThan(BOOT_BRAND_MARK_MAX_BYTES);
    expect(validateBrandMark(huge).ok).toBe(false);
  });
});

describe("logoSvg — one lockup, with or without a brand", () => {
  test("the default is unchanged: the Polyptic mark, on its white holder, with our wordmark", () => {
    const svg = logoSvg();
    expect(svg).toContain(">Polyptic<");
    expect(svg).toContain(">DISPLAY NODE<");
    expect(svg).toContain(`fill="${SPLASH_COLORS.holder}"`); // the rounded holder
  });

  test("a custom mark drops the white holder — a light logo must not vanish into it", () => {
    const svg = logoSvg({ markSvg: MARK });
    expect(svg).not.toContain(`rx="33" fill="${SPLASH_COLORS.holder}"`);
    expect(svg).toContain('fill="#f43f5e"'); // the customer's artwork is there
  });

  test("the mark lands in the 136x136 slot, centred, with its own viewBox preserved", () => {
    const svg = logoSvg({ markSvg: MARK });
    expect(svg).toContain('<svg x="252" y="0" width="136" height="136" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet"');
  });

  test("the wordmark replaces Polyptic; DISPLAY NODE is not customisable", () => {
    const svg = logoSvg({ wordmark: "Northgate" });
    expect(svg).toContain(">Northgate<");
    expect(svg).not.toContain(">Polyptic<");
    expect(svg).toContain(">DISPLAY NODE<");
  });

  test("XML-escapes a wordmark, so an ampersand cannot break the drawing", () => {
    expect(logoSvg({ wordmark: "Smith & Co" })).toContain(">Smith &amp; Co<");
  });

  // There are no font metrics on any of the three rasterisers, so a long name can only be bounded.
  test("steps the type size down for a long name, and never below the legibility floor", () => {
    expect(wordmarkFontSize("Polyptic")).toBe(52);
    expect(wordmarkFontSize("Northgate Development Trust")).toBeLessThan(52);
    expect(wordmarkFontSize("W".repeat(BOOT_BRAND_WORDMARK_MAX))).toBeGreaterThanOrEqual(24);
  });

  test("the GRUB copy bakes the background in, so it never composites alpha over desktop-color", () => {
    expect(logoSvg({ background: SPLASH_COLORS.bg })).toContain(`fill="${SPLASH_COLORS.bg}"`);
  });
});

describe("the brand reaches the Plymouth splash through setup", () => {
  test("splashAssets renders the operator's mark + wordmark into logo.svg", () => {
    const [logo] = splashAssets({ hostname: "h", version: "1.0.0" }, { markSvg: MARK, wordmark: "Acme" });
    expect(logo?.base).toBe("logo");
    expect(logo?.svg).toContain("#f43f5e");
    expect(logo?.svg).toContain(">Acme<");
  });

  test("no brand is the pre-POL-194 lockup, byte for byte", () => {
    const [before] = splashAssets({ hostname: "h", version: "1.0.0" });
    expect(before?.svg).toBe(logoSvg());
  });

  test("`setup` takes the two flags the image build passes it", () => {
    const args = read("packages/agent/src/setup/args.ts");
    expect(args).toContain('case "--brand-mark":');
    expect(args).toContain('case "--brand-wordmark":');
  });
});

describe("the four surfaces the pitch promised", () => {
  test("GRUB netboot menu: /boot/logo.png serves the render, and falls back rather than 404ing", () => {
    const provision = read("packages/server/src/provision.ts");
    expect(provision).toContain('fastify.get("/boot/logo.png"');
    expect(provision).toContain("branding.renderer.render");
    // The fallback is the whole safety story: a boot path must never lose its bitmap.
    expect(provision).toContain("BOOT_LOGO_PATH");
  });

  test("offline media + installed ESPs: heal_boot_theme already re-pulls exactly these files", () => {
    const poll = read("deploy/live/usr/local/lib/polyptic/update-poll.sh");
    for (const file of ["theme.txt", "logo.png", "bg.png"]) {
      expect(poll).toContain(`$base/boot/${file}`);
    }
    // …and it content-compares, so an unchanged brand costs the FAT nothing on the 5-minute poll.
    expect(poll).toContain("cmp -s");
  });

  test("Plymouth splash: the image build pulls the brand BEFORE setup runs in the chroot", () => {
    const build = read("deploy/build-live-image.sh");
    const brandPull = build.indexOf("POLYPTIC_BRAND_BASE");
    const setupRun = build.indexOf("polyptic-agent setup \\");
    expect(brandPull).toBeGreaterThan(-1);
    expect(brandPull).toBeLessThan(setupRun);
    expect(build).toContain("/boot/brand/mark.svg");
    expect(build).toContain("/boot/brand/wordmark.txt");
  });

  test("the rebuild Job hands the build the in-cluster control plane to pull from", () => {
    expect(read("deploy/helm/polyptic/templates/rebuild-jobs.yaml")).toContain("POLYPTIC_BRAND_BASE=%[5]s");
  });

  test("build-boot-medium.sh is untouched — it copies committed assets on purpose (POL-74/80/82)", () => {
    // POL-74 fetched the theme at build time and shipped silently-plain media; POL-80 generated it
    // with `bun` and shipped silently-plain media again. POL-82 settled on committed assets, and
    // POL-194 does not reopen that wound: a freshly-flashed stick bakes the DEFAULT mark and shows
    // it for exactly one boot, after which heal_boot_theme replaces it.
    const medium = read("deploy/build-boot-medium.sh");
    expect(medium).not.toContain("POLYPTIC_BRAND_BASE");
    expect(medium).not.toContain("/boot/brand");
  });
});

describe("the control plane can actually rasterise", () => {
  test("the server image installs librsvg2-bin, unconditionally", () => {
    const dockerfile = read("deploy/server.Dockerfile");
    expect(dockerfile).toContain("librsvg2-bin");
  });

  test("the render is put through the SAME grub-png-check the medium bake and the heal use", () => {
    const renderer = read("packages/server/src/boot-brand.ts");
    expect(renderer).toContain("grub-png-check.sh");
  });
});
