/**
 * Favicon wiring for the two web apps — POL-56.
 *
 * A missing favicon is invisible in code review and obvious in a browser tab, so the guard lives
 * here rather than in anyone's head. These are pure on-disk assertions (no server, no vite build):
 * they check that each app's index.html declares icon links, that every file those links point at
 * actually exists in that app's Vite public/ dir, and that the copies have not drifted from brand/
 * — the declared source of truth, synced by brand/generate.sh.
 *
 * The COMPLEMENTARY property — that the control plane really serves these bytes at `/favicon.ico`
 * and `/player/favicon.svg`, and that a *missing* icon stays a real 404 instead of the SPA shell —
 * is asserted against the running server in static.e2e.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const brandDir = join(repoRoot, "brand");

/** Pull the href of every `<link rel="…icon…">` out of an HTML document, in document order. */
function iconHrefs(html: string): string[] {
  const links = html.match(/<link\b[^>]*\brel="[^"]*icon[^"]*"[^>]*>/g) ?? [];
  return links.map((tag) => tag.match(/\bhref="([^"]+)"/)?.[1] ?? "");
}

const APPS = [
  // The console is a browsable operator app: tab icon, bookmark, pinned to a phone home screen.
  { name: "console", expected: ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"] },
  // The player is a fullscreen kiosk page — it only needs the two tab icons.
  { name: "player", expected: ["/favicon.ico", "/favicon.svg"] },
] as const;

for (const { name, expected } of APPS) {
  describe(`${name} index.html`, () => {
    const appDir = join(repoRoot, "packages", name);
    const html = readFileSync(join(appDir, "index.html"), "utf8");
    const hrefs = iconHrefs(html);

    test("declares exactly the icon links the app needs", () => {
      expect(hrefs).toEqual([...expected]);
    });

    // Root-absolute, NOT relative: the player's history fallback serves the same index.html at
    // /player/screen/<id>, where a relative `favicon.ico` would resolve to /player/screen/favicon.ico.
    // Vite rewrites these to the configured base ("/player/") at build time.
    test("references every icon by a root-absolute path", () => {
      for (const href of hrefs) expect(href.startsWith("/")).toBe(true);
    });

    test("every referenced icon exists in the app's public/ dir", () => {
      for (const href of hrefs) {
        const file = join(appDir, "public", href.replace(/^\//, ""));
        expect(existsSync(file)).toBe(true);
      }
    });

    // brand/ is the source of truth; brand/generate.sh copies into each public/. If someone hand-edits
    // a copy (or edits the source and forgets to re-run the generator), these drift and this fails.
    test("public/ copies are byte-identical to their brand/ source", () => {
      for (const source of ["favicon.svg", "favicon.ico"]) {
        const copy = readFileSync(join(appDir, "public", source));
        expect(copy.equals(readFileSync(join(brandDir, source)))).toBe(true);
      }
    });
  });
}

describe("brand/favicon.svg — the colour-scheme-aware tab icon", () => {
  const svg = readFileSync(join(brandDir, "favicon.svg"), "utf8");

  test("inverts the mark under a dark tab strip", () => {
    expect(svg).toContain("prefers-color-scheme: dark");
  });

  test("carries the Polyptic mark: a rounded holder, two hinged side panels, a centre bar", () => {
    expect(svg).toContain('rx="8.64"');
    expect((svg.match(/<polygon/g) ?? []).length).toBe(2);
  });

  test("is square and scalable — a viewBox, so it renders at any favicon size", () => {
    expect(svg).toContain('viewBox="0 0 32 32"');
  });
});

describe("brand/favicon.ico — the fallback for browsers that ignore SVG icons", () => {
  const ico = readFileSync(join(brandDir, "favicon.ico"));

  test("is a real ICO container holding the 16/32/48 px images", () => {
    // ICONDIR: reserved=0, type=1 (icon), count.
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);

    const widths = [0, 1, 2].map((i) => ico.readUInt8(6 + 16 * i));
    expect(widths).toEqual([16, 32, 48]);
  });

  test("every directory entry points at an in-bounds PNG stream", () => {
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    for (let i = 0; i < 3; i++) {
      const at = 6 + 16 * i;
      const bytes = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      expect(offset + bytes).toBeLessThanOrEqual(ico.length);
      // PNG-in-ICO: each embedded image is a whole PNG stream.
      expect(ico.subarray(offset, offset + 4).equals(PNG_MAGIC)).toBe(true);
    }
  });
});
