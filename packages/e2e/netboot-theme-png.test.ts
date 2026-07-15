/**
 * @polyptic/e2e, the boot theme's PNG gate (POL-130).
 *
 * The bug (real hardware, Wi-Fi boot, 2026-07-15, on a FRESHLY-CUT medium D79 could not explain):
 * "error: null src bitmap in grub_video_bitmap_create_scaled ... Press any key to continue" — with
 * theme.txt AND logo.png present and byte-perfect. Root cause, reproduced frame-by-frame under
 * OVMF on the operator's actual failing image: GRUB 2.12's gfxmenu runs `init_background()` on
 * every view draw and hands `view->raw_desktop_image` to the scaler UNCONDITIONALLY — a theme with
 * only `desktop-color` leaves that image NULL, the error sits latent in `grub_errno` while the
 * menu paints perfectly, and it fires onto the wall the instant the countdown boots the entry.
 *
 * Two consequences, both pinned here and in boot-splash.test.ts:
 *  - the theme now carries a real `desktop-image` (`bg.png`, a tiny solid-dark PNG), and every
 *    reader/writer treats the theme as a THREE-file set;
 *  - "file exists" is not "file loads" — a bitmap GRUB cannot DECODE passes every `[ -f ]` guard
 *    and still errors, so `grub-png-check.sh` gates every PNG at bake time (build fails) and at
 *    heal time (update-poll refuses to commit). This file runs its shell suite and pins the wiring.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const shTestPath = resolve(repoRoot, "deploy", "live", "test", "boot-theme-png.test.sh");
const lib = resolve(repoRoot, "deploy", "live", "usr", "local", "lib", "polyptic");
const read = (p: string) => readFileSync(p, "utf8");

describe("grub-png-check.sh: shell suite", () => {
  test("deploy/live/test/boot-theme-png.test.sh passes", async () => {
    const proc = Bun.spawn(["sh", shTestPath], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) console.error(out);
    expect(out).toContain("ALL PASS");
    expect(code).toBe(0);
  }, 60_000);
});

describe("the PNG gate is actually wired in — both writers, plus the reader's fail-closed guard", () => {
  const checker = read(resolve(lib, "grub-png-check.sh"));
  const updatePoll = read(resolve(lib, "update-poll.sh"));
  const renderLocal = read(resolve(lib, "render-local-grub.sh"));
  const buildMedium = read(resolve(repoRoot, "deploy", "build-boot-medium.sh"));

  test("the checker itself is POSIX sh + dd + od, nothing else (the POL-78 lesson)", () => {
    // The environments this ships to have no python, no file(1), historically not even dirname.
    // (Comments may NAME the banned tools — the code must not RUN them.)
    const code = checker
      .split("\n")
      .map((l) => l.replace(/#.*$/, ""))
      .join("\n");
    for (const exotic of ["python", "file -", "identify", "pngcheck", "dirname", "basename"]) {
      expect(code).not.toContain(exotic);
    }
    expect(code).toContain("od -An");
  });

  test("build-boot-medium.sh gates BOTH bitmaps and fails the BUILD on a reject", () => {
    expect(buildMedium).toContain("grub-png-check.sh");
    expect(buildMedium).toMatch(/for png in "\$LOGO_SRC" "\$BG_SRC"/);
    // …and bakes all three theme files, bitmaps before theme.txt (the POL-87 commit ordering).
    const bake = buildMedium.slice(buildMedium.indexOf("::/polyptic/boot/theme"));
    const logoAt = bake.indexOf("::/polyptic/boot/theme/logo.png");
    const bgAt = bake.indexOf("::/polyptic/boot/theme/bg.png");
    const themeAt = bake.indexOf("::/polyptic/boot/theme/theme.txt");
    expect(logoAt).toBeGreaterThan(-1);
    expect(bgAt).toBeGreaterThan(-1);
    expect(themeAt).toBeGreaterThan(logoAt);
    expect(themeAt).toBeGreaterThan(bgAt);
  });

  test("update-poll.sh validates every fetched bitmap BEFORE the commit chain", () => {
    const heal = updatePoll.slice(updatePoll.indexOf("heal_boot_theme()"));
    const checkAt = heal.indexOf("grub-png-check.sh");
    const commitAt = heal.indexOf('mv -f "$td/theme.txt.new"');
    expect(checkAt).toBeGreaterThan(-1);
    expect(commitAt).toBeGreaterThan(checkAt);
    // The orphan repair treats a bg-less theme — every pre-POL-130 fielded stick — as broken.
    expect(heal).toContain('[ ! -s "$td/bg.png" ]');
  });

  test("the GRUB guard is fail-closed on all three files: no bg.png → NO theme → plain menu", () => {
    // The reader's half of POL-130. GRUB cannot check "decodable", only "present" — presence of
    // all three is made trustworthy by the two writer gates above, and anything less than the
    // full set falls back to the plain dark menu, which boots silently (D65/D79's principle).
    expect(renderLocal).toContain(
      "if [ -f (\\$root)$THEME_DIR/theme.txt ]; then if [ -f (\\$root)$THEME_DIR/logo.png ]; then if [ -f (\\$root)$THEME_DIR/bg.png ]; then set theme=(\\$root)$THEME_DIR/theme.txt ; fi ; fi ; fi",
    );
  });
});
