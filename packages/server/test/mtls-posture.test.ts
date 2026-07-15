/**
 * POL-134 — agent mTLS is ON BY DEFAULT, and the require posture graduates itself.
 *
 * Two pure seams, no sockets (runs on every runtime):
 *   - `resolveAgentMtlsEnv`: the zero-config default is ON at :8443; `AGENT_MTLS=off` /
 *     `AGENT_MTLS_PORT=0` are the escape hatches; `AGENT_MTLS_REQUIRE` set (either way) PINS the
 *     posture; `explicit` marks operator intent (failures are then fatal instead of degrading).
 *   - `MtlsPosture`: starts migrating, promotes to required exactly once — when at least one
 *     machine exists and EVERY known machine has been SEEN on the mTLS listener — announces it in
 *     the activity feed, persists it (survives restarts), and never regresses.
 */
import { describe, expect, test } from "bun:test";

import { ActivityLog } from "../src/activity";
import { MtlsPosture, mtlsStartupFailureIsFatal, resolveAgentMtlsEnv, DEFAULT_AGENT_MTLS_PORT } from "../src/mtls";
import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";

// ── resolveAgentMtlsEnv ──────────────────────────────────────────────────────

describe("resolveAgentMtlsEnv — default ON, explicit escape hatches", () => {
  test("ZERO configuration → enabled on the default port, not explicit, no require pin", () => {
    const cfg = resolveAgentMtlsEnv({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.port).toBe(DEFAULT_AGENT_MTLS_PORT);
    expect(cfg.explicit).toBe(false);
    expect(cfg.requirePin).toBeUndefined();
  });

  test("AGENT_MTLS=off disables (the documented escape hatch), and is explicit", () => {
    for (const v of ["off", "OFF", "0", "false", "no"]) {
      const cfg = resolveAgentMtlsEnv({ AGENT_MTLS: v });
      expect(cfg.enabled).toBe(false);
      expect(cfg.explicit).toBe(true);
    }
  });

  test("AGENT_MTLS=on is explicit-on (failures become fatal) at the default port", () => {
    const cfg = resolveAgentMtlsEnv({ AGENT_MTLS: "on" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.port).toBe(DEFAULT_AGENT_MTLS_PORT);
    expect(cfg.explicit).toBe(true);
  });

  test("AGENT_MTLS_PORT picks the port and marks the config explicit (pre-POL-134 spelling)", () => {
    const cfg = resolveAgentMtlsEnv({ AGENT_MTLS_PORT: "9443" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.port).toBe(9443);
    expect(cfg.explicit).toBe(true);
  });

  test("AGENT_MTLS_PORT=0 still means off (back-compat with the POL-25 default)", () => {
    const cfg = resolveAgentMtlsEnv({ AGENT_MTLS_PORT: "0" });
    expect(cfg.enabled).toBe(false);
    expect(cfg.explicit).toBe(true);
  });

  test("AGENT_MTLS_REQUIRE pins the posture BOTH ways; unset leaves it self-managing", () => {
    expect(resolveAgentMtlsEnv({ AGENT_MTLS_REQUIRE: "1" }).requirePin).toBe(true);
    expect(resolveAgentMtlsEnv({ AGENT_MTLS_REQUIRE: "true" }).requirePin).toBe(true);
    expect(resolveAgentMtlsEnv({ AGENT_MTLS_REQUIRE: "0" }).requirePin).toBe(false);
    expect(resolveAgentMtlsEnv({ AGENT_MTLS_REQUIRE: "false" }).requirePin).toBe(false);
    expect(resolveAgentMtlsEnv({}).requirePin).toBeUndefined();
  });

  test("an unparseable AGENT_MTLS_PORT is FATAL, not silently off — explicit config with a typo must not bypass the gate", () => {
    for (const v of ["abc", "-1", "1.5", "99999", "8443x"]) {
      expect(() => resolveAgentMtlsEnv({ AGENT_MTLS_PORT: v })).toThrow(/AGENT_MTLS_PORT is not a valid port/);
    }
    // 0 stays the legitimate pre-POL-134 spelling of off.
    expect(resolveAgentMtlsEnv({ AGENT_MTLS_PORT: "0" }).enabled).toBe(false);
  });

  test("publicUrl and SANs pass through", () => {
    const cfg = resolveAgentMtlsEnv({
      AGENT_MTLS_PUBLIC_URL: "wss://walls.example:8443",
      AGENT_MTLS_SANS: "walls.example, 10.0.0.5",
    });
    expect(cfg.publicUrl).toBe("wss://walls.example:8443");
    expect(cfg.sans).toEqual(["walls.example", "10.0.0.5"]);
  });
});

// ── mtlsStartupFailureIsFatal (finding: required must never silently degrade) ─

describe("mtlsStartupFailureIsFatal — a REQUIRED deployment never degrades to plaintext sessions", () => {
  const zeroConfig = resolveAgentMtlsEnv({});

  test("explicit config → always fatal", () => {
    expect(mtlsStartupFailureIsFatal(resolveAgentMtlsEnv({ AGENT_MTLS: "on" }), undefined)).toBe(true);
    expect(mtlsStartupFailureIsFatal(resolveAgentMtlsEnv({ AGENT_MTLS_PORT: "9443" }), undefined)).toBe(true);
  });

  test("zero-config, no posture row → degrade allowed (the dev-laptop case)", () => {
    expect(mtlsStartupFailureIsFatal(zeroConfig, undefined)).toBe(false);
    expect(mtlsStartupFailureIsFatal(zeroConfig, { required: false })).toBe(false);
  });

  test("zero-config but the PERSISTED posture says required → fatal (the graduated fleet)", () => {
    expect(mtlsStartupFailureIsFatal(zeroConfig, { required: true })).toBe(true);
  });

  test("AGENT_MTLS_REQUIRE=1 → fatal even with no row; =0 is the explicit consent to degrade, and overrides the row", () => {
    expect(mtlsStartupFailureIsFatal(resolveAgentMtlsEnv({ AGENT_MTLS_REQUIRE: "1" }), undefined)).toBe(true);
    expect(mtlsStartupFailureIsFatal(resolveAgentMtlsEnv({ AGENT_MTLS_REQUIRE: "0" }), { required: true })).toBe(false);
  });
});

// ── MtlsPosture ──────────────────────────────────────────────────────────────

async function planeWith(machines: { id: string; seen: boolean }[]): Promise<{
  store: MemoryStore;
  control: ControlPlane;
  activity: ActivityLog;
}> {
  const store = new MemoryStore();
  const activity = new ActivityLog();
  const control = new ControlPlane(store, activity);
  await control.init();
  for (const m of machines) {
    await control.registerMachine(
      { machineId: m.id, agentVersion: "t", outputs: [{ connector: "HDMI-1", width: 1, height: 1 }] },
      undefined,
    );
    if (m.seen) await control.noteMachineMtlsSeen(m.id);
  }
  return { store, control, activity };
}

describe("MtlsPosture — automatic, announced, one-way graduation", () => {
  test("an EMPTY fleet never promotes (vacuous truth must not flip a brand-new deployment)", async () => {
    const { store, control, activity } = await planeWith([]);
    const posture = await MtlsPosture.load(store, undefined);
    await posture.evaluate(control, activity);
    expect(posture.required).toBe(false);
  });

  test("a fleet with ONE certless machine does not promote; all-seen promotes, once, with a feed line", async () => {
    const { store, control, activity } = await planeWith([
      { id: "wall1", seen: true },
      { id: "wall2", seen: false },
    ]);
    const posture = await MtlsPosture.load(store, undefined);
    await posture.evaluate(control, activity);
    expect(posture.required).toBe(false);

    await control.noteMachineMtlsSeen("wall2");
    await posture.evaluate(control, activity);
    expect(posture.required).toBe(true);
    expect(posture.requiredSince).toBeDefined();

    const feedLines = activity.recent().filter((e) => e.text.includes("mTLS is now required"));
    expect(feedLines.length).toBe(1);

    // Idempotent: re-evaluating never re-announces.
    await posture.evaluate(control, activity);
    expect(activity.recent().filter((e) => e.text.includes("mTLS is now required")).length).toBe(1);
  });

  test("a promotion PERSISTS — a restarted server loads required=true and never regresses", async () => {
    const { store, control, activity } = await planeWith([{ id: "wall1", seen: true }]);
    const posture = await MtlsPosture.load(store, undefined);
    await posture.evaluate(control, activity);
    expect(posture.required).toBe(true);

    // "Restart": a fresh posture over the same store — even with a NEW certless machine now known.
    await control.registerMachine(
      { machineId: "wall-new", agentVersion: "t", outputs: [] },
      undefined,
    );
    const reloaded = await MtlsPosture.load(store, undefined);
    expect(reloaded.required).toBe(true);
  });

  test("AGENT_MTLS_REQUIRE=0 pins the posture off — a fully-migrated fleet still never promotes", async () => {
    const { store, control, activity } = await planeWith([{ id: "wall1", seen: true }]);
    const posture = await MtlsPosture.load(store, false);
    await posture.evaluate(control, activity);
    expect(posture.required).toBe(false);
    expect(posture.pinned).toBe(true);
  });

  test("AGENT_MTLS_REQUIRE=1 pins the posture on immediately, even for an empty fleet", async () => {
    const { store, control: _c, activity: _a } = await planeWith([]);
    const posture = await MtlsPosture.load(store, true);
    expect(posture.required).toBe(true);
    expect(posture.pinned).toBe(true);
  });

  test("a pin=true PERSISTS the promotion — unpinning later must not regress a required fleet to migrating", async () => {
    const { store } = await planeWith([{ id: "wall1", seen: false }]);
    const pinned = await MtlsPosture.load(store, true);
    expect(pinned.required).toBe(true);
    // The row was written: a later boot WITHOUT the pin loads required=true (one-way, as ever) —
    // even though wall1 was never individually SEEN on the listener.
    expect((await store.getAgentMtlsPosture())?.required).toBe(true);
    const unpinned = await MtlsPosture.load(store, undefined);
    expect(unpinned.required).toBe(true);
  });

  test("a pin=false suppresses requirement for the runtime but never ERASES a recorded graduation", async () => {
    const { store } = await planeWith([]);
    await store.setAgentMtlsPosture({ required: true, promotedAt: new Date().toISOString() });
    const pinnedOff = await MtlsPosture.load(store, false);
    expect(pinnedOff.required).toBe(false);
    expect((await store.getAgentMtlsPosture())?.required).toBe(true);
  });
});
