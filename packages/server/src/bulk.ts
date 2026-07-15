/**
 * POL-103 — resolving a bulk TARGET and fanning an operation out over it.
 *
 * Two halves, both pure and both unit-tested (`test/bulk.test.ts`):
 *
 *   resolveTarget — a body's `{selector}` or `{machineIds}` → the machines it names. A selector that
 *                   matches nothing is not an error (an operator may simply have retired the atrium);
 *                   a selector that does not PARSE is, and says why. An unknown machine id is
 *                   reported per-machine, not fatal — see below.
 *
 *   fanOut        — run an async per-machine action over that set and collect a RESULT PER MACHINE.
 *                   Partial success is the normal case at fleet scale: three offline boxes must not
 *                   fail the other nine, so nothing here throws on a single machine's outcome — an
 *                   action that throws is caught and reported as `failed` against that one box.
 *
 * The verbs themselves (reboot, arm, ident, approve) live in rest.ts; this module only knows how to
 * choose the machines and how to keep one bad box from taking the call down with it.
 */
import { parseSelector, selectByTags } from "@polyptic/protocol";
import type { BulkMachineResult, Machine } from "@polyptic/protocol";

/** What a bulk body names: a tag selector, or an explicit list. The protocol rejects "neither". */
export interface BulkTarget {
  selector?: string;
  machineIds?: string[];
}

export type ResolveTargetResult =
  | {
      ok: true;
      /** The matched machines, in registry order. May be empty — an honest zero, not an error. */
      machines: Machine[];
      /** How the target was named, for the response + the activity line ("tag=atrium" / "3 machines"). */
      target: string;
      /** Ids that named no machine (only possible for an explicit list) — reported, never fatal. */
      unknownIds: string[];
    }
  | { ok: false; error: string };

/** Resolve a bulk body's target against the registry. */
export function resolveTarget(machines: Machine[], target: BulkTarget): ResolveTargetResult {
  const selectorText = target.selector?.trim();
  if (selectorText) {
    const parsed = parseSelector(selectorText);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return {
      ok: true,
      machines: selectByTags(machines, parsed.selector),
      target: parsed.selector.source,
      unknownIds: [],
    };
  }

  const ids = target.machineIds ?? [];
  const byId = new Map(machines.map((m) => [m.id, m]));
  const matched: Machine[] = [];
  const unknownIds: string[] = [];
  for (const id of ids) {
    const machine = byId.get(id);
    if (machine) {
      if (!matched.includes(machine)) matched.push(machine);
    } else {
      unknownIds.push(id);
    }
  }
  return { ok: true, machines: matched, target: `${ids.length} selected`, unknownIds };
}

/**
 * Run `action` over every machine and collect one result each. Never throws: an action that does is
 * reported as that machine's `failed` outcome, and the fan-out carries on to the next box.
 */
export async function fanOut(
  machines: Machine[],
  action: (machine: Machine) => Promise<BulkMachineResult> | BulkMachineResult,
): Promise<BulkMachineResult[]> {
  const results: BulkMachineResult[] = [];
  for (const machine of machines) {
    try {
      results.push(await action(machine));
    } catch (err) {
      results.push({
        machineId: machine.id,
        label: machine.label,
        outcome: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/** The unknown ids from an explicit list, as per-machine `failed` results (so nothing goes unreported). */
export function unknownIdResults(unknownIds: string[]): BulkMachineResult[] {
  return unknownIds.map((id) => ({
    machineId: id,
    label: id,
    outcome: "failed" as const,
    detail: "unknown machine — it may have been removed",
  }));
}

/** How many of a result list actually landed. */
export function appliedCount(results: BulkMachineResult[]): number {
  return results.filter((r) => r.outcome === "applied").length;
}
