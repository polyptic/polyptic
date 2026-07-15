/**
 * Staged (canary) image roll-outs and the fleet's version distribution (POL-105).
 *
 * ## The problem this replaces
 *
 * Until now the depot published ONE image id per arch (`image-id.txt` → `manifest.json`), every box
 * compared it against its own `/etc/polyptic/image-id` every five minutes (D51), and the only dial an
 * operator had was `urgent` — a FLEET-GLOBAL hammer. A bad build therefore reached every screen at
 * once, and nobody could answer "which boxes are still on 20260711T…?", because the control plane
 * knew what it SERVED and never what each box had actually BOOTED.
 *
 * ## A ring is a selector + a build
 *
 * A ROLL-OUT RING pins one build for the machines a POL-103 SELECTOR matches:
 *
 *   { selector: "tag=canary", arch: "amd64", imageId: "20260714T…", urgent: true }
 *
 * The selector is POL-103's grammar verbatim (`tag=canary`, comma = AND) — parsed with
 * `parseSelector`, matched with `matchesSelector` against the machine's tags. There is no second
 * targeting language, and a ring is therefore exactly "the same fan-out the bulk verbs use, but the
 * thing being fanned out is which image id the box is told to boot".
 *
 * Rings are an ORDERED list and the FIRST match wins; a machine matching no ring — including every
 * untagged box, and every box whose id the depot has never heard of — gets the depot's ACTIVE build,
 * i.e. exactly today's behaviour. That is the safety property: rings can only ever *narrow* who
 * deviates from the fleet build, never widen it.
 *
 * ## Urgency stops being global
 *
 * Each ring carries its OWN `urgent`, so "canary reboots now, the rest of the fleet waits for the
 * nightly window" is expressible — which is the whole point of a canary. The fleet-wide `urgent`
 * switch survives untouched for the boxes no ring matches (D54's "Deploy latest to fleet immediately").
 */
import { z } from "zod";

import { matchesSelector, parseSelector } from "./selector";

export const ImageArch = z.enum(["arm64", "amd64"]);
export type ImageArch = z.infer<typeof ImageArch>;

/**
 * One roll-out ring. `imageId` MUST be a build the depot still retains (POL-45) — the server refuses
 * to pin one it cannot serve — but retention is a dumb count (D54/D105), so a long-lived ring can
 * still outlive its build; see {@link resolveRolloutImage} for what happens then.
 */
export const ImageRing = z.object({
  /** A POL-103 selector — the machines this ring targets, e.g. `tag=canary`. */
  selector: z.string().min(1).max(200),
  arch: ImageArch,
  /** The build these machines boot instead of the fleet's active one. */
  imageId: z.string().min(1),
  /** This ring's own roll-out urgency: true → its boxes reboot within minutes (splayed), false →
   *  they wait for the nightly window. Independent of the fleet-wide switch. */
  urgent: z.boolean().default(false),
});
export type ImageRing = z.infer<typeof ImageRing>;

/** At most one ring per (selector, arch): a machine must never have two answers for one arch. */
export const ImageRings = z.array(ImageRing).max(16);
export type ImageRings = z.infer<typeof ImageRings>;

/** What a machine should boot, and why — the answer `manifest.json?machineId=…` is built from. */
export interface RolloutResolution {
  imageId: string;
  urgent: boolean;
  /** The ring that decided it, or null when the machine simply follows the fleet's active build. */
  ring: ImageRing | null;
  /**
   * Set when a ring MATCHED but its build is no longer in the depot (pruned out from under it), so
   * the machine falls back to the active build. Loud on purpose: a canary that has silently rejoined
   * the fleet is a canary that is no longer testing anything.
   */
  strandedRing?: ImageRing;
}

/**
 * Resolve the image id for ONE machine.
 *
 * `retained` is the set of build ids this arch still has on disk. A ring whose build has been pruned
 * resolves to the ACTIVE build (with `strandedRing` set) rather than to a 404: retention is a count,
 * not a pin-aware GC — pin-aware retention was considered and rejected (D105), because protecting
 * every build a ring might still want means effectively never pruning. Degrading a stranded canary
 * back onto the fleet build is strictly better than serving a box a build id the depot cannot answer.
 */
export function resolveRolloutImage(
  rings: readonly ImageRing[],
  arch: string,
  tags: readonly string[],
  activeImageId: string,
  fleetUrgent: boolean,
  retained: ReadonlySet<string>,
): RolloutResolution {
  for (const ring of rings) {
    if (ring.arch !== arch) continue;
    const parsed = parseSelector(ring.selector);
    if (!parsed.ok) continue; // an unparseable ring targets nothing — it can never widen a roll-out
    if (!matchesSelector(tags, parsed.selector)) continue;
    if (!retained.has(ring.imageId)) {
      return { imageId: activeImageId, urgent: fleetUrgent, ring: null, strandedRing: ring };
    }
    return { imageId: ring.imageId, urgent: ring.urgent, ring };
  }
  return { imageId: activeImageId, urgent: fleetUrgent, ring: null };
}

// ── The version distribution (the other half of POL-105) ──────────────────────────────────────────
//
// Every box reports the image id it BOOTED (`/etc/polyptic/image-id`) — on `agent/hello` and in each
// heartbeat's vitals — and the control plane persists the last value it heard. So an OFFLINE box
// still tells you which build it was on, which is exactly the box a roll-out has stranded and the
// one an operator needs to find.

/** One machine as it appears in a version bucket. */
export const ImageDistributionMachine = z.object({
  id: z.string(),
  label: z.string(),
  online: z.boolean(),
  tags: z.array(z.string()).default([]),
});
export type ImageDistributionMachine = z.infer<typeof ImageDistributionMachine>;

/** All the machines known to be running ONE build (or, with `imageId: null`, none we have heard). */
export const ImageDistributionBucket = z.object({
  /** The build these machines booted; null = the box has never reported one (pre-POL-105 agent, or
   *  a box that has not connected since the control plane learned to ask). */
  imageId: z.string().nullable(),
  /** From the depot, when the build is still retained: which arch it is, when it was built, and
   *  whether it is the arch's ACTIVE build. Null/false for a build the depot no longer has. */
  arch: ImageArch.nullable(),
  builtAt: z.string().nullable(),
  active: z.boolean(),
  /** Is this build still in the depot (i.e. can a box still be pointed at it)? */
  retained: z.boolean(),
  machines: z.array(ImageDistributionMachine),
});
export type ImageDistributionBucket = z.infer<typeof ImageDistributionBucket>;

/** The minimum a machine must expose to be bucketed (a `MachineView`, structurally). */
export interface DistributableMachine {
  id: string;
  label: string;
  online: boolean;
  tags?: readonly string[];
  /** The last image id this box reported booting. */
  imageId?: string;
}

/** The minimum a depot build must expose to be joined onto a bucket (an `ImageBuild`). */
export interface DistributableBuild {
  arch: ImageArch;
  imageId: string;
  builtAt: string;
  active: boolean;
}

/**
 * Group the fleet by the build each box is RUNNING, newest build first, unknown last. The one
 * implementation: the console renders it, and the server's tests pin it. Machines the depot has no
 * build for (a pruned build, a hand-flashed stick) still get a bucket — the whole question is "who is
 * on something they should not be", so a build we no longer serve is the MOST interesting bucket, not
 * one to hide.
 */
export function imageDistribution(
  machines: readonly DistributableMachine[],
  builds: readonly DistributableBuild[],
): ImageDistributionBucket[] {
  const byId = new Map<string, DistributableBuild>();
  for (const b of builds) if (!byId.has(b.imageId)) byId.set(b.imageId, b);

  const buckets = new Map<string, ImageDistributionBucket>();
  const key = (id: string | null) => id ?? " unknown";
  for (const m of machines) {
    const imageId = m.imageId ?? null;
    let bucket = buckets.get(key(imageId));
    if (!bucket) {
      const build = imageId ? byId.get(imageId) : undefined;
      bucket = {
        imageId,
        arch: build?.arch ?? null,
        builtAt: build?.builtAt ?? null,
        active: build?.active ?? false,
        retained: Boolean(build),
        machines: [],
      };
      buckets.set(key(imageId), bucket);
    }
    bucket.machines.push({ id: m.id, label: m.label, online: m.online, tags: [...(m.tags ?? [])] });
  }

  for (const b of buckets.values()) b.machines.sort((x, y) => x.label.localeCompare(y.label));
  return [...buckets.values()].sort((a, b) => {
    if (a.imageId === null) return 1; // "unknown" always last
    if (b.imageId === null) return -1;
    // Newest build first; builds the depot has lost sort by their id (which is a timestamp).
    const at = a.builtAt ?? "";
    const bt = b.builtAt ?? "";
    if (at !== bt) return bt.localeCompare(at);
    return b.imageId.localeCompare(a.imageId);
  });
}
