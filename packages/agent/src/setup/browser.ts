/**
 * Browser install — the D27 gotcha lives here.
 *
 * D27: "browser = .deb Chromium (NOT the snap)". On Debian/Fedora/Arch `chromium` is a real native
 * package and this is trivial. The trap is **Ubuntu**, where `chromium-browser` is a transitional
 * package that pulls the **snap** — confined, slow to cold-start, awkward `--user-data-dir` profiles
 * — exactly what a kiosk must avoid.
 *
 * So on Ubuntu this module does NOT silently grab a random PPA. It:
 *   1. uses an existing non-snap Chromium/Chrome if one is already present;
 *   2. installs from `--chromium-deb <path|url>` if given;
 *   3. adds `--chromium-ppa <ppa>` (a real .deb source) if given, then installs `chromium-browser`;
 *   4. otherwise warns with an actionable message and flags it for verification — provisioning of the
 *      rest of the box still completes.
 *
 * `--browser cog` installs the WPE/WebKit `cog` kiosk browser instead — the documented fallback for
 * low-power clients (D27).
 */
import type { Sys } from "./system";
import type { Logger } from "./log";
import type { Distro } from "./distro";
import type { SetupOptions } from "./args";
import { installCmd } from "./distro";

interface ChromiumFound {
  bin: string;
  path: string;
  isSnap: boolean;
}

/** Locate an installed Chromium/Chrome and decide whether it is the (unwanted) snap. */
function detectChromium(sys: Sys): ChromiumFound | null {
  for (const bin of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    const path = sys.which(bin);
    if (!path) continue;
    const resolved = sys.probe("readlink", ["-f", path]).stdout.trim();
    const script = sys.readText(path) ?? "";
    const isSnap =
      path.startsWith("/snap/") ||
      resolved.startsWith("/snap/") ||
      /(\/snap\/|snap run )/.test(script);
    return { bin, path, isSnap };
  }
  return null;
}

function installDebFile(sys: Sys, source: string, log: Logger): void {
  let file = source;
  if (/^https?:\/\//.test(source)) {
    file = "/tmp/polyptych-chromium.deb";
    if (sys.which("curl")) {
      sys.exec("curl", ["-fSL", "-o", file, source], { desc: `download ${source}` });
    } else if (sys.which("wget")) {
      sys.exec("wget", ["-O", file, source], { desc: `download ${source}` });
    } else {
      throw new Error("need curl or wget to download --chromium-deb URL");
    }
  }
  // `apt-get install` of a local file resolves its dependencies (unlike `dpkg -i`).
  sys.exec("apt-get", ["install", "-y", file], {
    desc: `install Chromium .deb ${file}`,
    env: { DEBIAN_FRONTEND: "noninteractive" },
  });
  log.ok(`installed Chromium from ${source}`);
}

/**
 * Provision the kiosk browser. Pushes any operator-action notes into `needsVerification` (returned
 * to the report). Never hard-fails on the Ubuntu-snap case — the rest of setup must still complete.
 */
export function installBrowser(
  sys: Sys,
  distro: Distro,
  opts: SetupOptions,
  log: Logger,
  needsVerification: string[],
): void {
  log.step(`install browser (${opts.browser})`);

  if (opts.browser === "cog") {
    const cog = installCmd(distro.pm, ["cog"]);
    sys.exec(cog.cmd, cog.args, {
      desc: "install cog (WPE WebKit kiosk browser)",
      allowFail: distro.pm !== "apt",
      env: distro.pm === "apt" ? { DEBIAN_FRONTEND: "noninteractive" } : undefined,
    });
    if (distro.pm === "pacman") {
      needsVerification.push("cog is not in the Arch official repos (AUR only) — verify it installed.");
    }
    return;
  }

  // browser === "chromium"
  const existing = detectChromium(sys);
  if (existing && !existing.isSnap) {
    log.skip(`real (non-snap) Chromium already present at ${existing.path}`);
    return;
  }
  if (existing && existing.isSnap) {
    log.warn(`found a snap Chromium at ${existing.path} — D27 advises a .deb build; attempting one`);
  }

  // Explicit .deb wins everywhere.
  if (opts.chromiumDeb) {
    installDebFile(sys, opts.chromiumDeb, log);
    return;
  }

  // Explicit PPA (apt only): add a real-.deb source then install chromium-browser from it.
  if (opts.chromiumPpa && distro.pm === "apt") {
    sys.exec("apt-get", ["install", "-y", "software-properties-common"], {
      desc: "install add-apt-repository helper",
      env: { DEBIAN_FRONTEND: "noninteractive" },
    });
    sys.exec("add-apt-repository", ["-y", opts.chromiumPpa], { desc: `add PPA ${opts.chromiumPpa}` });
    sys.exec("apt-get", ["update"], { desc: "refresh after PPA" });
    sys.exec("apt-get", ["install", "-y", "chromium-browser"], {
      desc: `install chromium-browser from ${opts.chromiumPpa}`,
      env: { DEBIAN_FRONTEND: "noninteractive" },
    });
    needsVerification.push(
      `Confirm chromium-browser resolved to the .deb from ${opts.chromiumPpa} (NOT the snap): \`readlink -f $(command -v chromium-browser)\` must not point into /snap.`,
    );
    return;
  }

  // Native-package distros: chromium is a real .deb/.rpm/pkg.
  if (distro.pm === "dnf" || distro.pm === "pacman") {
    const cmd = installCmd(distro.pm, ["chromium"]);
    sys.exec(cmd.cmd, cmd.args, { desc: "install chromium", allowFail: true });
    needsVerification.push(`Verify the 'chromium' package installed on ${distro.prettyName}.`);
    return;
  }

  // apt + Debian: real native .deb.
  if (distro.isDebian) {
    sys.exec("apt-get", ["install", "-y", "chromium"], {
      desc: "install chromium (.deb)",
      env: { DEBIAN_FRONTEND: "noninteractive" },
    });
    return;
  }

  // apt + Ubuntu and nothing usable: don't silently install the snap. Be loud + actionable.
  const msg =
    "Ubuntu ships Chromium only as a confined snap, which D27 says to avoid for kiosks. " +
    "No real .deb was found and neither --chromium-deb nor --chromium-ppa was given. " +
    "Re-run with one of: `--chromium-ppa ppa:<vendor>/<repo>` (a PPA that ships a real .deb), " +
    "`--chromium-deb <path-or-url-to-.deb>`, or `--browser cog` (WPE fallback). " +
    "All other provisioning completed; only the browser is unresolved.";
  log.warn(msg);
  needsVerification.push(`Install a .deb Chromium on Ubuntu (snap avoided per D27): ${msg}`);
}
