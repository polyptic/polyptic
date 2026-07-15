/**
 * POL-103 — the tag selector: parsing and matching.
 *
 * This is the grammar an operator types next to a Reboot button, so the tests are about what it
 * REFUSES as much as what it matches: an empty selector matches nothing (never everything), an
 * unknown tag matches nothing (it is not an error — the atrium may simply have been retired), and a
 * multi-term selector is an AND, so a partial match is no match.
 */
import { describe, expect, test } from "bun:test";

import {
  MachineTag,
  distinctTags,
  matchesSelector,
  normalizeTag,
  parseSelector,
  selectByTags,
} from "../src/selector";

const fleet = [
  { id: "a", tags: ["atrium", "floor:1"] },
  { id: "b", tags: ["atrium", "floor:2", "canary"] },
  { id: "c", tags: ["floor:2"] },
  { id: "d", tags: [] },
  { id: "e" }, // never tagged at all (a legacy row)
];

function select(source: string): string[] {
  const parsed = parseSelector(source);
  if (!parsed.ok) throw new Error(`expected "${source}" to parse: ${parsed.error}`);
  return selectByTags(fleet, parsed.selector).map((m) => m.id);
}

describe("parseSelector", () => {
  test("a single term parses to one tag", () => {
    const parsed = parseSelector("tag=atrium");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.selector.tags).toEqual(["atrium"]);
    expect(parsed.selector.source).toBe("tag=atrium");
  });

  test("comma-separated terms are ANDed, de-duplicated, and whitespace-tolerant", () => {
    const parsed = parseSelector("  tag=floor:2 , tag = canary , tag=canary ");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.selector.tags).toEqual(["floor:2", "canary"]);
  });

  test("tags are case-insensitive on the way in", () => {
    const parsed = parseSelector("tag=Atrium");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.selector.tags).toEqual(["atrium"]);
  });

  test("THE EMPTY SELECTOR is a parse error — it must never be read as 'the whole fleet'", () => {
    for (const blank of ["", "   ", "\t"]) {
      const parsed = parseSelector(blank);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error).toContain("matches nothing");
    }
  });

  test("an unrecognised term is refused, and the sentence says what a term looks like", () => {
    const parsed = parseSelector("atrium");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("tag=<value>");
  });

  test("a term with no value, an empty term, and an illegal tag are each refused", () => {
    expect(parseSelector("tag=").ok).toBe(false);
    expect(parseSelector("tag=atrium,,tag=canary").ok).toBe(false);
    expect(parseSelector("tag=at rium").ok).toBe(false);
    expect(parseSelector("tag=-leading").ok).toBe(false);
  });

  test("`label=x` is not a term — the grammar is deliberately one keyword wide", () => {
    expect(parseSelector("label=wall1").ok).toBe(false);
  });
});

describe("matchesSelector / selectByTags", () => {
  test("a single tag selects every machine carrying it", () => {
    expect(select("tag=atrium")).toEqual(["a", "b"]);
  });

  test("two terms are an AND — a PARTIAL match is no match", () => {
    // `c` carries floor:2 but not canary; `b` carries both.
    expect(select("tag=floor:2,tag=canary")).toEqual(["b"]);
  });

  test("an UNKNOWN tag matches nothing, and that is not an error", () => {
    expect(select("tag=basement")).toEqual([]);
    expect(select("tag=atrium,tag=basement")).toEqual([]);
  });

  test("untagged machines (and legacy rows with no tags at all) never match", () => {
    expect(select("tag=atrium")).not.toContain("d");
    expect(select("tag=atrium")).not.toContain("e");
  });

  test("a term-less selector matches NOTHING, defensively — belt and braces with the parser", () => {
    expect(matchesSelector(["atrium"], { source: "", tags: [] })).toBe(false);
  });

  test("matching is case-insensitive on the machine's tags too", () => {
    expect(matchesSelector(["ATRIUM"], { source: "tag=atrium", tags: ["atrium"] })).toBe(true);
  });
});

describe("tag hygiene", () => {
  test("normalizeTag trims and lowercases", () => {
    expect(normalizeTag("  Floor:2 ")).toBe("floor:2");
  });

  test("MachineTag accepts the documented shape and rejects the rest", () => {
    for (const good of ["atrium", "floor:2", "canary-1", "rack_a", "v1.2"]) {
      expect(MachineTag.safeParse(good).success).toBe(true);
    }
    for (const bad of ["", "Atrium", "two words", ":leading", "-leading", "x".repeat(33)]) {
      expect(MachineTag.safeParse(bad).success).toBe(false);
    }
  });

  test("distinctTags is the fleet's tag palette, sorted", () => {
    expect(distinctTags(fleet)).toEqual(["atrium", "canary", "floor:1", "floor:2"]);
  });
});
