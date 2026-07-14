/**
 * Distro detection + package-manager abstraction (D26: "distro-aware: apt/dnf/pacman → generic
 * across systemd Linux"). Native `.deb`/apt is the first-class, hardware-targeted path (D27);
 * dnf/pacman are best-effort and flagged for verification by the caller.
 */
import type { Sys } from "./system";
import type { Backend } from "./args";

export type PkgManager = "apt" | "dnf" | "pacman";

export interface Distro {
  id: string;
  idLike: string[];
  versionId: string | null;
  prettyName: string;
  pm: PkgManager;
  isUbuntu: boolean;
  isDebian: boolean;
}

function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function detectPm(sys: Sys, id: string, idLike: string[]): PkgManager {
  if (sys.which("apt-get")) return "apt";
  if (sys.which("dnf")) return "dnf";
  if (sys.which("pacman")) return "pacman";
  const all = [id, ...idLike];
  if (all.some((x) => x === "ubuntu" || x === "debian")) return "apt";
  if (all.some((x) => x === "fedora" || x === "rhel" || x === "centos")) return "dnf";
  if (all.some((x) => x === "arch")) return "pacman";
  throw new Error(
    `unsupported distro: found none of apt-get/dnf/pacman (need a systemd Linux). os-release ID="${id}"`,
  );
}

export function detectDistro(sys: Sys): Distro {
  const os = parseOsRelease(sys.readText("/etc/os-release") ?? "");
  const id = (os.ID ?? "").toLowerCase();
  const idLike = (os.ID_LIKE ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((x) => x.length > 0);
  const pm = detectPm(sys, id, idLike);
  const isUbuntu = id === "ubuntu" || idLike.includes("ubuntu");
  const isDebian = !isUbuntu && (id === "debian" || idLike.includes("debian"));
  return {
    id,
    idLike,
    versionId: os.VERSION_ID ?? null,
    prettyName: os.PRETTY_NAME ?? id ?? "unknown Linux",
    pm,
    isUbuntu,
    isDebian,
  };
}

// ── package-manager commands ───────────────────────────────────────────────────

// A FRESH Ubuntu/Debian box runs `unattended-upgrades` on first boot, which holds the dpkg lock;
// a plain `apt-get install` then dies immediately with "Could not get lock /var/lib/dpkg/lock-frontend".
// Tell apt to WAIT for the lock (up to 10 min) instead of failing, so zero-touch provisioning survives
// that race. Exported so callers doing direct apt-get calls use the same wait.
export const APT_LOCK_WAIT = ["-o", "DPkg::Lock::Timeout=600"] as const;

export function refreshCmd(pm: PkgManager): { cmd: string; args: string[] } {
  switch (pm) {
    case "apt":
      return { cmd: "apt-get", args: [...APT_LOCK_WAIT, "update"] };
    case "dnf":
      return { cmd: "dnf", args: ["-y", "makecache"] };
    case "pacman":
      return { cmd: "pacman", args: ["-Sy", "--noconfirm"] };
  }
}

export function installCmd(pm: PkgManager, pkgs: string[]): { cmd: string; args: string[] } {
  switch (pm) {
    case "apt":
      return { cmd: "apt-get", args: [...APT_LOCK_WAIT, "install", "-y", "--no-install-recommends", ...pkgs] };
    case "dnf":
      return { cmd: "dnf", args: ["install", "-y", ...pkgs] };
    case "pacman":
      return { cmd: "pacman", args: ["-S", "--needed", "--noconfirm", ...pkgs] };
  }
}

/** Whether a package is already installed (for nicer logs; install is idempotent regardless). */
export function isInstalled(sys: Sys, pm: PkgManager, pkg: string): boolean {
  switch (pm) {
    case "apt":
      return sys.probe("dpkg-query", ["-W", "-f=${Status}", pkg]).stdout.includes("install ok installed");
    case "dnf":
      return sys.probe("rpm", ["-q", pkg]).code === 0;
    case "pacman":
      return sys.probe("pacman", ["-Qi", pkg]).code === 0;
  }
}

// ── package name maps ──────────────────────────────────────────────────────────
//
// Generic capability → concrete package name per manager. The browsers (chrome + the surf fallback)
// and surf's two companions — xwayland, xdotool — are handled separately in browser.ts (D63/D77).

interface PkgSet {
  base: string[];
  wayland: string[];
  x11: string[];
  fonts: string[];
  /** Boot-splash: Plymouth + its script AND label plugins + an SVG rasteriser (rsvg-convert) — POL-7. */
  splash: string[];
  /** Video decode for the kiosk browser's <video> (Phase 7 media). See the comment below. */
  codecs: string[];
  /** POL-101 — HDMI-CEC tools. OPTIONAL by construction (see `optionalPackages`). */
  cec: string[];
}

// POL-7 (D43): our theme uses the `script` plugin and draws text via `Image.Text` (the live status
// line + version/host stamp). Plymouth renders that text through a SEPARATE **label** plugin. If the
// label plugin is absent, text rendering is disabled — and plymouth's script plugin then dereferences
// a NULL console viewer during sprite refresh (`ply_console_viewer_hide`) and SEGFAULTS on every
// boot, killing the splash. So the label plugin is REQUIRED, not optional. On Ubuntu it's a separate
// package (`plymouth-label`, which also pulls pango/fontconfig + a font); dracut's plymouth module
// then bundles the whole text-render closure into the initramfs for early boot.
// VIDEO (Phase 7 media). Chrome bundles its own decoders, so this block exists for the SURF
// FALLBACK (arm64 / POLYPTIC_BROWSER=surf boxes). WebKitGTK (`surf`) decodes <video> through
// GStreamer. `surf` pulls
// plugins-base + plugins-good as hard deps, which cover WebM/VP8/VP9 and
// Opus/Vorbis — but NOT H.264/AAC, i.e. the .mp4 almost everyone uploads. Those live in
// `gstreamer1.0-libav` (the ffmpeg-backed decoder), which is only a *recommends* — and setup installs
// with --no-install-recommends. Result, found on a real wall: uploaded MP4s silently never play,
// while WebM does. The decoders are ~130 MB uncompressed (~40 MB in the squashfs); a display-wall
// product that cannot show a video is not worth 40 MB of savings, so they are a hard dependency here.
const PACKAGES: Record<PkgManager, PkgSet> = {
  apt: {
    base: ["greetd", "dbus-user-session", "ca-certificates", "curl"],
    wayland: ["sway", "grim", "wayvnc"],
    // `xinput` disables physical input devices at session start (POL-60 kiosk lockdown).
    x11: ["xserver-xorg", "xinit", "i3", "x11vnc", "scrot", "imagemagick", "unclutter", "xinput"],
    fonts: ["fonts-dejavu-core", "fonts-liberation"],
    // Debian/Ubuntu: `script` plugin ships inside `plymouth`; `plymouth-label` = the text renderer
    // (REQUIRED, see above); `librsvg2-bin` = rsvg-convert.
    splash: ["plymouth", "plymouth-label", "librsvg2-bin"],
    codecs: ["gstreamer1.0-libav", "gstreamer1.0-plugins-good"],
    // `v4l-utils` carries `cec-ctl` (the KERNEL CEC API — preferred, no daemon); `cec-utils` carries
    // libcec's `cec-client` as the fallback stack.
    cec: ["v4l-utils", "cec-utils"],
  },
  dnf: {
    base: ["greetd", "ca-certificates", "curl"],
    wayland: ["sway", "grim", "wayvnc"],
    x11: ["xorg-x11-server-Xorg", "xorg-x11-xinit", "i3", "x11vnc", "scrot", "ImageMagick", "unclutter", "xinput"],
    fonts: ["dejavu-sans-fonts", "liberation-fonts"],
    // Fedora splits the script plugin, `plymouth-set-default-theme`, and the label renderer into
    // separate packages; `plymouth-plugin-label` is the text renderer (REQUIRED, see above).
    splash: ["plymouth", "plymouth-scripts", "plymouth-plugin-script", "plymouth-plugin-label", "librsvg2-tools"],
    // Fedora ships the ffmpeg-backed decoders in `gstreamer1-libav` (RPMFusion on stock Fedora).
    codecs: ["gstreamer1-libav", "gstreamer1-plugins-good"],
    cec: ["v4l-utils", "libcec"],
  },
  pacman: {
    base: ["greetd", "ca-certificates", "curl"],
    wayland: ["sway", "grim", "wayvnc"],
    x11: ["xorg-server", "xorg-xinit", "i3-wm", "x11vnc", "scrot", "imagemagick", "unclutter", "xorg-xinput"],
    fonts: ["ttf-dejavu", "ttf-liberation"],
    // Arch's `plymouth` bundles ALL plugins (script, label, set-default-theme); `librsvg` = rsvg-convert.
    splash: ["plymouth", "librsvg"],
    codecs: ["gst-libav", "gst-plugins-good"],
    cec: ["v4l-utils", "libcec"],
  },
};

/**
 * The packages to install for a given backend (browser added separately). `dev-open` provisions
 * only the base set (greetd) — it is not a real kiosk backend, but kept usable for completeness.
 * `splash` adds Plymouth + the rasteriser for the real kiosk backends (POL-7); pass `false` to skip.
 */
/**
 * POL-101 — packages we WANT but can live without: the HDMI-CEC tool-chain (`cec-ctl` from v4l-utils,
 * libcec's `cec-client`). These are installed in their OWN, failure-tolerant apt/dnf/pacman
 * transaction, deliberately separate from `corePackages`:
 *
 *   - a box with no CEC adapter loses nothing (panels still sleep via DPMS — see backends/power.ts);
 *   - `cec-utils` is not in every suite/arch, and an unresolvable optional package must NEVER take
 *     down an image build. A wall that boots without CEC is a working wall. A wall that doesn't boot
 *     is not.
 *
 * The caller runs this with `allowFail` and reports the outcome; the agent then PROBES at runtime
 * rather than assuming the install worked (setup and boot are years apart on a long-lived box).
 */
export function optionalPackages(pm: PkgManager, backend: Backend): string[] {
  if (backend === "dev-open") return []; // a dev host has no panel to power
  return [...PACKAGES[pm].cec];
}

export function corePackages(pm: PkgManager, backend: Backend, splash = true): string[] {
  const set = PACKAGES[pm];
  const splashPkgs = splash ? set.splash : [];
  // Codecs ride with the real kiosk backends: a wall shows video, and without the ffmpeg-backed
  // GStreamer decoders an uploaded MP4 renders as nothing at all (POL-46, found on real hardware).
  if (backend === "wayland-sway") return [...set.base, ...set.wayland, ...set.fonts, ...splashPkgs, ...set.codecs];
  if (backend === "x11-i3") return [...set.base, ...set.x11, ...set.fonts, ...splashPkgs, ...set.codecs];
  return [...set.base]; // dev-open
}
