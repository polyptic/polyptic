/**
 * Browser install — surf, and only surf (D63).
 *
 * Polyptic ships ONE kiosk browser: `surf`, the suckless WebKitGTK browser, a real `.deb` in Ubuntu's
 * main archive. That single choice is what makes the on-screen inspector (POL-50) the debugging
 * story, because WebKitGTK exposes no remote one. See D63 for what else was considered.
 *
 * Two companions come with it, and both were learned from a wall that didn't light up:
 *   - `xwayland` — surf is an X11 (WebKitGTK/Xlib) client. Under the wayland-sway backend it renders
 *     through XWayland, and sway starts XWayland lazily but ONLY if the binary exists; without it
 *     sway logs `Cannot find Xwayland binary`, the browser never opens, and the wall sits on a black
 *     compositor forever (found live in the POL-38 UTM boot).
 *   - `xdotool` — the agent pops surf's Web Inspector by synthesising Ctrl+Shift+O into its window
 *     (POL-50). Without it the console's Inspect action refuses, with that reason.
 */
import type { Sys } from "./system";
import type { Logger } from "./log";
import type { Distro } from "./distro";
import type { SetupOptions } from "./args";
import { installCmd } from "./distro";

/** Distro-specific name for the Xwayland server package. */
function xwaylandPackage(distro: Distro): string {
  if (distro.pm === "pacman") return "xorg-xwayland";
  if (distro.pm === "dnf") return "xorg-x11-server-Xwayland";
  return "xwayland";
}

/**
 * Provision the kiosk browser. Pushes any operator-action notes into `needsVerification` (returned
 * to the report).
 */
export function installBrowser(
  sys: Sys,
  distro: Distro,
  opts: SetupOptions,
  log: Logger,
  needsVerification: string[],
): void {
  log.step("install browser (surf)");

  // xdotool drives the on-screen inspector on BOTH backends: surf is an X11 client even under sway,
  // so the keystroke goes through X either way.
  const pkgs = ["surf", "xdotool"];
  if (opts.backend === "wayland-sway") pkgs.push(xwaylandPackage(distro));

  const cmd = installCmd(distro.pm, pkgs);
  sys.exec(cmd.cmd, cmd.args, {
    desc: "install surf (suckless WebKitGTK kiosk browser), xdotool, and Xwayland for the sway backend",
    allowFail: distro.pm !== "apt",
    env: distro.pm === "apt" ? { DEBIAN_FRONTEND: "noninteractive" } : undefined,
  });

  if (distro.pm === "pacman") {
    needsVerification.push("surf may not be in the Arch official repos (AUR) — verify it installed.");
  }
}
