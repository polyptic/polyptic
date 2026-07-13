/**
 * Browser install — Google Chrome first, surf as the fallback (POL-67/D77; supersedes D63's
 * surf-only clause).
 *
 * Chrome is the kiosk browser wherever it is installable: it runs NATIVE Wayland (EGL/GBM straight
 * to the GPU — surf-under-Xwayland software-rendered and CPU-pegged on real amdgpu hardware, the
 * POL-67 showstopper) and carries the loopback remote-debugging port the DevTools tunnel needs.
 * It comes from GOOGLE'S OWN apt repo (dl.google.com/linux/chrome/deb): vendor-signed and
 * security-updated, which is what lets the nightly image refresh's plain `apt-get upgrade` track
 * the latest stable Chrome — the repo file + key written here persist into the squashfs.
 *
 * Installability is narrower than surf's, hence the fallback:
 *   - apt-only (Google publishes no dnf/pacman repo we'd trust the same way), and
 *   - only for architectures Google actually PUBLISHES, which we ask the repo rather than hardcode.
 *     Google has announced arm64 Linux Chrome (blog.google, Q2 2026) but as of 2026-07-13 the apt
 *     repo still serves amd64 only — `dists/stable/main/binary-arm64/Packages` 404s while
 *     `binary-amd64` is 200. A hardcoded `arch === "amd64"` test would therefore be right today and
 *     silently wrong the week Google ships, so `chromeRepoPublishes()` HEADs the arch's index at
 *     provision time: arm64 boxes light up on Chrome automatically on their next full rebuild, with
 *     no code change, and keep surf until then.
 *
 * surf + its two companions are ALWAYS installed, learned from walls that didn't light up:
 *   - `xwayland` — surf is an X11 (WebKitGTK/Xlib) client; sway starts Xwayland lazily but ONLY if
 *     the binary exists, else the fallback browser never opens (found live in the POL-38 UTM boot).
 *   - `xdotool` — the agent pops surf's Web Inspector by synthesising Ctrl+Shift+O (POL-50).
 * The agent picks at runtime: Chrome when present, else surf (backends/chrome.ts selectKioskBrowser),
 * so one image serves both arches and `POLYPTIC_BROWSER=surf` remains the per-box escape hatch.
 */
import type { Sys } from "./system";
import type { Logger } from "./log";
import type { Distro } from "./distro";
import type { SetupOptions } from "./args";
import { APT_LOCK_WAIT, installCmd } from "./distro";

/** Google's armored signing key — apt ≥ 2.4 takes `.asc` in Signed-By directly, so no gnupg dep. */
const GOOGLE_KEY_URL = "https://dl.google.com/linux/linux_signing_key.pub";
const GOOGLE_KEY_PATH = "/etc/apt/keyrings/google-chrome.asc";
/** Google's Chrome apt repo (no trailing slash — the source line and the index probe both build on it). */
const GOOGLE_REPO_URL = "https://dl.google.com/linux/chrome/deb";
/** The exact path Chrome's own postinst manages: it greps the apt sources for its repo URL and
 *  leaves an existing entry alone, so writing it OURSELVES here prevents a duplicate-source pair. */
const GOOGLE_LIST_PATH = "/etc/apt/sources.list.d/google-chrome.list";

/** Distro-specific name for the Xwayland server package. */
function xwaylandPackage(distro: Distro): string {
  if (distro.pm === "pacman") return "xorg-xwayland";
  if (distro.pm === "dnf") return "xorg-x11-server-Xwayland";
  return "xwayland";
}

/** dpkg's architecture, e.g. "amd64" | "arm64" (empty string when undeterminable / non-dpkg). */
function dpkgArch(sys: Sys): string {
  return sys.probe("dpkg", ["--print-architecture"]).stdout.trim();
}

/**
 * Does Google's apt repo actually publish an index for `arch`? A HEAD against the arch's `Packages`
 * file — the same question apt itself will ask, asked BEFORE we write the source entry.
 *
 * Asking beats hardcoding twice over. It future-proofs the announced-but-unshipped arm64 build (see
 * the header), and it is also what keeps a non-amd64 build SAFE: writing `deb [arch=arm64 …]` for an
 * index that 404s makes the very next `apt-get update` fail, which would take the whole arm64 image
 * build down with it. Read-only, so it runs honestly under `--dry-run`.
 */
function chromeRepoPublishes(sys: Sys, arch: string): boolean {
  if (!arch) return false;
  const url = `${GOOGLE_REPO_URL}/dists/stable/main/binary-${arch}/Packages`;
  // -I HEAD, -f => non-zero exit on 4xx/5xx. A network-less build host simply gets "no", and falls
  // back to surf rather than failing the build.
  return sys.probe("curl", ["-fsIL", "-o", "/dev/null", "--max-time", "20", url]).code === 0;
}

/**
 * Add Google's apt repo (key + source entry) and install `google-chrome-stable`. The repo entry is
 * the load-bearing half: it is what makes every later `apt-get upgrade` (the nightly image refresh,
 * the weekly full rebuild, a self-managed box's own updates) pull the then-latest stable Chrome.
 */
function installChrome(sys: Sys, arch: string, log: Logger, needsVerification: string[]): void {
  sys.ensureDir("/etc/apt/keyrings", { mode: 0o755 });
  // curl is in the base package set (and the live image); fetch the armored key as-is.
  sys.exec("sh", ["-c", `curl -fsSL ${GOOGLE_KEY_URL} -o ${GOOGLE_KEY_PATH}`], {
    desc: "fetch Google's apt signing key",
  });
  // The classic one-line format at Chrome's own path (see GOOGLE_LIST_PATH above). `arch=` is PINNED
  // to this box's architecture — and to one the repo was just confirmed to publish, so `apt-get
  // update` below cannot trip over a 404 index.
  sys.writeFile(
    GOOGLE_LIST_PATH,
    `deb [arch=${arch} signed-by=${GOOGLE_KEY_PATH}] ${GOOGLE_REPO_URL}/ stable main\n`,
    { mode: 0o644, desc: "Google Chrome apt repo" },
  );
  sys.exec("apt-get", [...APT_LOCK_WAIT, "update"], {
    desc: "refresh package index (now including Google's repo)",
    env: { DEBIAN_FRONTEND: "noninteractive" },
  });
  sys.exec(
    "apt-get",
    [...APT_LOCK_WAIT, "install", "-y", "--no-install-recommends", "google-chrome-stable"],
    { desc: "install google-chrome-stable", env: { DEBIAN_FRONTEND: "noninteractive" } },
  );
  needsVerification.push(
    "Chrome installed from Google's repo — verify the kiosk comes up on Chrome (agent log: `kiosk browser: chrome`).",
  );
  log.ok("google-chrome-stable installed (Google's repo persists for apt-upgrade tracking)");
}

/**
 * Provision the kiosk browser(s). Pushes any operator-action notes into `needsVerification`
 * (returned to the report).
 */
export function installBrowser(
  sys: Sys,
  distro: Distro,
  opts: SetupOptions,
  log: Logger,
  needsVerification: string[],
): void {
  log.step("install browser (chrome + surf fallback)");

  // The fallback set first — surf lights the wall on every arch/distro this runs on. xdotool drives
  // the on-panel inspector: surf is an X11 client even under sway, so the keystroke goes through X.
  const pkgs = ["surf", "xdotool"];
  if (opts.backend === "wayland-sway") pkgs.push(xwaylandPackage(distro));

  const cmd = installCmd(distro.pm, pkgs);
  sys.exec(cmd.cmd, cmd.args, {
    desc: "install surf (WebKitGTK fallback kiosk browser), xdotool, and Xwayland for the sway backend",
    allowFail: distro.pm !== "apt",
    env: distro.pm === "apt" ? { DEBIAN_FRONTEND: "noninteractive" } : undefined,
  });

  if (distro.pm === "pacman") {
    needsVerification.push("surf may not be in the Arch official repos (AUR) — verify it installed.");
  }

  // Chrome, where Google actually ships it — ASKED, not assumed (see the header). Anything else
  // keeps surf, which is why surf is installed unconditionally above.
  if (distro.pm !== "apt") {
    log.skip(`Chrome skipped: Google ships an apt repo only (this box: ${distro.pm}) — surf drives the kiosk`);
    return;
  }
  const arch = dpkgArch(sys);
  if (!chromeRepoPublishes(sys, arch)) {
    log.skip(
      `Chrome skipped: Google's apt repo publishes no ${arch || "unknown-arch"} index today ` +
        `— surf drives the kiosk. (arm64 Chrome is announced; this box picks it up automatically ` +
        `on the first full rebuild after Google publishes it.)`,
    );
    return;
  }
  installChrome(sys, arch, log, needsVerification);
}
