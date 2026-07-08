/**
 * `polyptic-agent setup` — install / provision flow.
 *
 * Turns a stock systemd Linux box into a Polyptic kiosk (D26/D27). Every step is idempotent and
 * logged; `--dry-run` previews without touching anything. The cold-boot chain it wires:
 *
 *   greetd autologin (user=kiosk) -> sway (or i3) -> systemd --user polyptic-session.target
 *     -> polyptic-agent.service (Restart=always) -> Chromium-per-output
 *
 * The agent then reads /etc/polyptic/agent.toml, enrols over WSS (2b), and an operator approves it
 * in the console. "apt = the box is a display; console = what it shows." (D26)
 */
import { basename } from "node:path";
import type { Sys } from "./system";
import type { Logger } from "./log";
import type { RenderMode, SetupOptions } from "./args";
import type { SetupState } from "./state";
import { hostname as osHostname } from "node:os";
import { detectDistro, corePackages, installCmd, refreshCmd } from "./distro";
import { installBrowser } from "./browser";
import { loadState, saveState } from "./state";
import { renderAgentToml } from "./config";
import { agentVersion } from "../version";
import {
  AGENT_SERVICE,
  COMPOSITOR_LAUNCHER,
  SESSION_TARGET,
  agentServiceUnit,
  compositorLauncher,
  greetdConfig,
  i3Config,
  sessionTargetUnit,
  swayConfig,
  xinitrc,
} from "./templates";
import {
  PLYMOUTHD_CONF_PATH,
  PLYMOUTH_DRACUT_CONF_PATH,
  PLYMOUTH_QUIT_DROPIN,
  PLYMOUTH_THEME_DIR,
  PLYMOUTH_THEME_NAME,
  mergeCmdlineTxt,
  mergeGrubCmdline,
  plymouthDracutConf,
  plymouthQuitDropin,
  plymouthScript,
  plymouthTheme,
  plymouthdConf,
  splashAssets,
} from "./plymouth";

export interface SetupResult {
  needsVerification: string[];
  assumptions: string[];
}

const UNIT_DIR = "/etc/systemd/user";

export function runInstall(sys: Sys, opts: SetupOptions, log: Logger): SetupResult {
  const needsVerification: string[] = [];
  const assumptions: string[] = [];

  if (opts.backend === "dev-open") {
    throw new Error(
      "--backend dev-open is a development backend (opens URLs in the host browser) and needs no " +
        "device provisioning. Use --backend wayland-sway (default) or x11-i3.",
    );
  }

  const distro = detectDistro(sys);
  const isX11 = opts.backend === "x11-i3";
  const home = `/home/${opts.user}`;

  log.banner(
    `Polyptic device setup — ${distro.prettyName} (pm=${distro.pm}, backend=${opts.backend}, user=${opts.user})`,
  );

  const state: SetupState = loadState(sys);
  state.user = opts.user;
  state.backend = opts.backend;
  state.installedAt = new Date().toISOString();

  // Resolve the effective render mode up front so the compositor launcher AND the browser agree.
  // An explicit --render wins; `auto` on a virtual GPU is pinned to `software` here (see
  // resolveRenderMode) — the launcher's runtime crash-fallback alone misses a virtio-gpu, whose
  // wlroots GLES compositor survives yet needs software cursors and whose Chromium needs --disable-gpu.
  opts.render = resolveRenderMode(sys, opts.render, log);

  // 1 ─ dependencies
  if (opts.installDeps) {
    installDeps(sys, distro, opts, log, needsVerification);
  } else {
    log.step("install dependencies");
    log.skip("dependency install skipped (--skip-deps)");
  }

  // 2 ─ kiosk user
  ensureKioskUser(sys, opts, log, home, state, assumptions);

  // 3 ─ greetd autologin config. initial_session runs the polyptic-compositor launcher (written in
  // step 4), not a bare sway/startx, so the wall loops the compositor forever (never a text login)
  // and picks a renderer empirically (works on no-3D virtual GPUs without crippling real ones).
  log.step("write greetd autologin config");
  sys.writeFile(
    "/etc/greetd/config.toml",
    greetdConfig({ user: opts.user, sessionCommand: COMPOSITOR_LAUNCHER }),
    { mode: 0o644, backupOriginal: true, desc: "greetd config" },
  );
  assumptions.push("greetd's fallback default_session runs as the kiosk user (no separate 'greeter' user needed — that user isn't created by the greetd package on every distro).");
  assumptions.push(
    `the kiosk compositor is launched via ${COMPOSITOR_LAUNCHER} — a restart-on-exit loop (so the ` +
      `wall never drops to greetd's text greeter) with POLYPTIC_RENDER=${opts.render} render selection.`,
  );

  // 4 ─ compositor config (sway or i3)
  writeCompositorConfig(sys, opts, log, home, isX11);

  // 5 ─ systemd user unit(s)
  log.step("write systemd user units");
  sys.writeFile(`${UNIT_DIR}/${SESSION_TARGET}`, sessionTargetUnit(), {
    mode: 0o644,
    desc: SESSION_TARGET,
  });
  sys.writeFile(
    `${UNIT_DIR}/${AGENT_SERVICE}`,
    agentServiceUnit({ agentBin: opts.agentBin, configPath: opts.configPath }),
    { mode: 0o644, desc: AGENT_SERVICE },
  );
  assumptions.push(
    `the agent single binary is installed at ${opts.agentBin} (the .deb / installer places it; override with --agent-bin).`,
  );

  // 6 ─ /etc/polyptic/agent.toml
  writeAgentConfig(sys, opts, log, needsVerification);

  // 6b ─ boot splash (Plymouth): branded logo + version/host + live status, from early boot until
  // the player paints, in place of raw kernel/systemd console text (POL-7). Before enableServices
  // so its daemon-reload picks up the plymouth-quit drop-in. (dev-open already threw above.)
  if (opts.splash) {
    configureSplash(sys, opts, log, state, needsVerification, assumptions);
  } else {
    log.step("configure boot splash");
    log.skip("boot splash skipped (--no-splash)");
  }

  // 7 ─ enable services + make greetd the display manager
  if (opts.enable) {
    enableServices(sys, log, state);
  } else {
    log.step("enable services");
    log.skip("service enable + display-manager swap skipped (--no-enable)");
  }

  // persist state for a faithful uninstall
  saveState(sys, state);

  // 8 ─ optionally start now
  if (opts.start && opts.enable) {
    startNow(sys, log);
  } else {
    log.step("start");
    log.info("not started now — power-cycle (or `sudo systemctl restart greetd`) to bring up the kiosk.");
  }

  collectBackendVerification(opts, isX11, needsVerification);
  printNextSteps(opts, log);

  return { needsVerification, assumptions };
}

// ── steps ──────────────────────────────────────────────────────────────────────

function installDeps(
  sys: Sys,
  distro: ReturnType<typeof detectDistro>,
  opts: SetupOptions,
  log: Logger,
  needsVerification: string[],
): void {
  log.step(`install dependencies (${distro.pm})`);
  const env = distro.pm === "apt" ? { DEBIAN_FRONTEND: "noninteractive" } : undefined;

  const refresh = refreshCmd(distro.pm);
  sys.exec(refresh.cmd, refresh.args, {
    desc: "refresh package index",
    allowFail: distro.pm !== "apt",
    env,
  });

  const pkgs = corePackages(distro.pm, opts.backend, opts.splash);
  const inst = installCmd(distro.pm, pkgs);
  sys.exec(inst.cmd, inst.args, { desc: `install ${pkgs.join(" ")}`, env });

  installBrowser(sys, distro, opts, log, needsVerification);

  if (distro.isUbuntu) {
    needsVerification.push(
      "On Ubuntu, greetd/sway live in 'universe' — confirm that component is enabled so apt resolves them.",
    );
  }
  if (distro.pm !== "apt") {
    needsVerification.push(
      `Package names for ${distro.pm} are best-effort (D26/D27 target apt/.deb first) — verify ` +
        `greetd/sway/grim/wayvnc/fonts resolved on ${distro.prettyName}.`,
    );
  }
}

function ensureKioskUser(
  sys: Sys,
  opts: SetupOptions,
  log: Logger,
  home: string,
  state: SetupState,
  assumptions: string[],
): void {
  log.step(`ensure kiosk user '${opts.user}'`);
  if (sys.probe("getent", ["passwd", opts.user]).code === 0) {
    log.skip(`user '${opts.user}' already exists`);
  } else {
    sys.exec(
      "useradd",
      ["--create-home", "--shell", "/bin/bash", "--user-group", "--comment", "Polyptic kiosk", opts.user],
      { desc: `create user ${opts.user}` },
    );
    state.createdUser = true;
  }

  // Groups the compositor/seat/GPU need. Only add those that exist on this distro.
  const wanted = ["video", "input", "render", "audio", "tty", "seat", "plugdev"];
  const have = wanted.filter((g) => sys.probe("getent", ["group", g]).code === 0);
  if (have.length > 0) {
    sys.exec("usermod", ["-aG", have.join(","), opts.user], {
      desc: `add ${opts.user} to groups ${have.join(",")}`,
      allowFail: true,
    });
  }
  assumptions.push(
    "systemd-logind provides seat management for the compositor (no seatd installed); kiosk added to video/input/render.",
  );

  // Home + per-machine state dir (where the durable credential is persisted), owned by kiosk.
  sys.ensureDir(home, { owner: opts.user, group: opts.user });
  sys.ensureDir(`${home}/.polyptic`, { mode: 0o700, owner: opts.user, group: opts.user });
}

function writeCompositorConfig(
  sys: Sys,
  opts: SetupOptions,
  log: Logger,
  home: string,
  isX11: boolean,
): void {
  log.step(`write ${isX11 ? "i3 (X11)" : "sway (Wayland)"} config`);
  sys.ensureDir(`${home}/.config`, { owner: opts.user, group: opts.user });

  if (isX11) {
    sys.ensureDir(`${home}/.config/i3`, { owner: opts.user, group: opts.user });
    sys.writeFile(`${home}/.config/i3/config`, i3Config({ outputs: opts.outputs, sessionTarget: SESSION_TARGET }), {
      mode: 0o644,
      owner: opts.user,
      group: opts.user,
      desc: "i3 config",
    });
    sys.writeFile(`${home}/.xinitrc`, xinitrc(), {
      mode: 0o755,
      owner: opts.user,
      group: opts.user,
      desc: ".xinitrc",
    });
  } else {
    sys.ensureDir(`${home}/.config/sway`, { owner: opts.user, group: opts.user });
    sys.writeFile(`${home}/.config/sway/config`, swayConfig({ outputs: opts.outputs, sessionTarget: SESSION_TARGET }), {
      mode: 0o644,
      owner: opts.user,
      group: opts.user,
      desc: "sway config",
    });
  }

  // Robust launcher greetd's initial_session runs instead of bare sway/startx: a forever-restart
  // loop (the wall never falls through to a text login) + empirical hardware/software render
  // selection (renders on no-3D virtual GPUs without handicapping real GPUs). System-wide, root-
  // owned, executable.
  const compositorCommand = isX11 ? "startx" : "sway";
  sys.writeFile(
    COMPOSITOR_LAUNCHER,
    compositorLauncher({ backend: opts.backend, sessionCommand: compositorCommand, render: opts.render }),
    { mode: 0o755, desc: "compositor launcher" },
  );
}

function writeAgentConfig(sys: Sys, opts: SetupOptions, log: Logger, needsVerification: string[]): void {
  log.step("write agent config (/etc/polyptic)");
  sys.ensureDir("/etc/polyptic", { mode: 0o755 });

  if (opts.serverUrl) {
    const toml = renderAgentToml(
      {
        serverUrl: opts.serverUrl,
        bootstrapToken: opts.bootstrapToken,
        backend: opts.backend,
        browser: opts.browser,
        connector: opts.connector,
      },
      { example: false },
    );
    // Readable by the kiosk user that runs the agent; owned by root (it holds the bootstrap token).
    sys.writeFile(opts.configPath, toml, {
      mode: 0o640,
      owner: "root",
      group: opts.user,
      desc: "agent.toml",
    });
  } else {
    const example = renderAgentToml(
      { backend: opts.backend, browser: opts.browser, connector: opts.connector },
      { example: true },
    );
    sys.writeFile(`${opts.configPath}.example`, example, { mode: 0o644, desc: "agent.toml.example" });
    if (sys.exists(opts.configPath)) {
      // Re-run on a configured box: never clobber the live agent.toml (it holds server_url + token).
      log.skip(`${opts.configPath} already exists — left untouched`);
    } else {
      // No server URL is a real deployment shape, not just a half-done install: the netboot live
      // image (POL-33/POL-38) receives server_url + token per boot from the kernel cmdline via
      // /run/polyptic/agent.env. The DISPLAY config must still land in a real agent.toml, otherwise
      // POLYPTIC_BACKEND stays unset and the agent silently falls back to dev-open — sway comes up
      // but no browser is ever launched (found live in the POL-38 UTM boot). The empty
      // server_url/bootstrap_token here are ignored by applyConfigFileToEnv, and real env wins.
      const toml = renderAgentToml(
        { backend: opts.backend, browser: opts.browser, connector: opts.connector },
        { example: false },
      );
      sys.writeFile(opts.configPath, toml, {
        mode: 0o640,
        owner: "root",
        group: opts.user,
        desc: "agent.toml (display config; server_url arrives via cmdline env or a later edit)",
      });
      log.warn(
        `no --server-url given: wrote ${opts.configPath} with the display config only. The agent ` +
          `will NOT connect until server_url + bootstrap_token arrive (edit the file, or boot a live ` +
          `image with polyptic.server_url=/polyptic.token= on the kernel cmdline).`,
      );
      needsVerification.push(
        `Provide server_url + bootstrap_token (edit ${opts.configPath}, or the kernel cmdline on a live image) before the agent can enrol.`,
      );
    }
  }
}

// ── boot splash (Plymouth) — POL-7 ───────────────────────────────────────────────

function configureSplash(
  sys: Sys,
  opts: SetupOptions,
  log: Logger,
  state: SetupState,
  needsVerification: string[],
  assumptions: string[],
): void {
  log.step("configure boot splash (Plymouth theme + kernel cmdline)");

  const version = process.env.POLYPTIC_VERSION?.trim() || agentVersion();
  const host = osHostname() || "polyptic";

  // 1 ─ theme descriptor + script → /usr/share/plymouth/themes/polyptic
  sys.ensureDir(PLYMOUTH_THEME_DIR, { mode: 0o755 });
  sys.writeFile(`${PLYMOUTH_THEME_DIR}/${PLYMOUTH_THEME_NAME}.plymouth`, plymouthTheme(), {
    mode: 0o644,
    desc: "plymouth theme descriptor",
  });
  sys.writeFile(`${PLYMOUTH_THEME_DIR}/${PLYMOUTH_THEME_NAME}.script`, plymouthScript(), {
    mode: 0o644,
    desc: "plymouth theme script",
  });

  // 2 ─ SVG sources + rasterised PNGs. The logo is the swappable vector asset (POL-7): replace
  // logo.svg with the final designed lockup and re-run setup. The stamp bakes host + build version.
  let rasterOk = true;
  for (const asset of splashAssets({ hostname: host, version })) {
    const svgPath = `${PLYMOUTH_THEME_DIR}/${asset.base}.svg`;
    const pngPath = `${PLYMOUTH_THEME_DIR}/${asset.base}.png`;
    sys.writeFile(svgPath, asset.svg, { mode: 0o644, desc: `splash ${asset.base}.svg` });
    if (!rasterizeSvg(sys, log, svgPath, pngPath, asset.width, asset.height)) rasterOk = false;
  }
  if (!rasterOk) {
    log.warn(
      "could not rasterise the splash SVGs to PNG (no rsvg-convert/ImageMagick). The theme is " +
        "installed but the logo stays blank until a rasteriser is available — install librsvg2-bin " +
        "and re-run `polyptic-agent setup`.",
    );
    needsVerification.push(
      "Boot splash: install an SVG rasteriser (librsvg2-bin / librsvg2-tools / librsvg) so the logo " +
        "PNGs generate, then re-run setup.",
    );
  }

  // 3 ─ clean hand-off: retain the last splash frame when Plymouth quits (no console flash to sway).
  sys.writeFile(PLYMOUTH_QUIT_DROPIN, plymouthQuitDropin(), {
    mode: 0o644,
    desc: "plymouth-quit retain-splash drop-in",
  });

  // 4 ─ make it the default theme + rebuild the initramfs so it shows from early boot.
  applyPlymouthTheme(sys, log, state, needsVerification);

  // 4b ─ also show the splash on the way DOWN (shutdown/reboot/halt/kexec), so there's no raw
  // console text at EITHER end. The theme's script keys off Plymouth.GetMode() to say "Shutting
  // down"/"Restarting" instead of "Starting up".
  enablePlymouthShutdownUnits(sys, log);

  // 5 ─ kernel cmdline: quiet splash + ignore serial consoles → the splash replaces console text.
  ensureKernelCmdline(sys, log, needsVerification);

  state.splashConfigured = true;
  assumptions.push(
    `boot splash: Plymouth theme '${PLYMOUTH_THEME_NAME}' (logo, host ${host}, v${version}) shows from ` +
      "early boot AND through shutdown/reboot; the compositor launcher retains the final frame so sway " +
      "paints over it (no flash).",
  );
  needsVerification.push(
    "Boot splash is a VISUAL property: verify on a VM/hardware with a real display that the splash " +
      "shows continuously from early boot to the player AND through shutdown/reboot with no raw console " +
      "text (an OrbStack headless box cannot show it).",
  );
}

/**
 * Enable Plymouth's shutdown-side units so the splash also covers poweroff/reboot/halt/kexec (POL-7).
 * These are shipped by the plymouth package; on some distros they're static/preset (enable is then a
 * harmless no-op), so this is best-effort.
 */
function enablePlymouthShutdownUnits(sys: Sys, log: Logger): void {
  log.step("enable Plymouth shutdown/reboot splash units");
  sys.exec(
    "systemctl",
    [
      "enable",
      "plymouth-poweroff.service",
      "plymouth-reboot.service",
      "plymouth-halt.service",
      "plymouth-kexec.service",
    ],
    { desc: "splash on shutdown/reboot/halt/kexec", allowFail: true },
  );
}

/** Rasterise one SVG → PNG, best-effort across rsvg-convert then ImageMagick. True on success. */
function rasterizeSvg(
  sys: Sys,
  log: Logger,
  svgPath: string,
  pngPath: string,
  width: number,
  height: number | undefined,
): boolean {
  if (sys.dryRun) {
    log.plan(`rasterise ${svgPath} -> ${pngPath} (${width}px${height ? `x${height}` : ""})`);
    return true;
  }
  const size = height ? `${width}x${height}` : `${width}`;

  if (sys.which("rsvg-convert")) {
    const args = ["-w", String(width)];
    if (height) args.push("-h", String(height));
    args.push("-o", pngPath, svgPath);
    if (sys.exec("rsvg-convert", args, { desc: `rasterise ${basename(pngPath)}`, allowFail: true }).code === 0)
      return sys.exists(pngPath);
  }

  // ImageMagick fallback: `convert` (v6) or `magick` (v7).
  const im = sys.which("convert") ? "convert" : sys.which("magick") ? "magick" : null;
  if (im) {
    const args = ["-background", "none", "-density", "300", svgPath, "-resize", size, pngPath];
    if (sys.exec(im, args, { desc: `rasterise ${basename(pngPath)} (ImageMagick)`, allowFail: true }).code === 0)
      return sys.exists(pngPath);
  }

  // A pre-rendered PNG (e.g. shipped by a prebaked image) is also acceptable.
  return sys.exists(pngPath);
}

/**
 * Select the Plymouth theme and rebuild the initramfs so it shows from early boot.
 *
 * The theme is selected by writing `/etc/plymouth/plymouthd.conf` (`[Daemon] Theme=`) — the portable
 * selector that BOTH modern plymouth and dracut honour. `plymouth-set-default-theme` is used too WHEN
 * PRESENT (it also points the initramfs-tools `default.plymouth` alternative at our theme), but it is
 * NOT required: Ubuntu 26.04 (dracut) ships without it, so the old code — which bailed out entirely
 * when the helper was missing — left the splash on the stock theme (POL-7).
 */
function applyPlymouthTheme(sys: Sys, log: Logger, state: SetupState, needsVerification: string[]): void {
  // Record the prior default theme ONCE so uninstall can restore the alternative (best-effort; the
  // helper is absent on dracut boxes, where the plymouthd.conf backup is what restores the theme).
  if (state.priorPlymouthTheme === undefined) {
    state.priorPlymouthTheme = sys.which("plymouth-set-default-theme")
      ? (() => {
          const cur = sys.probe("plymouth-set-default-theme", []).stdout.trim();
          return cur && cur !== PLYMOUTH_THEME_NAME ? cur : null;
        })()
      : null;
  }

  // 1 ─ the authoritative, portable selector. Backed up so teardown restores the box's original.
  sys.writeFile(PLYMOUTHD_CONF_PATH, plymouthdConf(), {
    mode: 0o644,
    backupOriginal: true,
    desc: "plymouthd.conf (select the Polyptic theme)",
  });

  // 2 ─ if the Debian helper exists, also point the default.plymouth alternative at our theme (what
  //     initramfs-tools reads). A no-op where it's absent (Ubuntu 26.04 / dracut).
  if (sys.which("plymouth-set-default-theme")) {
    sys.exec("plymouth-set-default-theme", [PLYMOUTH_THEME_NAME], {
      desc: "set default plymouth theme (alternative)",
      allowFail: true,
    });
  }

  // 3 ─ on dracut, force the theme + its script plugin into the initramfs. dracut's plymouth module
  //     (plymouth-populate-initrd) does NOT reliably bundle a non-default theme on Ubuntu 26.04 (no
  //     plymouth-set-default-theme helper / no default.plymouth symlink), so name the files explicitly
  //     in an install_items drop-in; plymouthd then loads them at boot via plymouthd.conf's Theme=.
  if (sys.which("dracut")) {
    configureDracutSplashInclude(sys, log, needsVerification);
  }

  // 4 ─ rebuild the initramfs with the REAL generator so the theme is embedded for early boot.
  rebuildInitramfs(sys, log, needsVerification);
}

/** Write a dracut drop-in that force-includes the splash theme files + the `script` plugin (POL-7). */
function configureDracutSplashInclude(sys: Sys, log: Logger, needsVerification: string[]): void {
  // Resolve the arch-specific plymouth `script` plugin — the theme's ModuleName=script needs it.
  const scriptSo = sys
    .probe("sh", ["-c", "ls /usr/lib/*/plymouth/script.so /usr/lib64/plymouth/script.so 2>/dev/null | head -n1"])
    .stdout.trim();
  if (!scriptSo) {
    log.warn("plymouth 'script' plugin (script.so) not found — the boot-splash theme cannot render.");
    needsVerification.push(
      "Boot splash: the plymouth 'script' plugin (script.so) is missing — install the plymouth script-plugin " +
        "package, then re-run setup, or the splash won't render (it falls back to the console).",
    );
    return;
  }
  // The theme files plymouth needs at boot: descriptor, script, and the rasterised PNGs (SVGs aren't
  // read at boot; hostname/version don't affect the base names, so any StampParams works here).
  // Filter to files that ACTUALLY exist: dracut treats `install_items` as REQUIRED, so naming a
  // missing path (e.g. a PNG that didn't rasterise on the air-gap path with no rsvg-convert) makes
  // EVERY `dracut -f` abort — including later kernel-upgrade rebuilds, since the drop-in persists in
  // /etc/dracut.conf.d. A missing logo must degrade to a logo-less splash, not wedge the initramfs.
  const themeFiles = [
    `${PLYMOUTH_THEME_DIR}/${PLYMOUTH_THEME_NAME}.plymouth`,
    `${PLYMOUTH_THEME_DIR}/${PLYMOUTH_THEME_NAME}.script`,
    ...splashAssets({ hostname: "", version: "" }).map((a) => `${PLYMOUTH_THEME_DIR}/${a.base}.png`),
  ].filter((p) => sys.exists(p));
  sys.writeFile(PLYMOUTH_DRACUT_CONF_PATH, plymouthDracutConf([PLYMOUTHD_CONF_PATH, scriptSo, ...themeFiles]), {
    mode: 0o644,
    desc: "dracut install_items for the boot splash",
  });
  log.info(`boot splash: dracut will bundle the theme + ${basename(scriptSo)} into the initramfs`);
}

/**
 * Rebuild the initramfs so the selected Plymouth theme is embedded for early boot.
 *
 * Order matters: prefer `dracut` when present. Ubuntu 26.04 builds the initramfs with dracut but ALSO
 * ships an `update-initramfs` compatibility shim — calling that shim first (the old order) left the
 * real dracut initramfs untouched, so the theme never got in (POL-7). A box that genuinely uses
 * initramfs-tools has no `dracut` and falls through to `update-initramfs`.
 */
function rebuildInitramfs(sys: Sys, log: Logger, needsVerification: string[]): void {
  let rebuilt = false;
  if (sys.which("dracut")) {
    rebuilt = sys.exec("dracut", ["-f"], { desc: "rebuild initramfs (dracut)", allowFail: true }).code === 0;
  } else if (sys.which("update-initramfs")) {
    rebuilt =
      sys.exec("update-initramfs", ["-u"], { desc: "rebuild initramfs (update-initramfs)", allowFail: true }).code === 0;
  } else if (sys.which("mkinitcpio")) {
    rebuilt = sys.exec("mkinitcpio", ["-P"], { desc: "rebuild initramfs (mkinitcpio)", allowFail: true }).code === 0;
    needsVerification.push(
      "Arch: ensure the `plymouth` hook is in /etc/mkinitcpio.conf HOOKS so the splash loads from the initramfs.",
    );
  } else {
    needsVerification.push(
      "Could not find dracut/update-initramfs/mkinitcpio: rebuild the initramfs for your distro so the " +
        "splash appears from early boot.",
    );
    return;
  }

  if (sys.dryRun) return;
  if (rebuilt) {
    verifyThemeInInitramfs(sys, log, needsVerification);
  } else {
    // Don't swallow a failed rebuild: the box stays on its old/stock initramfs (no splash), and a
    // later kernel-triggered rebuild may fail too. Surface it instead of only the milder raster warning.
    log.warn("initramfs rebuild returned non-zero — the boot splash won't appear from early boot.");
    needsVerification.push(
      "Boot splash: the initramfs rebuild FAILED (non-zero exit) — the splash won't show and a later " +
        "kernel-update rebuild may also fail. Ensure an SVG rasteriser is present (librsvg2-bin) and re-run setup.",
    );
  }
}

/**
 * Best-effort guard against a SILENT theme miss (the POL-7 failure): after the rebuild, confirm our
 * theme is actually inside the initramfs image. If we can't locate the image or a lister, skip
 * quietly rather than warn spuriously.
 */
function verifyThemeInInitramfs(sys: Sys, log: Logger, needsVerification: string[]): void {
  const rel = sys.probe("uname", ["-r"]).stdout.trim();
  const image = [`/boot/initrd.img-${rel}`, `/boot/initramfs-${rel}.img`, `/boot/initrd-${rel}`].find(
    (p) => rel && sys.exists(p),
  );
  const lister = sys.which("lsinitramfs") ?? sys.which("lsinitrd");
  if (!image || !lister) return;

  const listing = sys.probe(lister, [image]).stdout;
  if (!listing) return;

  const hasTheme = listing.includes(`${PLYMOUTH_THEME_NAME}/${PLYMOUTH_THEME_NAME}.script`);
  // The theme's ModuleName=script needs the `script` plugin bundled too, or plymouthd can't render it.
  const hasScriptPlugin = listing.includes("plymouth/script.so");
  if (hasTheme && hasScriptPlugin) {
    log.info(`boot splash: confirmed the '${PLYMOUTH_THEME_NAME}' theme + script plugin are embedded in ${image}`);
    return;
  }
  const missing = [hasTheme ? null : `theme '${PLYMOUTH_THEME_NAME}'`, hasScriptPlugin ? null : "script.so plugin"]
    .filter(Boolean)
    .join(" + ");
  log.warn(`boot splash: ${missing} NOT in ${image} after rebuild — the splash won't render.`);
  needsVerification.push(
    `Boot splash: ${missing} is not embedded in ${image} after the initramfs rebuild — the splash will fall ` +
      "back to the console. On dracut, check /etc/dracut.conf.d/polyptic-splash.conf then re-run setup.",
  );
}

/** Ensure the kernel cmdline carries `quiet splash plymouth.ignore-serial-consoles`. */
function ensureKernelCmdline(sys: Sys, log: Logger, needsVerification: string[]): void {
  const grubDefault = "/etc/default/grub";
  if (sys.exists(grubDefault)) {
    const body = sys.readText(grubDefault) ?? "";
    const merged = mergeGrubCmdline(body);
    if (merged !== body) {
      sys.writeFile(grubDefault, merged, {
        mode: 0o644,
        backupOriginal: true,
        desc: "grub defaults (quiet splash)",
      });
    } else {
      log.skip("grub cmdline already carries the splash tokens");
    }
    regenerateGrub(sys, needsVerification);
    return;
  }

  for (const p of ["/boot/firmware/cmdline.txt", "/boot/cmdline.txt"]) {
    if (!sys.exists(p)) continue;
    const body = sys.readText(p) ?? "";
    const merged = mergeCmdlineTxt(body);
    if (merged !== body) {
      sys.writeFile(p, merged, { mode: 0o644, backupOriginal: true, desc: "kernel cmdline.txt (quiet splash)" });
    } else {
      log.skip(`${p} already carries the splash tokens`);
    }
    return;
  }

  needsVerification.push(
    "No /etc/default/grub or cmdline.txt found: add 'quiet splash plymouth.ignore-serial-consoles' to " +
      "the kernel cmdline for this bootloader (e.g. systemd-boot loader entries) so the splash replaces console text.",
  );
}

function regenerateGrub(sys: Sys, needsVerification: string[]): void {
  if (sys.which("update-grub")) {
    sys.exec("update-grub", [], { desc: "regenerate grub config (update-grub)", allowFail: true });
    return;
  }
  if (sys.which("grub2-mkconfig")) {
    sys.exec("grub2-mkconfig", ["-o", "/boot/grub2/grub.cfg"], { desc: "regenerate grub2 config", allowFail: true });
    return;
  }
  if (sys.which("grub-mkconfig")) {
    sys.exec("grub-mkconfig", ["-o", "/boot/grub/grub.cfg"], { desc: "regenerate grub config", allowFail: true });
    return;
  }
  needsVerification.push(
    "Edited /etc/default/grub but found no update-grub/grub-mkconfig — regenerate the GRUB config so the " +
      "splash cmdline takes effect.",
  );
}

function enableServices(sys: Sys, log: Logger, state: SetupState): void {
  log.step("enable services + make greetd the display manager");

  // Record + disable any prior display manager so two DMs don't fight over the seat.
  const dmLink = sys.readlinkSafe("/etc/systemd/system/display-manager.service");
  const priorDm = dmLink ? basename(dmLink) : null;
  if (state.priorDisplayManager === undefined) {
    state.priorDisplayManager = priorDm && priorDm !== "greetd.service" ? priorDm : null;
  }
  if (priorDm && priorDm !== "greetd.service") {
    sys.exec("systemctl", ["disable", priorDm], {
      desc: `disable prior display manager ${priorDm}`,
      allowFail: true,
    });
    log.info(`recorded + disabled prior display manager: ${priorDm}`);
  }

  // Record the prior default target so uninstall can restore it.
  const curTarget = sys.probe("systemctl", ["get-default"]).stdout.trim();
  if (state.priorDefaultTarget === undefined && curTarget) state.priorDefaultTarget = curTarget;

  sys.exec("systemctl", ["enable", "greetd"], { desc: "enable greetd", allowFail: true });

  // Free VT1 for greetd. greetdConfig runs on `vt = 1`, but systemd's getty.target also starts
  // getty@tty1 there. The getty's VT takeover (agetty's vhangup) SIGHUPs greetd's compositor session
  // ~1s into boot, killing the compositor and dropping the wall to a text login. greetd's packaged
  // unit only Conflicts=getty@tty7 (its upstream default VT), so on our VT1 we must stop + mask the
  // tty1 getty ourselves. Verified on Ubuntu 26.04/aarch64: without this, sway is SIGHUP'd (rc=129)
  // right after polyptic-session.target is reached; with it, the compositor stays up.
  sys.exec("systemctl", ["mask", "--now", "getty@tty1.service"], {
    desc: "mask getty@tty1 (frees VT1; its getty otherwise SIGHUPs the compositor)",
    allowFail: true,
  });

  sys.exec("systemctl", ["set-default", "graphical.target"], { desc: "default target = graphical.target" });
  sys.exec("systemctl", ["daemon-reload"], { desc: "reload systemd manager", allowFail: true });
  log.info(
    "user units in /etc/systemd/user are loaded when the kiosk session starts; the compositor " +
      `starts ${SESSION_TARGET}, which pulls in ${AGENT_SERVICE}.`,
  );
}

function startNow(sys: Sys, log: Logger): void {
  log.step("start greetd now");
  log.warn("restarting greetd takes over VT1 and starts the kiosk session immediately.");
  sys.exec("systemctl", ["restart", "greetd"], { desc: "restart greetd" });
}

// ── render-mode detection ────────────────────────────────────────────────────────

// DRM driver / PCI-vendor signatures of GPUs with no reliable hardware 3D (GL). A kiosk on these
// must render in software: the compositor's wlroots GLES path may *survive* (so the launcher's
// runtime crash-fallback never trips) yet the hardware cursor plane is broken and Chromium's GPU
// process fails on the missing 3D — so we pin `software` at setup time instead.
const VIRTUAL_GPU_DRIVERS = ["virtio", "vmwgfx", "qxl", "bochs", "cirrus", "simpledrm", "vboxvideo"];
// virtio(1af4), VMware(15ad), Red Hat/QEMU(1b36), QEMU stdvga/Bochs(1234), VirtualBox(80ee).
const VIRTUAL_GPU_PCI_VENDORS = ["1af4", "15ad", "1b36", "1234", "80ee"];
const REAL_GPU_DRIVERS = ["amdgpu", "radeon", "i915", "xe", "nvidia", "nouveau", "msm", "panfrost", "lima"];

/**
 * Sniff the DRM cards in sysfs. Returns a short label of the virtual GPU found (for logging), or
 * null if a real GPU is present (or nothing conclusive). A real GPU anywhere wins — a mixed box
 * (e.g. a passthrough card) should not be forced to software.
 */
function detectVirtualGpu(sys: Sys): string | null {
  const cards = sys
    .probe("ls", ["/sys/class/drm"])
    .stdout.split(/\s+/)
    .filter((n) => /^card\d+$/.test(n));
  let virtualHit: string | null = null;
  for (const card of cards) {
    const uevent = sys.readText(`/sys/class/drm/${card}/device/uevent`) ?? "";
    const driver = (uevent.match(/DRIVER=(\S+)/)?.[1] ?? "").toLowerCase();
    const vendor = (uevent.match(/PCI_ID=([0-9A-Fa-f]+):/)?.[1] ?? "").toLowerCase();
    if (REAL_GPU_DRIVERS.some((d) => driver.includes(d))) return null; // real GPU present → not virtual
    if (VIRTUAL_GPU_DRIVERS.some((d) => driver.includes(d)) || VIRTUAL_GPU_PCI_VENDORS.includes(vendor)) {
      virtualHit = driver || vendor || card;
    }
  }
  return virtualHit;
}

/**
 * Effective render mode. An explicit `hardware`/`software` is honoured verbatim. `auto` downgrades
 * to `software` on a detected virtual GPU (no reliable 3D), else stays `auto` so a real GPU keeps
 * hardware rendering with the launcher's runtime crash-fallback as backstop.
 */
function resolveRenderMode(sys: Sys, requested: RenderMode, log: Logger): RenderMode {
  if (requested !== "auto") return requested;
  const virt = detectVirtualGpu(sys);
  if (virt) {
    log.info(`render: auto → software (virtual GPU '${virt}' — no reliable hardware 3D)`);
    return "software";
  }
  log.info("render: auto (real/unknown GPU — hardware first, launcher falls back to software on a fast crash)");
  return "auto";
}

// ── verification + next steps ───────────────────────────────────────────────────

function collectBackendVerification(opts: SetupOptions, isX11: boolean, needsVerification: string[]): void {
  if (isX11) {
    needsVerification.push(
      "X11/i3 fallback: verify the greetd -> startx -> i3 chain on real hardware (startx VT handling, " +
        "Xorg rootless under logind). For NVIDIA add `nvidia-drm.modeset=1` to the kernel cmdline.",
    );
  } else {
    needsVerification.push(
      "wayland-sway: verify sway + .deb Chromium actually render on the target GPU. A virtual GPU may " +
        "need WLR_NO_HARDWARE_CURSORS=1; NVIDIA on wlroots needs `nvidia-drm.modeset=1` (else use --backend x11-i3).",
    );
  }
  needsVerification.push(
    "Cold-boot DoD is visual: power-cycle a VM with a real virtual display (Parallels/UTM) and confirm " +
      "greetd -> sway -> agent -> Chromium-per-output with zero interaction; OrbStack (headless) only " +
      "verifies the install/systemd/enrolment plumbing.",
  );
  if (opts.render === "auto") {
    needsVerification.push(
      `Auto render-fallback is active (${COMPOSITOR_LAUNCHER}): the launcher runs the compositor on the ` +
        "GPU and only switches to software rendering if it crashes within ~8s (no-3D virtual GPUs). On a " +
        "healthy GPU wall the compositor must survive >8s per launch, else it would wrongly fall back to " +
        "slow CPU rendering — pin it with `--render hardware` (or `--render software` to force CPU).",
    );
  }
  if (opts.outputs.length === 0) {
    needsVerification.push(
      "No --output pins given: the compositor auto-arranges outputs. For a multi-panel wall, pin each " +
        "connector (`--output DP-1=1920x1080@0,0 ...`) so placement is deterministic.",
    );
  }
}

function printNextSteps(opts: SetupOptions, log: Logger): void {
  log.banner("next steps");
  log.info("1. Power-cycle the box (or `sudo systemctl restart greetd`) to enter the kiosk session.");
  if (!opts.serverUrl) {
    log.info(`2. Create ${opts.configPath} from the .example (set server_url + bootstrap_token).`);
  } else {
    log.info("2. The agent enrols over WSS automatically (server_url is set).");
  }
  log.info("3. Approve the machine in the console, then place its screens onto a mural.");
  log.info("   Diagnostics (inside the kiosk session): `systemctl --user status polyptic-agent`,");
  log.info("   `journalctl --user -u polyptic-agent -f`.");
}
