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

export function refreshCmd(pm: PkgManager): { cmd: string; args: string[] } {
  switch (pm) {
    case "apt":
      return { cmd: "apt-get", args: ["update"] };
    case "dnf":
      return { cmd: "dnf", args: ["-y", "makecache"] };
    case "pacman":
      return { cmd: "pacman", args: ["-Sy", "--noconfirm"] };
  }
}

export function installCmd(pm: PkgManager, pkgs: string[]): { cmd: string; args: string[] } {
  switch (pm) {
    case "apt":
      return { cmd: "apt-get", args: ["install", "-y", "--no-install-recommends", ...pkgs] };
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
// Generic capability → concrete package name per manager. The browser is handled separately
// (browser.ts) because of the Ubuntu snap-Chromium gotcha (D27).

interface PkgSet {
  base: string[];
  wayland: string[];
  x11: string[];
  fonts: string[];
}

const PACKAGES: Record<PkgManager, PkgSet> = {
  apt: {
    base: ["greetd", "dbus-user-session", "ca-certificates", "curl"],
    wayland: ["sway", "grim", "wayvnc"],
    x11: ["xserver-xorg", "xinit", "i3", "x11vnc", "scrot", "imagemagick", "unclutter"],
    fonts: ["fonts-dejavu-core", "fonts-liberation"],
  },
  dnf: {
    base: ["greetd", "ca-certificates", "curl"],
    wayland: ["sway", "grim", "wayvnc"],
    x11: ["xorg-x11-server-Xorg", "xorg-x11-xinit", "i3", "x11vnc", "scrot", "ImageMagick", "unclutter"],
    fonts: ["dejavu-sans-fonts", "liberation-fonts"],
  },
  pacman: {
    base: ["greetd", "ca-certificates", "curl"],
    wayland: ["sway", "grim", "wayvnc"],
    x11: ["xorg-server", "xorg-xinit", "i3-wm", "x11vnc", "scrot", "imagemagick", "unclutter"],
    fonts: ["ttf-dejavu", "ttf-liberation"],
  },
};

/**
 * The packages to install for a given backend (browser added separately). `dev-open` provisions
 * only the base set (greetd) — it is not a real kiosk backend, but kept usable for completeness.
 */
export function corePackages(pm: PkgManager, backend: Backend): string[] {
  const set = PACKAGES[pm];
  if (backend === "wayland-sway") return [...set.base, ...set.wayland, ...set.fonts];
  if (backend === "x11-i3") return [...set.base, ...set.x11, ...set.fonts];
  return [...set.base]; // dev-open
}
