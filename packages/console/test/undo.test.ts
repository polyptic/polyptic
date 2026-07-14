/**
 * The inverse-action helpers (POL-93) — what "Undo" is allowed to promise.
 *
 * These are the guards that keep the Undo button honest. It appears only where the console can name
 * a true inverse from state it already holds; every case below that returns null is a case where a
 * button would have been a lie (an ad-hoc URL whose assignment admin/state does not carry, an
 * ambiguous library name, a rename that changed nothing).
 */
import { describe, expect, test } from "bun:test";
import type { ContentSource, Placement } from "@polyptic/protocol";

import {
  previousAssignment,
  previousName,
  recreateSourceBody,
  restorePlacementBody,
  type ScreenContent,
} from "../src/undo";

const web = (over: Partial<ContentSource> = {}): ContentSource =>
  ({
    id: "src-1",
    name: "Ops board",
    kind: "web",
    url: "https://example.invalid/ops",
    ...over,
  }) as ContentSource;

describe("previousAssignment — what was on the screen before we changed it", () => {
  test("a library source showing under a unique name+kind is an exact inverse", () => {
    const content: ScreenContent = { name: "Ops board", kind: "web" };
    expect(previousAssignment(content, [web(), web({ id: "src-2", name: "Other" })])).toEqual({
      sourceId: "src-1",
    });
  });

  test("nothing was showing → no inverse (there is no 'clear the screen' call to make)", () => {
    expect(previousAssignment(null, [web()])).toBeNull();
    expect(previousAssignment(undefined, [web()])).toBeNull();
  });

  test("an AMBIGUOUS name (two sources, same name+kind) yields no Undo rather than a guess", () => {
    const content: ScreenContent = { name: "Ops board", kind: "web" };
    const twins = [web(), web({ id: "src-2" })];
    expect(previousAssignment(content, twins)).toBeNull();
  });

  test("content the library cannot name (an ad-hoc URL's derived name) yields no Undo", () => {
    const content: ScreenContent = { name: "example.invalid", kind: "web" };
    expect(previousAssignment(content, [web()])).toBeNull();
  });

  test("the KIND has to match too — a page named like a web source is not that source", () => {
    const content: ScreenContent = { name: "Ops board", kind: "page" };
    expect(previousAssignment(content, [web()])).toBeNull();
  });
});

describe("recreateSourceBody — putting a deleted source back in the library", () => {
  test("drops the (dead) id and keeps the substance, including its credential profile", () => {
    const body = recreateSourceBody(web({ credentialProfileId: "prof-1" }));
    expect(body).toEqual({
      name: "Ops board",
      kind: "web",
      url: "https://example.invalid/ops",
      credentialProfileId: "prof-1",
    });
    expect("id" in body).toBe(false); // a new id is minted server-side — undo is not a resurrection
  });

  test("carries a playlist's steps and a page's definition (url-less kinds re-create in full)", () => {
    const playlist = {
      id: "src-9",
      name: "Lobby loop",
      kind: "playlist",
      items: [{ sourceId: "src-1", durationSeconds: 30 }],
    } as ContentSource;
    expect(recreateSourceBody(playlist)).toEqual({
      name: "Lobby loop",
      kind: "playlist",
      items: [{ sourceId: "src-1", durationSeconds: 30 }],
    });
  });
});

describe("restorePlacementBody — putting an unplaced screen back", () => {
  test("carries the exact geometry, not a default-sized tile", () => {
    const p: Placement = { muralId: "mur-1", screenId: "scr-1", x: 120, y: -40, w: 3840, h: 2160 };
    expect(restorePlacementBody(p)).toEqual({ muralId: "mur-1", x: 120, y: -40, w: 3840, h: 2160 });
  });
});

describe("previousName — the inverse of a rename", () => {
  test("the old name, when there is one to put back", () => {
    expect(previousName("Nessie", "Lobby")).toBe("Nessie");
  });

  test("a no-op rename offers no Undo (the button would do nothing)", () => {
    expect(previousName("Lobby", "Lobby")).toBeNull();
  });

  test("no previous name (a first naming, e.g. an unnamed combined surface) offers no Undo", () => {
    expect(previousName(undefined, "North wall")).toBeNull();
    expect(previousName("   ", "North wall")).toBeNull();
  });
});
