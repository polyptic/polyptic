/**
 * POL-104 — pre-registration: the matcher and the CSV paste.
 *
 * The claims that matter here are about NOT being wrong. Pre-registration decides what a box is
 * CALLED and whether a human has to approve it, so a mis-match auto-names (and possibly auto-approves)
 * the wrong physical panel. Hence: strongest key first, placeholders never match, and an AMBIGUOUS
 * match matches nothing at all.
 *
 * And the soft key is soft on purpose. A Wi-Fi-bridged VM's MAC is rewritten by its host (POL-63 /
 * POL-78, learned the hard way in the homelab), so a MAC is a convenience, never a proof — which is
 * only acceptable because a pre-registration grants NOTHING: it is consulted after the enrolment token
 * has already authenticated the box.
 */
import { describe, expect, test } from "bun:test";

import {
  matchPreRegistration,
  normalizeMac,
  normalizeSerial,
  parsePreRegistrationCsv,
} from "../src/preregistration";
import type { HostIdentity, PreRegistration } from "@polyptic/protocol";

function record(overrides: Partial<PreRegistration>): PreRegistration {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    tags: [],
    autoApprove: true,
    createdAt: "2026-07-14T12:00:00.000Z",
    ...overrides,
  } as PreRegistration;
}

const hardware = (overrides: Partial<HostIdentity> = {}): HostIdentity => ({
  macs: [],
  ...overrides,
});

describe("normalization", () => {
  test("a MAC is accepted in whatever shape the vendor's spreadsheet gave the operator", () => {
    expect(normalizeMac("AA-BB-CC-DD-EE-01")).toBe("aa:bb:cc:dd:ee:01");
    expect(normalizeMac("aabb.ccdd.ee01")).toBe("aa:bb:cc:dd:ee:01");
    expect(normalizeMac("AABBCCDDEE01")).toBe("aa:bb:cc:dd:ee:01");
    expect(normalizeMac(" aa:bb:cc:dd:ee:01 ")).toBe("aa:bb:cc:dd:ee:01");
  });

  test("junk is not a MAC", () => {
    expect(normalizeMac("Lobby left")).toBeUndefined();
    expect(normalizeMac("00:00:00:00:00:00")).toBeUndefined();
    expect(normalizeMac("aa:bb:cc")).toBeUndefined();
    expect(normalizeMac(undefined)).toBeUndefined();
  });

  test("a vendor placeholder is NOT a serial — matching on it would collide every such box into one record", () => {
    expect(normalizeSerial("To be filled by O.E.M.")).toBeUndefined();
    expect(normalizeSerial("Default string")).toBeUndefined();
    expect(normalizeSerial("0123456789")).toBeUndefined();
    expect(normalizeSerial("None")).toBeUndefined();
    expect(normalizeSerial("SN-1234567")).toBe("sn-1234567");
  });
});

describe("matching", () => {
  test("machineId wins over everything else", () => {
    const byId = record({ id: "r1", machineId: "dmi-abc", label: "Right" });
    const byMac = record({ id: "r2", mac: "aa:bb:cc:dd:ee:01", label: "Wrong" });
    const match = matchPreRegistration([byMac, byId], "dmi-abc", hardware({ macs: ["aa:bb:cc:dd:ee:01"] }));
    expect(match?.record.id).toBe("r1");
    expect(match?.matchedOn).toBe("machineId");
  });

  test("a serial beats a MAC", () => {
    const bySerial = record({ id: "r1", dmiSerial: "SN-1234567" });
    const byMac = record({ id: "r2", mac: "aa:bb:cc:dd:ee:01" });
    const match = matchPreRegistration(
      [byMac, bySerial],
      "box-1",
      hardware({ macs: ["aa:bb:cc:dd:ee:01"], dmiSerial: "sn-1234567" }),
    );
    expect(match?.record.id).toBe("r1");
    expect(match?.matchedOn).toBe("dmiSerial");
  });

  test("a MAC matches when it is all we have", () => {
    const byMac = record({ id: "r2", mac: "AA-BB-CC-DD-EE-01" });
    const match = matchPreRegistration([byMac], "box-1", hardware({ macs: ["aa:bb:cc:dd:ee:01"] }));
    expect(match?.matchedOn).toBe("mac");
  });

  test("AN AMBIGUOUS MATCH MATCHES NOTHING — auto-naming the wrong box is worse than one manual approval", () => {
    const a = record({ id: "r1", mac: "aa:bb:cc:dd:ee:01", label: "Lobby left" });
    const b = record({ id: "r2", mac: "aa:bb:cc:dd:ee:01", label: "Lobby right" });
    expect(matchPreRegistration([a, b], "box-1", hardware({ macs: ["aa:bb:cc:dd:ee:01"] }))).toBeUndefined();
  });

  test("a placeholder serial on the BOX matches no record", () => {
    const bySerial = record({ id: "r1", dmiSerial: "Default string" });
    expect(
      matchPreRegistration([bySerial], "box-1", hardware({ dmiSerial: "Default string" })),
    ).toBeUndefined();
  });

  test("a record already claimed by ANOTHER machine is not re-used", () => {
    const claimed = record({ id: "r1", mac: "aa:bb:cc:dd:ee:01", matchedMachineId: "box-9" });
    expect(matchPreRegistration([claimed], "box-1", hardware({ macs: ["aa:bb:cc:dd:ee:01"] }))).toBeUndefined();
  });

  test("…but re-enrolling the SAME machine re-matches its own record (idempotent)", () => {
    const claimed = record({ id: "r1", mac: "aa:bb:cc:dd:ee:01", matchedMachineId: "box-1" });
    expect(matchPreRegistration([claimed], "box-1", hardware({ macs: ["aa:bb:cc:dd:ee:01"] }))?.record.id).toBe(
      "r1",
    );
  });

  test("a box that reports no hardware at all (a pre-POL-104 agent) simply matches nothing", () => {
    const byMac = record({ id: "r1", mac: "aa:bb:cc:dd:ee:01" });
    expect(matchPreRegistration([byMac], "box-1", undefined)).toBeUndefined();
  });
});

describe("the CSV paste", () => {
  test("label, identifier, tags…", () => {
    const { records, errors } = parsePreRegistrationCsv(
      [
        "# the delivery note",
        "Lobby left, aa:bb:cc:dd:ee:01, floor-1, lobby",
        "Lobby right, SN-1234567, floor-1",
        "dmi-9f2c4a",
        "",
      ].join("\n"),
    );
    expect(errors).toHaveLength(0);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      label: "Lobby left",
      mac: "aa:bb:cc:dd:ee:01",
      tags: ["floor-1", "lobby"],
    });
    expect(records[1]).toMatchObject({ label: "Lobby right", dmiSerial: "SN-1234567" });
    // A bare box identity, no label: the box still gets claimed, it just keeps its own name.
    expect(records[2]).toMatchObject({ machineId: "dmi-9f2c4a", tags: [] });
  });

  test("a line with no usable identifier is REPORTED, not dropped", () => {
    const { records, errors } = parsePreRegistrationCsv("Lobby left\nLobby right, aa:bb:cc:dd:ee:02");
    expect(records).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 1, reason: "no MAC, serial or machine id on this line" });
  });

  test("a spreadsheet header row is skipped", () => {
    const { records } = parsePreRegistrationCsv("label,mac\nLobby, aa:bb:cc:dd:ee:03");
    expect(records).toHaveLength(1);
    expect(records[0]?.label).toBe("Lobby");
  });
});
