/**
 * Chrome's install gate (POL-67/D77).
 *
 * The gate is ASKED, not assumed: `setup` HEADs Google's apt repo for the box's architecture instead
 * of hardcoding `amd64`. Two things must hold, and both are the kind that fail silently on a wall:
 *
 *   - a published arch installs Chrome, pinning `deb [arch=…]` to THAT arch — so arm64 adopts Chrome
 *     automatically on its first full rebuild after Google publishes it (announced, not shipped as of
 *     2026-07-13), with no code change;
 *   - an UNpublished arch installs no repo at all. This is the load-bearing half: writing a source
 *     line for an index that 404s makes the next `apt-get update` fail, which would take the entire
 *     arm64 image build down with it. surf must be left driving the kiosk instead.
 */
import { describe, expect, test } from "bun:test";

import { installBrowser } from "../src/setup/browser";
import type { Distro } from "../src/setup/distro";
import type { SetupOptions } from "../src/setup/args";
import type { Sys } from "../src/setup/system";

const APT: Distro = {
  id: "ubuntu",
  idLike: ["debian"],
  versionId: "26.04",
  prettyName: "Ubuntu 26.04",
  pm: "apt",
  isUbuntu: true,
  isDebian: false,
};

const OPTS = { backend: "wayland-sway" } as SetupOptions;

/** A Sys that reports `arch` from dpkg and lets the repo probe succeed only for `publishedArches`. */
function fakeSys(arch: string, publishedArches: string[]) {
  const execs: string[] = [];
  const writes: Record<string, string> = {};
  const sys = {
    probe(cmd: string, args: string[] = []) {
      if (cmd === "dpkg") return { code: 0, stdout: `${arch}\n`, stderr: "" };
      if (cmd === "curl") {
        const url = args.find((a) => a.startsWith("https://")) ?? "";
        const ok = publishedArches.some((a) => url.includes(`binary-${a}/`));
        return { code: ok ? 0 : 22, stdout: "", stderr: "" }; // curl -f exits 22 on HTTP 4xx
      }
      return { code: 1, stdout: "", stderr: "" };
    },
    exec(cmd: string, args: string[] = []) {
      execs.push(`${cmd} ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    },
    writeFile(path: string, content: string) {
      writes[path] = content;
    },
    ensureDir() {},
  } as unknown as Sys;
  const log = { step() {}, skip() {}, ok() {}, info() {}, plan() {}, error() {}, banner() {} };
  return { sys, log, execs, writes };
}

const GOOGLE_LIST = "/etc/apt/sources.list.d/google-chrome.list";
const ran = (execs: string[], needle: string): boolean => execs.some((e) => e.includes(needle));

describe("Chrome install gate — asked, not hardcoded", () => {
  test("a PUBLISHED arch (amd64 today) installs Chrome, pinned to that arch", () => {
    const { sys, log, execs, writes } = fakeSys("amd64", ["amd64"]);
    installBrowser(sys, APT, OPTS, log, []);

    expect(ran(execs, "google-chrome-stable")).toBe(true);
    expect(writes[GOOGLE_LIST]).toContain("[arch=amd64");
    expect(writes[GOOGLE_LIST]).toContain("https://dl.google.com/linux/chrome/deb/ stable main");
  });

  test("an UNPUBLISHED arch (arm64 today) installs NO repo — a 404 index would fail apt-get update", () => {
    const { sys, log, execs, writes } = fakeSys("arm64", ["amd64"]);
    installBrowser(sys, APT, OPTS, log, []);

    expect(writes[GOOGLE_LIST]).toBeUndefined();
    expect(ran(execs, "google-chrome-stable")).toBe(false);
    // …and the wall still lights up: surf + its X11 companions are installed unconditionally.
    expect(ran(execs, "surf")).toBe(true);
    expect(ran(execs, "xwayland")).toBe(true);
  });

  test("arm64 adopts Chrome the day Google publishes it — no code change, just a rebuild", () => {
    // Same arm64 box, but now the repo serves an arm64 index.
    const { sys, log, execs, writes } = fakeSys("arm64", ["amd64", "arm64"]);
    installBrowser(sys, APT, OPTS, log, []);

    expect(ran(execs, "google-chrome-stable")).toBe(true);
    expect(writes[GOOGLE_LIST]).toContain("[arch=arm64");
  });

  test("a non-apt distro never reaches the repo — surf drives the kiosk", () => {
    const { sys, log, execs, writes } = fakeSys("amd64", ["amd64"]);
    installBrowser(sys, { ...APT, pm: "pacman" }, OPTS, log, []);

    expect(writes[GOOGLE_LIST]).toBeUndefined();
    expect(ran(execs, "google-chrome-stable")).toBe(false);
  });
});
