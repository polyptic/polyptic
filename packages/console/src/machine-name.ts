/**
 * POL-117 — what to call a machine on screen.
 *
 * Every netbooted box boots the same live image, so every box's hostname is
 * `localhost.localdomain` — and a wall of machine cards all "named" that identifies nothing.
 * The rules, in order:
 *
 *   1. An operator-set name (Machine.label diverged from the id, and not a meaningless hostname)
 *      is THE identity. Show it.
 *   2. Otherwise the box is unnamed. Say so honestly: "Unnamed box · <id tail>" — the tail is the
 *      only part of a `dmi-…`/`mac-…` id a human can actually compare across cards. NEVER render
 *      `localhost.localdomain` (or any label that is really just the machine id) as if it were a name.
 *
 * The server refuses to ADOPT meaningless hostnames as labels (state.ts labelForHello); this helper
 * is the display-side belt to that brace, so machines registered before the fix render honestly too.
 */
import { machineHasName } from "@polyptic/protocol";

/** The human-comparable tail of a machine id: the last 6 characters, e.g. "…3f9a2c". */
export function machineIdTail(id: string): string {
  const compact = id.trim();
  return compact.length <= 6 ? compact : compact.slice(-6);
}

/** True when this machine has a real, operator-meaningful name (vs the unnamed sentinel).
 *  POL-145 — the logic moved to the protocol so the SERVER can apply the same rule when deciding
 *  what the pending board's ident flashes; re-exported so console call sites don't churn. */
export { machineHasName };

/** The name to display for a machine — the operator's name, or an honest "Unnamed box · <tail>". */
export function machineDisplayName(machine: { id: string; label: string }): string {
  if (machineHasName(machine)) return machine.label.trim();
  return `Unnamed box · ${machineIdTail(machine.id)}`;
}

/**
 * POL-141 — the name as shown ON A MACHINE CARD, where the id-tail badge sits beside the status
 * pill. The badge is the tail's single home there, so the unnamed placeholder is a plain
 * "Unnamed box" — printing the tail twice on one row would just be noise. Prose contexts
 * (confirm dialogs, toasts, the terminal header) have no badge, so they keep using
 * `machineDisplayName`, where the tail is what disambiguates "Reboot Unnamed box?".
 */
export function machineCardName(machine: { id: string; label: string }): string {
  return machineHasName(machine) ? machine.label.trim() : "Unnamed box";
}
