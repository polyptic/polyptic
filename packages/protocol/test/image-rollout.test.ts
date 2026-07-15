/**
 * POL-105 — the ring resolver and the version distribution, the two pure functions the server and the
 * console both run. What they pin:
 *
 *  - a machine matching NO ring gets the fleet's active build (the whole safety property);
 *  - the FIRST matching ring wins, and a ring only ever narrows who deviates from the fleet;
 *  - a ring whose build has been PRUNED degrades its machines back onto the active build, loudly —
 *    it never hands a box an id the depot cannot serve (retention stays a dumb count, D105);
 *  - a ring carries its OWN urgency, so canary-now/fleet-tonight is expressible;
 *  - the distribution buckets an OFFLINE box by the build it last reported (that is the box a
 *    roll-out stranded), and never hides a build the depot has lost.
 */
import { describe, expect, test } from "bun:test";

import { ImageRing, imageDistribution, resolveRolloutImage } from "../src/index";
import type { DistributableBuild, DistributableMachine } from "../src/index";

const ACTIVE = "20260714T010000Z-aaaaaaaa";
const CANARY = "20260714T020000Z-bbbbbbbb";
const OLD = "20260710T010000Z-cccccccc";

const ring = (over: Partial<ImageRing> = {}): ImageRing =>
  ImageRing.parse({ selector: "tag=canary", arch: "amd64", imageId: CANARY, ...over });

const retained = (...ids: string[]) => new Set(ids);

describe("resolveRolloutImage", () => {
  test("no rings: every machine gets the fleet's active build", () => {
    const r = resolveRolloutImage([], "amd64", ["atrium"], ACTIVE, false, retained(ACTIVE));
    expect(r.imageId).toBe(ACTIVE);
    expect(r.urgent).toBe(false);
    expect(r.ring).toBeNull();
  });

  test("an untagged machine matches no ring — a ring can never widen a roll-out", () => {
    const r = resolveRolloutImage([ring()], "amd64", [], ACTIVE, false, retained(ACTIVE, CANARY));
    expect(r.imageId).toBe(ACTIVE);
    expect(r.ring).toBeNull();
  });

  test("a tagged machine boots the ring's build, with the RING's urgency", () => {
    const r = resolveRolloutImage(
      [ring({ urgent: true })],
      "amd64",
      ["canary", "atrium"],
      ACTIVE,
      false, // the FLEET is not urgent — the canary still reboots now
      retained(ACTIVE, CANARY),
    );
    expect(r.imageId).toBe(CANARY);
    expect(r.urgent).toBe(true);
    expect(r.ring?.selector).toBe("tag=canary");
  });

  test("the ring is arch-scoped: an arm64 box is untouched by an amd64 ring", () => {
    const r = resolveRolloutImage([ring()], "arm64", ["canary"], ACTIVE, false, retained(ACTIVE, CANARY));
    expect(r.imageId).toBe(ACTIVE);
    expect(r.ring).toBeNull();
  });

  test("first match wins, in operator order", () => {
    const rings = [
      ring({ selector: "tag=canary,tag=atrium", imageId: OLD }),
      ring({ selector: "tag=canary", imageId: CANARY }),
    ];
    const both = resolveRolloutImage(rings, "amd64", ["canary", "atrium"], ACTIVE, false, retained(ACTIVE, CANARY, OLD));
    expect(both.imageId).toBe(OLD); // the AND-ring is listed first
    const onlyCanary = resolveRolloutImage(rings, "amd64", ["canary"], ACTIVE, false, retained(ACTIVE, CANARY, OLD));
    expect(onlyCanary.imageId).toBe(CANARY);
  });

  test("a ring whose build was PRUNED falls back to the fleet build and says so", () => {
    const r = resolveRolloutImage([ring()], "amd64", ["canary"], ACTIVE, false, retained(ACTIVE)); // CANARY gone
    expect(r.imageId).toBe(ACTIVE);
    expect(r.urgent).toBe(false); // the fleet's urgency, not the dead ring's
    expect(r.ring).toBeNull();
    expect(r.strandedRing?.imageId).toBe(CANARY);
  });

  test("an unparseable ring targets nothing rather than everything", () => {
    // A selector that cannot be parsed must never degrade to "matches all" — that would fan a canary
    // build out across the fleet, the exact accident POL-103's empty-selector rule exists to prevent.
    const bad = { selector: "everything", arch: "amd64", imageId: CANARY, urgent: true } as ImageRing;
    const r = resolveRolloutImage([bad], "amd64", ["canary"], ACTIVE, false, retained(ACTIVE, CANARY));
    expect(r.imageId).toBe(ACTIVE);
    expect(r.ring).toBeNull();
  });

  test("the fleet's own urgency still applies to the machines no ring matches", () => {
    const r = resolveRolloutImage([ring()], "amd64", ["atrium"], ACTIVE, true, retained(ACTIVE, CANARY));
    expect(r.imageId).toBe(ACTIVE);
    expect(r.urgent).toBe(true);
  });
});

describe("imageDistribution", () => {
  const builds: DistributableBuild[] = [
    { arch: "amd64", imageId: CANARY, builtAt: "2026-07-14T02:00:00.000Z", active: false },
    { arch: "amd64", imageId: ACTIVE, builtAt: "2026-07-14T01:00:00.000Z", active: true },
  ];
  const machines: DistributableMachine[] = [
    { id: "m1", label: "wall1", online: true, tags: ["canary"], imageId: CANARY },
    { id: "m2", label: "wall2", online: true, tags: [], imageId: ACTIVE },
    { id: "m3", label: "wall3", online: false, tags: [], imageId: ACTIVE },
    { id: "m4", label: "atrium", online: false, tags: ["atrium"], imageId: OLD }, // pruned build
    { id: "m5", label: "new-box", online: true, tags: [] }, // never reported
  ];

  test("buckets the fleet by the build each box actually booted", () => {
    const dist = imageDistribution(machines, builds);
    const byId = new Map(dist.map((b) => [b.imageId, b]));
    expect(byId.get(CANARY)?.machines.map((m) => m.id)).toEqual(["m1"]);
    expect(byId.get(ACTIVE)?.machines.map((m) => m.id)).toEqual(["m2", "m3"]);
    expect(byId.get(ACTIVE)?.active).toBe(true);
  });

  test("an OFFLINE box is still bucketed — it is the box a roll-out stranded", () => {
    const dist = imageDistribution(machines, builds);
    const old = dist.find((b) => b.imageId === OLD);
    expect(old?.machines[0]?.label).toBe("atrium");
    expect(old?.machines[0]?.online).toBe(false);
    // The depot no longer has this build: the bucket says so rather than hiding the box.
    expect(old?.retained).toBe(false);
    expect(old?.active).toBe(false);
  });

  test("a box that has never reported one gets the 'unknown' bucket, sorted last", () => {
    const dist = imageDistribution(machines, builds);
    expect(dist.at(-1)?.imageId).toBeNull();
    expect(dist.at(-1)?.machines.map((m) => m.id)).toEqual(["m5"]);
  });

  test("newest build first", () => {
    const dist = imageDistribution(machines, builds);
    expect(dist[0]?.imageId).toBe(CANARY);
    expect(dist[1]?.imageId).toBe(ACTIVE);
  });

  test("an empty fleet distributes to nothing", () => {
    expect(imageDistribution([], builds)).toEqual([]);
  });
});
