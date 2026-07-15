/**
 * Machine TAGS and the SELECTOR that targets them (POL-103) — shared by the server (which fans a
 * bulk operation out over the matched machines) and the console (which names the blast radius
 * before the operator commits to it). One matcher, one grammar, one source of truth.
 *
 * ## A tag is a flat, opaque string
 *
 * `atrium`, `floor:2`, `canary`. Lowercase, no spaces. The engine gives `:` no meaning — a tag is
 * matched, never parsed — so `floor:2` is a CONVENTION an operator may use, not a key/value model.
 * That is deliberate: the moment tags carry keys, the selector has to grow `!=`, `in (…)`, and
 * precedence rules, and a "small documented syntax" becomes a query language nobody can read at a
 * glance next to a Reboot button. Set membership is enough to say "the atrium", "the ground floor",
 * "the canary ring".
 *
 * ## The selector grammar (all of it)
 *
 *   selector := term ("," term)*
 *   term     := "tag=" tag
 *
 * Terms are ANDed: `tag=atrium,tag=canary` is "carries BOTH tags". There is no OR and no negation —
 * run the op twice, or tag the set you mean.
 *
 * ## The empty selector matches NOTHING
 *
 * Not "everything". A blank/whitespace selector is a parse ERROR, and a selector with no terms
 * matches no machine, so a mis-typed filter can never fan a reboot out across the whole fleet. The
 * fleet-wide case is served by an explicit list of machine ids (the console's checkboxes), where the
 * operator has seen every box they are about to touch.
 */
import { z } from "zod";

/**
 * A tag: lowercase alphanumerics plus `.`, `_`, `:`, `-`; must start alphanumeric; 1–32 chars.
 * Deliberately narrow — a tag is typed into a selector next to a destructive verb, so it must never
 * need quoting, escaping, or trimming to be read correctly.
 */
export const MACHINE_TAG_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,31}$/;

export const MachineTag = z
  .string()
  .regex(MACHINE_TAG_PATTERN, "a tag is 1–32 lowercase chars: a–z, 0–9, and . _ : -");
export type MachineTag = z.infer<typeof MachineTag>;

/** A machine's tag set. Bounded (16) so a card stays readable and a selector stays cheap. */
export const MachineTags = z.array(MachineTag).max(16);
export type MachineTags = z.infer<typeof MachineTags>;

/** A parsed selector: an AND of the tags every matched machine must carry. */
export interface MachineSelector {
  /** The raw text the operator typed, for echoing back in a confirm / an activity line. */
  readonly source: string;
  /** The tags a machine must ALL carry to match. Never empty (a term-less selector is a parse error). */
  readonly tags: readonly string[];
}

export type ParseSelectorResult =
  | { ok: true; selector: MachineSelector }
  | { ok: false; error: string };

/** Lowercase + trim a raw operator-typed tag. Does NOT validate — parse with `MachineTag` after. */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Parse a selector string. Returns a plain sentence on failure — it is shown to the operator
 * verbatim, in the console's filter box and in the server's 400.
 */
export function parseSelector(input: string): ParseSelectorResult {
  const source = input.trim();
  if (source === "") {
    return {
      ok: false,
      error: "an empty selector matches nothing — name at least one tag, e.g. tag=atrium",
    };
  }

  const tags: string[] = [];
  for (const rawTerm of source.split(",")) {
    const term = rawTerm.trim();
    if (term === "") {
      return { ok: false, error: `empty term in "${source}" — terms are separated by a single comma` };
    }
    const match = /^tag\s*=\s*(.*)$/i.exec(term);
    if (!match) {
      return {
        ok: false,
        error: `unrecognised term "${term}" — the only term is tag=<value>, e.g. tag=atrium`,
      };
    }
    const tag = normalizeTag(match[1] ?? "");
    const parsed = MachineTag.safeParse(tag);
    if (!parsed.success) {
      return {
        ok: false,
        error: tag === "" ? `"${term}" names no tag — write tag=atrium` : `invalid tag "${tag}": a tag is 1–32 lowercase chars (a–z, 0–9, . _ : -)`,
      };
    }
    if (!tags.includes(parsed.data)) tags.push(parsed.data);
  }

  return { ok: true, selector: { source, tags } };
}

/** Does a machine's tag set satisfy the selector? (AND of every term; a term-less selector: no.) */
export function matchesSelector(tags: readonly string[] | undefined, selector: MachineSelector): boolean {
  if (selector.tags.length === 0) return false; // an empty selector matches NOTHING, never everything
  const carried = new Set((tags ?? []).map(normalizeTag));
  return selector.tags.every((t) => carried.has(t));
}

/** Filter any tagged thing by a selector — the one matcher the server and the console both use. */
export function selectByTags<T extends { tags?: readonly string[] }>(
  items: readonly T[],
  selector: MachineSelector,
): T[] {
  return items.filter((item) => matchesSelector(item.tags, selector));
}

/** Every distinct tag in a fleet, sorted — the console's tag palette / autocomplete. */
export function distinctTags(items: readonly { tags?: readonly string[] }[]): string[] {
  const all = new Set<string>();
  for (const item of items) for (const tag of item.tags ?? []) all.add(tag);
  return [...all].sort();
}
