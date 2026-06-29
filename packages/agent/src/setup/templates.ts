/**
 * Config-file renderers for the cold-boot chain (docs/ARCHITECTURE.md "On-device stack"):
 *
 *   power on -> systemd -> greetd [initial_session] autologin user=kiosk -> compositor (sway / i3)
 *            -> systemctl --user start polyptych-session.target
 *                  -> polyptych-agent.service (Restart=always) -> Chromium-per-output
 *   no swayidle | output * dpms on | popup/exit_type suppression (the agent does the per-profile bit)
 *
 * Model A: the agent OWNS its Chromium children (launches/respawns them via the wayland-sway/x11-i3
 * DisplayBackend); systemd supervises the agent. So there is exactly ONE service unit here.
 */
import type { OutputPin } from "./args";

const MANAGED = "managed by `polyptych-agent setup` — re-running setup may overwrite this file.";

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

# Fallback greeter for any *non-initial* session (e.g. after a manual logout). A wall normally
# reboots rather than logs out, so this is only a safety net.
[default_session]
command = "agreety --cmd /bin/sh"
user = "greeter"

# The session run once at boot: kiosk user -> compositor -> systemd user session.
[initial_session]
command = "${p.sessionCommand}"
user = "${p.user}"
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
output * dpms on            # always-on wall; power is the smart plug's job (no DPMS sleep)

### No idle / no blank / no lock. A wall runs unattended for days.
# (intentionally NO \`exec swayidle\` and NO lock — never blank the content)

### Chromium app windows fill each output: no decorations, borders, or gaps.
default_border none
default_floating_border none
hide_edge_borders both
focus_follows_mouse no
seat * hide_cursor 5000     # hide the pointer; no operator stands at the panel
# Gotcha: every Chromium shares app_id="chromium" under Wayland, so the agent's wayland-sway
# backend disambiguates by window title / launch order and places each on its output via swaymsg
# IPC (Wayland forbids client self-positioning — --window-position is a no-op).

### Hand off to the systemd user session, which supervises polyptych-agent (Restart=always).
exec systemctl --user import-environment WAYLAND_DISPLAY SWAYSOCK XDG_CURRENT_DESKTOP XDG_RUNTIME_DIR
exec dbus-update-activation-environment --systemd WAYLAND_DISPLAY SWAYSOCK XDG_CURRENT_DESKTOP
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

### Hand off to the systemd user session (supervises polyptych-agent, Restart=always).
exec_always --no-startup-id systemctl --user import-environment DISPLAY XAUTHORITY
exec_always --no-startup-id dbus-update-activation-environment --systemd DISPLAY XAUTHORITY
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

// ── systemd user units ─────────────────────────────────────────────────────────

export const SESSION_TARGET = "polyptych-session.target";
export const AGENT_SERVICE = "polyptych-agent.service";

export function sessionTargetUnit(): string {
  return `# /etc/systemd/user/${SESSION_TARGET} — ${MANAGED}
[Unit]
Description=Polyptych kiosk session (compositor-supervised)
Documentation=file:///etc/polyptych/agent.toml
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
  backend: string;
}

export function agentServiceUnit(p: AgentServiceParams): string {
  return `# /etc/systemd/user/${AGENT_SERVICE} — ${MANAGED}
[Unit]
Description=Polyptych agent — display reconciler + Chromium-per-output supervisor
Documentation=file:///etc/polyptych/agent.toml
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
Environment=POLYPTYCH_CONFIG=${p.configPath}
# Crash/restore hardening: a power cut must never leave Chromium showing "Restore pages". The agent
# resets exit_type/exited_cleanly in each profile's Preferences before (re)launch (per ARCHITECTURE).

[Install]
WantedBy=${SESSION_TARGET}
`;
}
