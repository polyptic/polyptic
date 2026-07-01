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
import { detectDistro, corePackages, installCmd, refreshCmd } from "./distro";
import { installBrowser } from "./browser";
import { loadState, saveState } from "./state";
import { renderAgentToml } from "./config";
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

  const pkgs = corePackages(distro.pm, opts.backend);
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
    log.warn(
      `no --server-url given: wrote ${opts.configPath}.example. The agent will NOT connect until you ` +
        `create ${opts.configPath} (copy the example; set server_url + bootstrap_token).`,
    );
    needsVerification.push(
      `Create ${opts.configPath} from the .example (server_url + bootstrap_token) before the agent can enrol.`,
    );
  }
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
