/**
 * Install-state record, so `setup --uninstall` can faithfully restore the box: which display manager
 * and default target were in place before we took over, and whether WE created the kiosk user.
 * Stored at `/etc/polyptic/.setup-state.json` (0600).
 */
import type { Sys } from "./system";

export const STATE_PATH = "/etc/polyptic/.setup-state.json";

export interface SetupState {
  version: number;
  user?: string;
  backend?: string;
  /** True only if THIS run created the kiosk user (so --purge may safely delete it). */
  createdUser?: boolean;
  /** Display-manager unit that was active before greetd (e.g. "gdm.service"), or null if none. */
  priorDisplayManager?: string | null;
  /** Default systemd target before we forced graphical.target. */
  priorDefaultTarget?: string | null;
  /** Plymouth default theme active before we set ours (so uninstall can restore it), or null. */
  priorPlymouthTheme?: string | null;
  /** True once the boot splash (Plymouth theme + cmdline) was configured (so uninstall reverts it). */
  splashConfigured?: boolean;
  installedAt?: string;
}

export function loadState(sys: Sys): SetupState {
  const text = sys.readText(STATE_PATH);
  if (!text) return { version: 1 };
  try {
    const parsed = JSON.parse(text) as Partial<SetupState>;
    return { version: 1, ...parsed };
  } catch {
    return { version: 1 };
  }
}

export function saveState(sys: Sys, state: SetupState): void {
  sys.ensureDir("/etc/polyptic", { mode: 0o755 });
  sys.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
    desc: "setup state",
  });
}
