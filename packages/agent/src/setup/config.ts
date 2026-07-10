/**
 * `/etc/polyptic/agent.toml` — the agent's on-box configuration file (D26).
 *
 * This module is the single home for that file's shape: it is BOTH
 *   - rendered by `polyptic-agent setup` (writes the file from flags), and
 *   - consumed by the agent at boot (`applyConfigFileToEnv`, called from index.ts).
 *
 * It deliberately depends on node builtins ONLY (no zod, no TOML lib) so importing it on the agent's
 * normal boot path stays cheap and pulls in none of the heavy provisioning machinery.
 *
 * How the agent consumes it: `applyConfigFileToEnv()` seeds `process.env` DEFAULTS from the file
 * *before* index.ts reads its config. Real environment variables (and the systemd unit's
 * `Environment=`) always win, and an absent file is a no-op — so a dev box with no
 * `/etc/polyptic/agent.toml` behaves exactly as before (Phase 1/2 parity).
 */
import { readFileSync } from "node:fs";

export const DEFAULT_CONFIG_PATH = "/etc/polyptic/agent.toml";

/** Maps `agent.toml` keys onto the `POLYPTIC_*` env vars the agent already reads. */
const KEY_TO_ENV: Readonly<Record<string, string>> = {
  server_url: "POLYPTIC_SERVER_URL",
  bootstrap_token: "POLYPTIC_BOOTSTRAP_TOKEN",
  backend: "POLYPTIC_BACKEND",
  connector: "POLYPTIC_CONNECTOR",
  machine_id: "POLYPTIC_MACHINE_ID",
  state_dir: "POLYPTIC_STATE_DIR",
};

export interface AgentTomlValues {
  serverUrl?: string;
  bootstrapToken?: string;
  backend?: string;
  connector?: string;
}

/**
 * Minimal flat-TOML reader for the schema WE write: `key = "value"` / `key = value`, `#` comments
 * (whole-line and trailing on unquoted values), and `[table]` headers (ignored — keys are flat).
 * Sufficient and robust for our generated file and the common hand-edited cases; it is intentionally
 * not a full TOML parser.
 */
export function parseAgentToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote as string, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
      value = value.replace(/\\"/g, '"');
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Seed `process.env` defaults from the agent config file (path from `POLYPTIC_CONFIG`, else the
 * default). Only sets a `POLYPTIC_*` var that is not already present/non-empty, so real env always
 * wins. Absent/unreadable file → no-op.
 */
export function applyConfigFileToEnv(env: NodeJS.ProcessEnv = process.env): void {
  const path = env.POLYPTIC_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no config file — dev parity, behave exactly as before
  }
  const kv = parseAgentToml(text);
  for (const key of Object.keys(KEY_TO_ENV)) {
    const envKey = KEY_TO_ENV[key];
    if (!envKey) continue;
    const value = kv[key];
    const existing = env[envKey];
    if (value && value.length > 0 && !(existing && existing.length > 0)) {
      env[envKey] = value;
    }
  }
}

/** Render `/etc/polyptic/agent.toml` (or its `.example`) from setup flags. */
export function renderAgentToml(v: AgentTomlValues, opts: { example: boolean }): string {
  const serverUrl = v.serverUrl ?? (opts.example ? "wss://control.example.com/agent" : "");
  const bootstrapToken = v.bootstrapToken ?? "";
  const backend = v.backend ?? "wayland-sway";
  const header = opts.example
    ? "# EXAMPLE — copy to /etc/polyptic/agent.toml and fill in, then restart the agent."
    : "# Written by `polyptic-agent setup`. Edit, then restart the agent.";
  const lines = [
    "# /etc/polyptic/agent.toml — Polyptic agent configuration (D26).",
    header,
    "#   systemctl --user restart polyptic-agent      # from inside the kiosk session",
    "#",
    "# Real environment variables (POLYPTIC_*) and the systemd unit's Environment= override these.",
    "",
    "# Control-plane agent channel — outbound WSS only (D12). REQUIRED.",
    `server_url = "${serverUrl}"`,
    "",
    "# One-time enrollment bootstrap token for the server's GATED mode (2b / D19).",
    "# After first contact the agent persists a durable credential and this may be cleared.",
    `bootstrap_token = "${bootstrapToken}"`,
    "",
    '# Display backend (D9): "wayland-sway" (default) | "x11-i3" (NVIDIA/fallback) | "dev-open".',
    `backend = "${backend}"`,
    "",
    "# Optional: advertised output connector for a single-output override (usually auto-detected).",
    v.connector ? `connector = "${v.connector}"` : '# connector = "DP-1"',
    "",
  ];
  return lines.join("\n");
}
