/**
 * POL-104 — batch enrolment tokens: the policy, in isolation.
 *
 * The safety-critical claims this file pins, all of which are the difference between "a token model"
 * and "a token model that does not brick a fleet":
 *
 *   BACK-COMPAT   an old-style single bootstrap token (the one baked into every medium already in the
 *                 field) still enrols, and is lifted into the table as a legacy record — no expiry, no
 *                 cap, still the token new media bake.
 *   NEGATIVES     a REVOKED token cannot enrol. An EXPIRED token cannot enrol. A token that has hit its
 *                 max-enrolments CAP cannot enrol another new box.
 *   DO NO HARM    a machine already enrolled on a token that has since been revoked/expired/used up
 *                 STILL CONNECTS on its durable per-machine credential. Revocation gates the door, not
 *                 the room — it must never darken a working wall.
 *   ROTATION      rotating cuts a successor AND leaves the old secret alive for the grace window, so a
 *                 box booting from a medium not yet re-flashed still lands.
 */
import { describe, expect, test } from "bun:test";

import { Enrollment, hashCredential } from "../src/enroll";
import type { AgentHelloMessage, EnrollmentToken } from "../src/enroll";

const HELLO_BASE = {
  t: "agent/hello",
  protocol: 1,
  machineId: "box-1",
  agentVersion: "0.0.0-test",
  backend: "wayland-sway",
  outputs: [],
} as unknown as AgentHelloMessage;

function hello(overrides: Partial<AgentHelloMessage> = {}): AgentHelloMessage {
  return { ...HELLO_BASE, ...overrides } as AgentHelloMessage;
}

/** A clock we can move, so expiry is tested without sleeping. */
function clock(start = Date.parse("2026-07-14T12:00:00.000Z")) {
  let nowMs = start;
  return {
    now: () => nowMs,
    advanceHours: (h: number) => {
      nowMs += h * 3_600_000;
    },
  };
}

describe("open mode", () => {
  test("no tokens at all → every agent is auto-approved (the dev default, unchanged)", () => {
    const enrollment = new Enrollment(undefined);
    expect(enrollment.open).toBe(true);
    expect(enrollment.currentToken).toBeUndefined();
    expect(enrollment.authenticate(hello()).kind).toBe("open");
  });

  test("deleting the last token drops back to open mode", async () => {
    const enrollment = new Enrollment("legacy-secret");
    expect(enrollment.open).toBe(false);
    const [only] = enrollment.list();
    await enrollment.deleteToken(only!.id);
    expect(enrollment.open).toBe(true);
  });
});

describe("backward compatibility — the media already in the field", () => {
  test("the pre-POL-104 single token is lifted verbatim: same secret, no expiry, no cap, baked", () => {
    const enrollment = new Enrollment("old-flat-token");
    const tokens = enrollment.list();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      secret: "old-flat-token",
      expiresAt: null,
      maxEnrollments: null,
      bake: true,
      legacy: true,
    });
    // The token `/boot/grub.cfg` bakes — and therefore the one `build-boot-medium.sh` lifts back out
    // of that menu — is unchanged, so a stick baked before AND after the upgrade carry the same secret.
    expect(enrollment.currentToken).toBe("old-flat-token");
  });

  test("an already-flashed medium's token still enrols a brand-new box", () => {
    const enrollment = new Enrollment("old-flat-token");
    const decision = enrollment.authenticate(hello({ bootstrapToken: "old-flat-token" }));
    expect(decision.kind).toBe("enroll-pending");
    expect(decision.credential).toBeString();
    expect(decision.tokenId).toBe("legacy");
  });

  test("a machine enrolled before POL-104 (credential, no token) reconnects untouched", () => {
    const enrollment = new Enrollment("old-flat-token");
    const credential = "c".repeat(64);
    const decision = enrollment.authenticate(hello({ credential }), {
      status: "approved",
      credentialHash: hashCredential(credential),
    });
    expect(decision.kind).toBe("admit");
    expect(decision.credential).toBeUndefined(); // no re-issue on the normal reconnect path
  });
});

describe("negatives — a token that must not enrol", () => {
  test("an unknown token is rejected", () => {
    const enrollment = new Enrollment("real");
    const decision = enrollment.authenticate(hello({ bootstrapToken: "not-the-token" }));
    expect(decision.kind).toBe("reject");
    expect(decision.reason).toBe("invalid or missing enrollment credential");
  });

  test("a REVOKED token cannot enrol a new box — and says so", async () => {
    const enrollment = new Enrollment();
    const token = await enrollment.createToken({ name: "Floor 3" });
    await enrollment.revokeToken(token.id);

    const decision = enrollment.authenticate(hello({ bootstrapToken: token.secret }));
    expect(decision.kind).toBe("reject");
    expect(decision.reason).toBe("enrolment token has been revoked");
    // Named, not anonymous: an operator must be able to see WHICH stick was refused.
    expect(decision.tokenId).toBe(token.id);
  });

  test("an EXPIRED token cannot enrol a new box", async () => {
    const c = clock();
    const enrollment = new Enrollment(undefined, { now: c.now });
    const token = await enrollment.createToken({ name: "Two-day batch", expiresInDays: 2 });

    expect(enrollment.authenticate(hello({ bootstrapToken: token.secret })).kind).toBe("enroll-pending");
    c.advanceHours(49);
    const decision = enrollment.authenticate(hello({ bootstrapToken: token.secret }));
    expect(decision.kind).toBe("reject");
    expect(decision.reason).toBe("enrolment token has expired");
  });

  test("a USED-UP batch token cannot enrol another box", async () => {
    const enrollment = new Enrollment();
    const token = await enrollment.createToken({ name: "Two boxes only", maxEnrollments: 2 });

    for (const machineId of ["box-1", "box-2"]) {
      const decision = enrollment.authenticate(hello({ machineId, bootstrapToken: token.secret }));
      expect(decision.kind).toBe("enroll-pending");
      await enrollment.recordUse(decision.tokenId!);
    }

    const third = enrollment.authenticate(hello({ machineId: "box-3", bootstrapToken: token.secret }));
    expect(third.kind).toBe("reject");
    expect(third.reason).toBe("enrolment token has reached its maximum number of enrolments");
    expect(enrollment.get(token.id)?.uses).toBe(2);
  });

  test("a rejected machine stays rejected, whatever token it presents", async () => {
    const enrollment = new Enrollment();
    const token = await enrollment.createToken({ name: "Live" });
    const decision = enrollment.authenticate(hello({ bootstrapToken: token.secret }), {
      status: "rejected",
    });
    expect(decision.kind).toBe("reject");
    expect(decision.reason).toBe("machine has been rejected");
  });
});

describe("revocation never darkens a working wall", () => {
  test("a machine enrolled on a REVOKED token still connects on its own credential", async () => {
    const enrollment = new Enrollment();
    const token = await enrollment.createToken({ name: "Compromised stick" });

    // The box enrols on the (then-good) token and is approved.
    const first = enrollment.authenticate(hello({ bootstrapToken: token.secret }));
    expect(first.kind).toBe("enroll-pending");
    const credentialHash = hashCredential(first.credential!);

    // The stick walks out of the building. The operator cuts it.
    await enrollment.revokeToken(token.id);

    // The wall is still a wall.
    const reconnect = enrollment.authenticate(hello({ credential: first.credential! }), {
      status: "approved",
      credentialHash,
    });
    expect(reconnect.kind).toBe("admit");
  });

  test("but that machine may NOT re-key with the revoked token (a lost credential is a new decision)", async () => {
    const enrollment = new Enrollment();
    const token = await enrollment.createToken({ name: "Compromised stick" });
    const first = enrollment.authenticate(hello({ bootstrapToken: token.secret }));
    await enrollment.revokeToken(token.id);

    const reKey = enrollment.authenticate(hello({ bootstrapToken: token.secret }), {
      status: "approved",
      credentialHash: hashCredential(first.credential!),
    });
    expect(reKey.kind).toBe("reject");
    expect(reKey.reason).toBe("enrolment token has been revoked");
  });

  test("an EXISTING machine may re-key on a token that is only USED UP (it already counted)", async () => {
    const enrollment = new Enrollment();
    const token = await enrollment.createToken({ name: "One box", maxEnrollments: 1 });
    const first = enrollment.authenticate(hello({ bootstrapToken: token.secret }));
    await enrollment.recordUse(first.tokenId!);

    // The box's credential file is gone (a re-image, a wiped disk). It falls back to the token — and
    // the cap must not lock it out of its OWN slot: the cap counts boxes onboarded, not re-keys.
    const reKey = enrollment.authenticate(hello({ bootstrapToken: token.secret }), {
      status: "approved",
      credentialHash: hashCredential("some-old-hash"),
    });
    expect(reKey.kind).toBe("admit");
    expect(reKey.credential).toBeString();
  });

  test("revoking the BAKE token hands the bake flag to a live one — new media never carry a dead secret", async () => {
    const enrollment = new Enrollment();
    const first = await enrollment.createToken({ name: "First", bake: true });
    const second = await enrollment.createToken({ name: "Second" });

    expect(enrollment.currentToken).toBe(first.secret);
    await enrollment.revokeToken(first.id);
    expect(enrollment.currentToken).toBe(second.secret);
  });
});

describe("rotation has a grace window", () => {
  test("the OLD secret keeps enrolling for the window; the NEW one is what media bake", async () => {
    const c = clock();
    const enrollment = new Enrollment(undefined, { now: c.now });
    const original = await enrollment.createToken({ name: "Site A" });

    const rotated = await enrollment.rotateToken(original.id, 24);
    expect(rotated).toBeDefined();
    // New media carry the successor…
    expect(enrollment.currentToken).toBe(rotated!.next.secret);
    // …but a box booting from a stick flashed with the OLD one still lands, mid-window.
    c.advanceHours(23);
    expect(enrollment.authenticate(hello({ bootstrapToken: original.secret })).kind).toBe("enroll-pending");
    expect(enrollment.authenticate(hello({ bootstrapToken: rotated!.next.secret })).kind).toBe("enroll-pending");

    // Past the window the old stick is dead — the whole point of rotating.
    c.advanceHours(2);
    const late = enrollment.authenticate(hello({ bootstrapToken: original.secret }));
    expect(late.kind).toBe("reject");
    expect(late.reason).toBe("enrolment token has expired");
  });

  test("graceHours: 0 is the emergency — the old secret dies immediately", async () => {
    const enrollment = new Enrollment();
    const original = await enrollment.createToken({ name: "Lost stick" });
    await enrollment.rotateToken(original.id, 0);

    const decision = enrollment.authenticate(hello({ bootstrapToken: original.secret }));
    expect(decision.kind).toBe("reject");
    expect(decision.reason).toBe("enrolment token has been revoked");
  });

  test("a rotation never EXTENDS a token past its own expiry", async () => {
    const c = clock();
    const enrollment = new Enrollment(undefined, { now: c.now });
    // Expires in 2 hours; a 24 h grace must not resurrect it for a day.
    const original = await enrollment.createToken({ name: "Short-lived" });
    const shortened = enrollment.list().find((t) => t.id === original.id)!;
    shortened.expiresAt = new Date(c.now() + 2 * 3_600_000).toISOString();
    enrollment.load([shortened]);

    await enrollment.rotateToken(original.id, 24);
    c.advanceHours(3);
    expect(enrollment.authenticate(hello({ bootstrapToken: original.secret })).kind).toBe("reject");
  });
});

describe("persistence + the boot depot", () => {
  test("every mutation is written through", async () => {
    const writes: EnrollmentToken[] = [];
    const enrollment = new Enrollment(undefined, {
      persist: async (token) => {
        writes.push(token);
      },
    });
    const token = await enrollment.createToken({ name: "Batch" });
    await enrollment.recordUse(token.id);
    await enrollment.revokeToken(token.id);
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes.at(-1)?.revokedAt).toBeString();
  });

  test("`knowsSecret` recognises a DEAD token — the boot-report gate must not go silent on a stick we just cut", async () => {
    const enrollment = new Enrollment();
    const token = await enrollment.createToken({ name: "Cut" });
    await enrollment.revokeToken(token.id);

    // The box booting from that stick cannot ENROL (asserted above) — but its boot report, which
    // carries no authority and mutates no registry state, is exactly the one we most want to read.
    expect(enrollment.knowsSecret(token.secret)).toBe(true);
    expect(enrollment.knowsSecret("something-else")).toBe(false);
    expect(enrollment.knowsSecret(undefined)).toBe(false);
  });
});
