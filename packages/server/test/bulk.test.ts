/**
 * POL-103 — resolving a bulk target and fanning out over it (`src/bulk.ts`).
 *
 * The load-bearing property is that PARTIAL SUCCESS IS NORMAL: at fleet scale some boxes are always
 * offline, and a bulk reboot over twelve machines with three offline is a successful call with three
 * offline outcomes — not a failure. So these tests hammer the mixed case, and prove that one machine
 * throwing does not take the other eleven down with it.
 */
import { describe, expect, test } from "bun:test";

import type { Machine } from "@polyptic/protocol";

import { appliedCount, fanOut, resolveTarget, unknownIdResults } from "../src/bulk";

function machine(id: string, tags: string[], status: Machine["status"] = "approved"): Machine {
  return { id, label: id.toUpperCase(), outputs: [], status, tags, shellEnabled: false };
}

const fleet: Machine[] = [
  machine("wall1", ["atrium", "canary"]),
  machine("wall2", ["atrium"]),
  machine("wall3", ["floor:2"]),
  machine("wall4", [], "pending"),
];

/** Online boxes: wall1 + wall3. wall2 and wall4 are dark — the whole point of the fan-out tests. */
const online = new Set(["wall1", "wall3"]);

describe("resolveTarget", () => {
  test("a selector selects the tagged machines", () => {
    const resolved = resolveTarget(fleet, { selector: "tag=atrium" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.machines.map((m) => m.id)).toEqual(["wall1", "wall2"]);
    expect(resolved.target).toBe("tag=atrium");
  });

  test("a selector matching NOTHING is an honest empty set, not an error", () => {
    const resolved = resolveTarget(fleet, { selector: "tag=basement" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.machines).toEqual([]);
  });

  test("a selector that does not PARSE is an error, and says why", () => {
    const resolved = resolveTarget(fleet, { selector: "atrium" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("tag=<value>");
  });

  test("an explicit id list resolves in order, de-duplicated, and reports unknown ids", () => {
    const resolved = resolveTarget(fleet, { machineIds: ["wall3", "wall1", "wall3", "ghost"] });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.machines.map((m) => m.id)).toEqual(["wall3", "wall1"]);
    expect(resolved.unknownIds).toEqual(["ghost"]);
  });

  test("an unknown id is a per-machine `failed` result — never a failed call", () => {
    const results = unknownIdResults(["ghost"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("failed");
    expect(results[0]!.detail).toContain("unknown machine");
  });
});

describe("fanOut with mixed online/offline machines", () => {
  /** The shape of every verb in rest.ts: deliver to the box if it's up, report `offline` if not. */
  const deliver = (m: Machine) =>
    online.has(m.id)
      ? { machineId: m.id, label: m.label, outcome: "applied" as const }
      : { machineId: m.id, label: m.label, outcome: "offline" as const, detail: "offline" };

  test("offline boxes are REPORTED, and the online ones still get the op", async () => {
    const resolved = resolveTarget(fleet, { machineIds: ["wall1", "wall2", "wall3", "wall4"] });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const results = await fanOut(resolved.machines, deliver);
    expect(results).toHaveLength(4);
    expect(appliedCount(results)).toBe(2);
    expect(results.filter((r) => r.outcome === "offline").map((r) => r.machineId)).toEqual([
      "wall2",
      "wall4",
    ]);
  });

  test("a selector-targeted fan-out only touches the matched machines", async () => {
    const resolved = resolveTarget(fleet, { selector: "tag=atrium" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const results = await fanOut(resolved.machines, deliver);
    expect(results.map((r) => r.machineId)).toEqual(["wall1", "wall2"]);
    expect(appliedCount(results)).toBe(1); // wall2 is dark
    // wall3 (floor:2) was never in the blast radius.
    expect(results.some((r) => r.machineId === "wall3")).toBe(false);
  });

  test("ONE machine throwing is reported as its own `failed` — the rest still run", async () => {
    const results = await fanOut(fleet, (m) => {
      if (m.id === "wall2") throw new Error("socket exploded");
      return deliver(m);
    });
    expect(results).toHaveLength(4);
    const wall2 = results.find((r) => r.machineId === "wall2")!;
    expect(wall2.outcome).toBe("failed");
    expect(wall2.detail).toBe("socket exploded");
    expect(appliedCount(results)).toBe(2); // wall1 + wall3 still applied
  });

  test("an async action is awaited per machine (the approve/arm path)", async () => {
    const touched: string[] = [];
    const results = await fanOut(fleet.slice(0, 2), async (m) => {
      await Promise.resolve();
      touched.push(m.id);
      return { machineId: m.id, label: m.label, outcome: "applied" as const };
    });
    expect(touched).toEqual(["wall1", "wall2"]);
    expect(appliedCount(results)).toBe(2);
  });

  test("an empty blast radius fans out to nothing at all", async () => {
    const results = await fanOut([], deliver);
    expect(results).toEqual([]);
    expect(appliedCount(results)).toBe(0);
  });
});
