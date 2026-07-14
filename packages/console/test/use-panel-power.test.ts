/**
 * useScreenPower (POL-101) — the shared Wake/Sleep state machine behind BOTH the Machines view's
 * per-screen button and the Wall Inspector.
 *
 * The seam worth pinning is the same one as useScreenInspect: `asleep` is written ONLY by the box's
 * ack (via admin/state), never optimistically, because the console must never show a wall as dark
 * when it might still be lit — an operator at their desk cannot check.
 *
 * Transport is injected, so this runs without Pinia, a server, or a DOM.
 */
import { describe, expect, test } from "bun:test";
import { effectScope, nextTick, ref, type Ref } from "vue";
import type { ScreenView } from "@polyptic/protocol";

import { useScreenPower, powerMethodLabel, type PowerTarget } from "../src/components/usePanelPower";

function screen(over: Partial<ScreenView> = {}): ScreenView {
  return {
    id: "scr-1",
    friendlyName: "Atrium North",
    machineId: "m-1",
    connector: "DP-1",
    online: true,
    revision: 0,
    surfaceCount: 1,
    ...over,
  };
}

interface Harness {
  target: Ref<PowerTarget | undefined>;
  api: ReturnType<typeof useScreenPower>;
  notices: string[];
  calls: Array<{ id: string; on: boolean }>;
  /** Simulate the next admin/state broadcast: fresh objects, exactly as Pinia hands them over. */
  broadcast: (over: Partial<ScreenView>) => Promise<void>;
}

function harness(over: Partial<PowerTarget> = {}, error?: string): Harness {
  const notices: string[] = [];
  const calls: Array<{ id: string; on: boolean }> = [];
  const target = ref<PowerTarget | undefined>({
    screen: screen(),
    machineLabel: "wall-1",
    machineOnline: true,
    power: { dpms: true, cec: false },
    ...over,
  });
  let api!: ReturnType<typeof useScreenPower>;
  effectScope().run(() => {
    api = useScreenPower(target, {
      setPower: async (id, on) => {
        calls.push({ id, on });
        return error ?? null;
      },
      notify: (m) => notices.push(m),
    });
  });
  return {
    target,
    api,
    notices,
    calls,
    async broadcast(patch: Partial<ScreenView>) {
      const current = target.value;
      if (!current) return;
      target.value = { ...current, screen: { ...current.screen, ...patch } };
      await nextTick();
    },
  };
}

describe("POL-101 useScreenPower", () => {
  test("sleeping stays PENDING until the box acks — the click is a request, not the truth", async () => {
    const h = harness();
    expect(h.api.asleep.value).toBe(false);

    await h.api.toggle();
    expect(h.calls).toEqual([{ id: "scr-1", on: false }]); // on:false = sleep
    // The button says "Sleeping…", not "Asleep": nothing has confirmed the glass went dark.
    expect(h.api.pending.value).toBe(true);
    expect(h.api.asleep.value).toBe(false);

    await h.broadcast({ asleep: true, powerMethods: ["dpms", "cec"] });
    expect(h.api.pending.value).toBe(false);
    expect(h.api.asleep.value).toBe(true);
  });

  test("waking an asleep screen asks for on:true", async () => {
    const h = harness({ screen: screen({ asleep: true }) });
    await h.api.toggle();
    expect(h.calls).toEqual([{ id: "scr-1", on: true }]);
  });

  test("a NEW refusal settles pending and notifies — a refusal leaves `asleep` UNCHANGED", async () => {
    const h = harness();
    await h.api.toggle();
    expect(h.api.pending.value).toBe(true);

    // The box refused (no compositor, connector unknown…). `asleep` stays false — i.e. the flag alone
    // shows nothing happened, which is why the error field exists and why the button must settle here.
    await h.broadcast({ powerError: "swaymsg: no such output DP-1" });
    expect(h.api.pending.value).toBe(false);
    expect(h.api.asleep.value).toBe(false);
    expect(h.notices[0]).toContain("no such output");
  });

  test("an unrelated broadcast settles nothing (fresh objects, same values)", async () => {
    const h = harness();
    await h.api.toggle();
    await h.broadcast({ revision: 42 });
    expect(h.api.pending.value).toBe(true); // still waiting for the box
  });

  test("switching to another screen resets pending silently", async () => {
    const h = harness();
    await h.api.toggle();
    expect(h.api.pending.value).toBe(true);

    h.target.value = {
      screen: screen({ id: "scr-2", friendlyName: "Atrium South" }),
      machineLabel: "wall-1",
      machineOnline: true,
      power: { dpms: true, cec: false },
    };
    await nextTick();
    expect(h.api.pending.value).toBe(false);
    expect(h.notices).toEqual([]); // the old screen's ack is not this screen's business
  });

  test("an offline machine offers nothing — panel power rides the agent socket", async () => {
    const h = harness({ machineOnline: false });
    expect(h.api.disabled.value).toBe(true);
    await h.api.toggle();
    expect(h.calls).toEqual([]);
    expect(h.api.title.value).toContain("offline");
  });

  test("a box that cannot drive DPMS (dev backend / pre-POL-101 agent) is UNSUPPORTED, not broken", async () => {
    const noPower = harness({ power: undefined });
    expect(noPower.api.supported.value).toBe(false);
    expect(noPower.api.disabled.value).toBe(true);
    await noPower.api.toggle();
    expect(noPower.calls).toEqual([]);

    const devOpen = harness({ power: { dpms: false, cec: false } });
    expect(devOpen.api.supported.value).toBe(false);
  });

  test("an API error settles pending and surfaces the server's own sentence", async () => {
    const h = harness({}, "wall-1 is offline — nothing to sleep");
    await h.api.toggle();
    expect(h.api.pending.value).toBe(false);
    expect(h.notices).toEqual(["wall-1 is offline — nothing to sleep"]);
  });

  test("the tooltip is HONEST about which rung this box has", () => {
    const withCec = harness({ power: { dpms: true, cec: true } });
    expect(withCec.api.title.value).toContain("HDMI-CEC");

    const dpmsOnly = harness({ power: { dpms: true, cec: false } });
    // The operator must know the panel itself may stay lit — otherwise they file a bug about it.
    expect(dpmsOnly.api.title.value).toContain("may stay lit");
  });
});

describe("POL-101 powerMethodLabel", () => {
  test("names what actually happened to the panel", () => {
    expect(powerMethodLabel(["dpms", "cec"])).toContain("powered down over HDMI-CEC");
    expect(powerMethodLabel(["dpms"])).toContain("may stay lit");
    expect(powerMethodLabel(undefined)).toContain("may stay lit");
  });
});
