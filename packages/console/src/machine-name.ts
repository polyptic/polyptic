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
import { meaningfulHostname } from "@polyptic/protocol";

/** The human-comparable tail of a machine id: the last 6 characters, e.g. "…3f9a2c". */
export function machineIdTail(id: string): string {
  const compact = id.trim();
  return compact.length <= 6 ? compact : compact.slice(-6);
}

/** True when this machine has a real, operator-meaningful name (vs the unnamed sentinel). */
export function machineHasName(machine: { id: string; label: string }): boolean {
  const label = machine.label.trim();
  if (!label || label === machine.id) return false;
  // A label that is a meaningless hostname (adopted before POL-117) is not a name either.
  return meaningfulHostname(label) !== null;
}

/** The name to display for a machine — the operator's name, or an honest "Unnamed box · <tail>". */
export function machineDisplayName(machine: { id: string; label: string }): string {
  if (machineHasName(machine)) return machine.label.trim();
  return `Unnamed box · ${machineIdTail(machine.id)}`;
}
