/**
 * Config-file renderers for the cold-boot chain (docs/ARCHITECTURE.md "On-device stack"):
 *
 *   power on -> systemd -> greetd [initial_session] autologin user=kiosk -> compositor (sway / i3)
 *            -> systemctl --user start polyptic-session.target
 *                  -> polyptic-agent.service (Restart=always) -> Chromium-per-output
 *   no swayidle | output * dpms on | popup/exit_type suppression (the agent does the per-profile bit)
 *
 * Model A: the agent OWNS its Chromium children (launches/respawns them via the wayland-sway/x11-i3
 * DisplayBackend); systemd supervises the agent. So there is exactly ONE service unit here.
 */
import type { Backend, OutputPin, RenderMode } from "./args";

const MANAGED = "managed by `polyptic-agent setup` — re-running setup may overwrite this file.";

// ── greetd ─────────────────────────────────────────────────────────────────────

export interface GreetdParams {
  user: string;
  /** Command greetd runs for the autologin session (launches the compositor). */
  sessionCommand: string;
}

export function greetdConfig(p: GreetdParams): string {
  return `# /etc/greetd/config.toml — ${MANAGED}
# Zero-click cold boot (D26/non-negotiable #4): autologin the kiosk user straight into the
# compositor. No greeter, no typed password.

[terminal]
vt = 1

# Fallback greeter for any *non-initial* session (e.g. after a manual logout). The initial_session
# below is the polyptic-compositor launcher, which relaunches the compositor forever, so in practice
# this greeter essentially never runs — it's only a last-ditch safety net. Run it as the kiosk user
# — greetd refuses to start if this user doesn't exist, and a dedicated 'greeter' user isn't created
# by the greetd package on every distro (e.g. Ubuntu 26.04), whereas the kiosk user always exists.
[default_session]
command = "agreety --cmd /bin/sh"
user = "${p.user}"

# The session run once at boot: kiosk user -> compositor launcher -> compositor -> systemd user
# session. The command is the polyptic-compositor launcher (restart-on-exit loop + empirical
# hardware/software render selection), not a bare \`sway\`/\`startx\`, so the wall never drops to a
# text login and renders even on GPUs with no working 3D.
[initial_session]
command = "${p.sessionCommand}"
user = "${p.user}"
`;
}

// ── compositor launcher (robust kiosk session entry point) ──────────────────────

/** Fixed path the launcher script is installed to (mode 0755); greetd's initial_session runs it. */
export const COMPOSITOR_LAUNCHER = "/usr/local/bin/polyptic-compositor";

export interface CompositorLauncherParams {
  /** Display backend — selects the compositor command + the software-render env. */
  backend: Backend;
  /** The bare compositor command greetd would otherwise run directly (`sway` | `startx`). */
  sessionCommand: string;
  /** Baked default for POLYPTIC_RENDER (the session env still overrides it). */
  render: RenderMode;
}

/**
 * POSIX `sh` script that greetd's [initial_session] runs INSTEAD of a bare `sway`/`startx`. It does
 * two jobs a bare compositor command can't:
 *
 *  1. Restart-on-exit loop → the wall never drops to a text login. If the compositor dies we
 *     relaunch it forever, so control never falls through to greetd's agreety greeter (which would
 *     itself crash-loop into a black screen / text prompt on a headless wall).
 *
 *  2. Empirical hardware/software render selection → renders on GPUs with no working 3D (a QEMU/UTM
 *     virtio-gpu without virgl renders one frame then crashes) WITHOUT handicapping real GPUs. We
 *     do NOT force software rendering unconditionally — CPU-only rendering would cripple a real GPU
 *     wall. `auto` instead measures how long the compositor survives and only switches to software
 *     when the GPU demonstrably can't render.
 */
export function compositorLauncher(p: CompositorLauncherParams): string {
  const isX11 = p.backend === "x11-i3";
  // Software-render env. sway is wlroots → WLR_RENDERER=pixman selects the CPU renderer; i3/Xorg
  // only needs Mesa's software path (LIBGL_ALWAYS_SOFTWARE), and the WLR_* vars are harmless no-ops
  // there. Indented to sit inside the `if [ "$mode" = software ]` block in the loop below.
  const softwareEnv = isX11
    ? `    export LIBGL_ALWAYS_SOFTWARE=1`
    : `    export WLR_RENDERER=pixman
    export LIBGL_ALWAYS_SOFTWARE=1`;

  return `#!/bin/sh
# ${COMPOSITOR_LAUNCHER} — ${MANAGED}
#
# Robust kiosk compositor launcher. greetd's [initial_session] runs THIS instead of a bare
# \`${p.sessionCommand}\`, which buys the wall two properties a bare compositor command can't:
#
#   1. It NEVER drops to a text login. The compositor is relaunched in a forever-loop, so a crash
#      can't fall through to greetd's agreety greeter (which would itself crash-loop into a black
#      screen / text prompt on a headless wall).
#
#   2. It renders on GPUs with no working 3D (e.g. a QEMU/UTM virtio-gpu without virgl) WITHOUT
#      handicapping real GPUs. The renderer is chosen empirically — forcing software rendering on
#      everyone would cripple a real GPU wall with CPU-only rendering.
#
# Renderer selection via POLYPTIC_RENDER (inherited from the session env; default baked by setup):
#   hardware  run the compositor as-is on the GPU's GL renderer.
#   software  always force the wlroots/Mesa software (CPU) renderer.
#   auto      start on hardware; if the compositor dies within ~\${FAST_EXIT_SECS}s — the signature
#             of a virtual GPU whose GL renderer paints one frame then crashes — switch to software
#             for every later relaunch in THIS run and stay there. A real GPU runs for hours and
#             never trips the switch (so it is never handicapped); a virtual GPU dies in ~1s, trips
#             it once, and renders in software from then on.
#
# \`set -e\` must NOT kill the restart loop: the compositor exiting non-zero (a crash) is the normal
# case we have to survive, so its invocation below is guarded with \`|| true\`.
set -eu

# Baked default for POLYPTIC_RENDER (from setup's --render); the session env still overrides it.
: "\${POLYPTIC_RENDER:=${p.render}}"

# POL-7: keep the VT clean during the boot-splash hand-off. greetd runs this launcher on a text VT
# (console=tty0), so ANY stdout/stderr we or the compositor emit is drawn onto that console — right
# over Plymouth's retained splash frame, before sway ever paints. Redirect it all to a logfile so the
# retained splash stays untouched until the compositor takes the screen. Overridable for debugging.
POLYPTIC_COMPOSITOR_LOG="\${POLYPTIC_COMPOSITOR_LOG:-/tmp/polyptic-compositor.log}"
exec >>"\$POLYPTIC_COMPOSITOR_LOG" 2>&1 || true

FAST_EXIT_SECS=8   # auto: a hardware run shorter than this counts as a GPU-render failure
BACKOFF_SECS=2     # pause between relaunches so a hard crash-loop never pins the CPU

log() { echo "polyptic-compositor: \$*" >&2; }

# Effective renderer for this run. \`auto\` starts on hardware and may flip to software after a fast
# crash (below); once flipped it stays software for every subsequent relaunch.
mode="\$POLYPTIC_RENDER"
if [ "\$mode" = auto ]; then mode=hardware; fi

log "starting (POLYPTIC_RENDER=\$POLYPTIC_RENDER, backend=${p.backend})"

# Virtual-GPU hardware cursor planes (virtio-gpu / QXL) are frequently broken — the cursor renders
# upside-down or offset from where clicks land. Force wlroots to composite the cursor in software
# REGARDLESS of the render mode: negligible cost, a wall hides the cursor anyway, and it is a
# harmless no-op on the X11/i3 (startx) path. (Verified on Ubuntu 26.04/arm64 virtio-gpu.)
export WLR_NO_HARDWARE_CURSORS=1

# POL-7 clean hand-off: dismiss the boot splash but KEEP its final frame on screen
# (\`--retain-splash\`) so the compositor paints straight over it — no flash of a blank console
# between the splash and the player. Best-effort + once (a no-op if plymouth isn't installed or has
# already quit via its systemd unit, which our drop-in also makes retain the splash).
if command -v plymouth >/dev/null 2>&1; then
  plymouth quit --retain-splash >/dev/null 2>&1 || true
fi

while true; do
  if [ "\$mode" = software ]; then
    # Force the CPU renderer. Exported here so it persists across every later relaunch this run.
${softwareEnv}
  fi

  start=\$(date +%s)
  # Launch the compositor; blocks until it exits/crashes. \`|| true\` keeps \`set -e\` from killing
  # the loop on a non-zero (crash) exit — surviving that crash is the whole point.
  ${p.sessionCommand} || true
  end=\$(date +%s)
  elapsed=\$(( end - start ))

  # auto fallback: a *hardware* run that died fast means the GPU can't actually render GL — switch
  # to software for the rest of this run. Real GPUs run long and never reach this branch.
  if [ "\$POLYPTIC_RENDER" = auto ] && [ "\$mode" = hardware ] && [ "\$elapsed" -lt "\$FAST_EXIT_SECS" ]; then
    log "compositor exited after \${elapsed}s on hardware GL — falling back to software rendering"
    mode=software
  else
    log "compositor exited after \${elapsed}s (mode=\$mode); relaunching in \${BACKOFF_SECS}s"
  fi

  sleep "\$BACKOFF_SECS"
done
`;
}

// ── sway (wayland-sway) ────────────────────────────────────────────────────────

export interface SwayParams {
  outputs: OutputPin[];
  sessionTarget: string;
}

function swayOutputLines(outputs: OutputPin[]): string {
  if (outputs.length === 0) {
    return `# No explicit pins given — sway auto-arranges outputs left-to-right. Pin them for a
# deterministic wall, e.g.:
#   output DP-1 resolution 1920x1080 position 0 0
#   output DP-2 resolution 1920x1080 position 1920 0`;
  }
  return outputs
    .map((o) => {
      const res = o.width && o.height ? `resolution ${o.width}x${o.height}` : "resolution preferred";
      const pos = o.x !== undefined && o.y !== undefined ? ` position ${o.x} ${o.y}` : "";
      return `output ${o.connector} ${res}${pos}`;
    })
    .join("\n");
}

export function swayConfig(p: SwayParams): string {
  return `# ~/.config/sway/config — ${MANAGED}
# D27: a thin graphical layer on Ubuntu Server-minimal — compositor only, no desktop environment.
# Hardening per docs/ARCHITECTURE.md "On-device stack" + "Gotchas".

### Outputs — pin connectors so per-output placement is deterministic, and keep panels awake.
${swayOutputLines(p.outputs)}
# always-on wall; power is the smart plug's job (no DPMS sleep). NB: sway does NOT accept a trailing
# '#' comment on a directive line — it parses the rest as arguments — so every comment sits on its
# own line here.
output * dpms on

### No idle / no blank / no lock. A wall runs unattended for days.
# (intentionally NO \`exec swayidle\` and NO lock — never blank the content)

### Chromium app windows fill each output: no decorations, borders, or gaps.
default_border none
default_floating_border none
hide_edge_borders both
focus_follows_mouse no
# hide the pointer; no operator stands at the panel
seat * hide_cursor 5000
# Gotcha: every Chromium shares app_id="chromium" under Wayland, so the agent's wayland-sway
# backend disambiguates by window title / launch order and places each on its output via swaymsg
# IPC (Wayland forbids client self-positioning — --window-position is a no-op).

### Hand off to the systemd user session, which supervises polyptic-agent (Restart=always).
# LIBGL_ALWAYS_SOFTWARE is imported so the kiosk browser inherits the launcher's software-GL choice
# on a 3D-less GPU (else WebKit/Chromium tries hardware GL and dies with no window). Unset on a real
# GPU, so this is a no-op there — never forces software rendering on hardware that can do GL.
# DISPLAY is imported too: sway defines it at startup for its (lazy-started) Xwayland, and X11-only
# kiosk browsers (surf) launched by the agent's user unit die with "Can't open default display"
# without it (found live in the POL-38 UTM boot). Unset when xwayland is unavailable — harmless.
exec systemctl --user import-environment WAYLAND_DISPLAY SWAYSOCK DISPLAY XDG_CURRENT_DESKTOP XDG_RUNTIME_DIR LIBGL_ALWAYS_SOFTWARE
exec dbus-update-activation-environment --systemd WAYLAND_DISPLAY SWAYSOCK DISPLAY XDG_CURRENT_DESKTOP LIBGL_ALWAYS_SOFTWARE
exec systemctl --user start ${p.sessionTarget}
`;
}

// ── i3 (x11-i3 fallback) ───────────────────────────────────────────────────────

export interface I3Params {
  outputs: OutputPin[];
  sessionTarget: string;
}

function i3OutputLines(outputs: OutputPin[]): string {
  if (outputs.length === 0) {
    return `# No explicit pins — X/RandR auto-arranges. Pin for a deterministic wall, e.g.:
# exec_always --no-startup-id xrandr --output DP-1 --mode 1920x1080 --pos 0x0`;
  }
  return outputs
    .map((o) => {
      const mode = o.width && o.height ? `--mode ${o.width}x${o.height}` : "--auto";
      const pos = o.x !== undefined && o.y !== undefined ? ` --pos ${o.x}x${o.y}` : "";
      return `exec_always --no-startup-id xrandr --output ${o.connector} ${mode}${pos}`;
    })
    .join("\n");
}

export function i3Config(p: I3Params): string {
  return `# ~/.config/i3/config — ${MANAGED}
# X11 / i3 fallback (D9) for GPUs/apps that misbehave on wlroots (notably NVIDIA).

font pango:DejaVu Sans 10
default_border none
default_floating_border none
hide_edge_borders both
focus_follows_mouse no
for_window [class=".*"] border none

### Outputs — pin via RandR.
${i3OutputLines(p.outputs)}

### Always-on: disable the X screensaver + DPMS blanking; hide the cursor.
exec_always --no-startup-id xset s off -dpms s noblank
exec_always --no-startup-id unclutter -idle 3

### Hand off to the systemd user session (supervises polyptic-agent, Restart=always).
exec_always --no-startup-id systemctl --user import-environment DISPLAY XAUTHORITY LIBGL_ALWAYS_SOFTWARE
exec_always --no-startup-id dbus-update-activation-environment --systemd DISPLAY XAUTHORITY LIBGL_ALWAYS_SOFTWARE
exec_always --no-startup-id systemctl --user start ${p.sessionTarget}
`;
}

/** `~/.xinitrc` for the x11-i3 chain: greetd autologin runs \`startx\`, which execs this. */
export function xinitrc(): string {
  return `#!/bin/sh
# ~/.xinitrc — ${MANAGED}
# greetd's autologin session runs \`startx\`, which sources this and execs i3.
exec i3
`;
}

// ── privileged reboot helper (POL-55) ──────────────────────────────────────────
//
// Reboot-from-the-control-plane needs root; the agent has none. Rather than install `sudo` (absent
// from the live image) or polkit (likewise) and hand the kiosk user a general-purpose escalation,
// setup writes a root-owned systemd pair whose ONLY capability is rebooting:
//
//   /run/polyptic/requests   0770 root:<kiosk>   the one thing the kiosk user may write into
//   polyptic-reboot.path     watches it for a file named `reboot`
//   polyptic-reboot.service  removes the file, then asks systemd to reboot
//
// The agent's escalation is therefore `touch` — no command string, no arguments, nothing to smuggle.
// `/run` is tmpfs, so a request can never survive the reboot it caused and re-trigger on the next boot.

export const REBOOT_PATH_UNIT = "polyptic-reboot.path";
export const REBOOT_SERVICE = "polyptic-reboot.service";
export const SYSTEM_UNIT_DIR = "/etc/systemd/system";
export const REBOOT_TMPFILES_PATH = "/etc/tmpfiles.d/polyptic-reboot.conf";
/** Must match `REBOOT_REQUEST_DIR` / `REBOOT_REQUEST_PATH` in ../host.ts. */
export const REBOOT_REQUEST_DIR = "/run/polyptic/requests";
export const REBOOT_REQUEST_PATH = `${REBOOT_REQUEST_DIR}/reboot`;

/** systemd-tmpfiles creates the request directory on every boot (/run is tmpfs, so it must). */
export function rebootTmpfilesConf(user: string): string {
  return `# ${REBOOT_TMPFILES_PATH} — ${MANAGED}
# The kiosk agent is unprivileged and cannot create anything under root-owned /run/polyptic (which
# also holds agent.env and its bootstrap token, deliberately unreadable-by-write to the kiosk user).
# This one sub-directory is group-writable by '${user}' so the agent can drop a reboot request in it.
d /run/polyptic 0755 root root -
d ${REBOOT_REQUEST_DIR} 0770 root ${user} -
`;
}

export function rebootPathUnit(): string {
  return `# ${SYSTEM_UNIT_DIR}/${REBOOT_PATH_UNIT} — ${MANAGED}
[Unit]
Description=Polyptic — watch for the agent's reboot request (POL-55)
Documentation=https://github.com/polyptic/polyptic/blob/main/docs/ARCHITECTURE.md

[Path]
PathExists=${REBOOT_REQUEST_PATH}
Unit=${REBOOT_SERVICE}

[Install]
WantedBy=paths.target
`;
}

export function rebootServiceUnit(): string {
  return `# ${SYSTEM_UNIT_DIR}/${REBOOT_SERVICE} — ${MANAGED}
[Unit]
Description=Polyptic — reboot this box, as asked by the control plane (POL-55)
Documentation=https://github.com/polyptic/polyptic/blob/main/docs/ARCHITECTURE.md
# Nothing may reorder us into the shutdown transaction we are about to start.
DefaultDependencies=no

[Service]
Type=oneshot
# Consume the request first: if the reboot itself fails, a stale file must not re-arm the .path unit
# into a tight retrigger loop.
ExecStartPre=-/usr/bin/rm -f ${REBOOT_REQUEST_PATH}
# --no-block: enqueue the shutdown job and exit, rather than waiting for a transaction that stops us.
ExecStart=/usr/bin/systemctl --no-block reboot
`;
}

// ── systemd user units ─────────────────────────────────────────────────────────

export const SESSION_TARGET = "polyptic-session.target";
export const AGENT_SERVICE = "polyptic-agent.service";

export function sessionTargetUnit(): string {
  return `# /etc/systemd/user/${SESSION_TARGET} — ${MANAGED}
[Unit]
Description=Polyptic kiosk session (compositor-supervised)
Documentation=file:///etc/polyptic/agent.toml
# Grouping target the compositor starts once the Wayland/X session env is imported. \`Wants\` (not
# \`Requires\`) so a momentary agent hiccup never tears the session down — the agent's own
# Restart=always brings it back.
Wants=${AGENT_SERVICE}
After=graphical-session.target
`;
}

export interface AgentServiceParams {
  agentBin: string;
  configPath: string;
}

export function agentServiceUnit(p: AgentServiceParams): string {
  return `# /etc/systemd/user/${AGENT_SERVICE} — ${MANAGED}
[Unit]
Description=Polyptic agent — display reconciler + Chromium-per-output supervisor
Documentation=file:///etc/polyptic/agent.toml
# Runs INSIDE the kiosk's Wayland/X session; needs the compositor env imported by the compositor
# before it starts ${SESSION_TARGET}.
PartOf=${SESSION_TARGET}
After=${SESSION_TARGET}
# Crash hardening: never stop respawning the reconciler, even after many fast restarts.
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${p.agentBin}
Restart=always
RestartSec=2
# Config (control-plane URL + bootstrap token + backend) lives in agent.toml, written by setup.
Environment=POLYPTIC_CONFIG=${p.configPath}
# Crash/restore hardening: a power cut must never leave Chromium showing "Restore pages". The agent
# resets exit_type/exited_cleanly in each profile's Preferences before (re)launch (per ARCHITECTURE).

[Install]
WantedBy=${SESSION_TARGET}
`;
}
