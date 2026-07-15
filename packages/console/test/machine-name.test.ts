/**
 * POL-117 — the display-name fallback, pinned.
 *
 * The one rule with teeth: the console NEVER renders `localhost.localdomain` (or any label that is
 * really just the machine id, or any other meaningless live-image hostname) as if it were a name.
 * Unnamed boxes say so — "Unnamed box · <id tail>" — because with several identical netbooted boxes
 * pending at once, a fake name is worse than no name.
 */
import { describe, expect, test } from "bun:test";

import { machineCardName, machineDisplayName, machineHasName, machineIdTail } from "../src/machine-name";

const ID = "dmi-4c4c4544-0035-3010-8057-b8c04f4a3f9a";

describe("machineDisplayName", () => {
  test("an operator-set label is the identity", () => {
    expect(machineDisplayName({ id: ID, label: "Lobby Left" })).toBe("Lobby Left");
    expect(machineHasName({ id: ID, label: "Lobby Left" })).toBe(true);
  });

  test("NEVER shows localhost.localdomain as the name", () => {
    for (const label of ["localhost.localdomain", "LOCALHOST.LOCALDOMAIN", "localhost", "box.localdomain"]) {
      const shown = machineDisplayName({ id: ID, label });
      expect(shown).not.toContain("localhost");
      expect(shown).not.toContain("localdomain");
      expect(shown.startsWith("Unnamed box")).toBe(true);
    }
  });

  test("the unnamed sentinel (label = id) renders honestly with the id tail", () => {
    const shown = machineDisplayName({ id: ID, label: ID });
    expect(shown).toBe(`Unnamed box · ${ID.slice(-6)}`);
  });

  test("an empty label is unnamed too", () => {
    expect(machineDisplayName({ id: ID, label: "" }).startsWith("Unnamed box")).toBe(true);
    expect(machineDisplayName({ id: ID, label: "   " }).startsWith("Unnamed box")).toBe(true);
  });

  test("a meaningful hostname adopted as the label still shows (it identifies the box)", () => {
    expect(machineDisplayName({ id: ID, label: "kiosk-7" })).toBe("kiosk-7");
  });
});

describe("machineIdTail", () => {
  test("last 6 characters of a long id; short ids pass through", () => {
    expect(machineIdTail(ID)).toBe("4a3f9a");
    expect(machineIdTail("abc")).toBe("abc");
  });
});

describe("machineCardName — POL-141, the badge-aware card name", () => {
  test("a named machine shows its name, same as everywhere else", () => {
    expect(machineCardName({ id: ID, label: "Lobby Left" })).toBe("Lobby Left");
  });

  test("an unnamed machine is a plain 'Unnamed box' — the id tail lives in the card's badge, never twice", () => {
    for (const label of [ID, "", "   ", "localhost.localdomain"]) {
      const shown = machineCardName({ id: ID, label });
      expect(shown).toBe("Unnamed box");
      expect(shown).not.toContain(machineIdTail(ID));
    }
  });

  test("prose contexts keep the tail: machineDisplayName is unchanged", () => {
    expect(machineDisplayName({ id: ID, label: ID })).toBe(`Unnamed box · ${ID.slice(-6)}`);
  });
});
