/**
 * useScreenInspect (POL-85) — the shared Inspect/DevTools state machine behind BOTH the Machines
 * view's per-screen button and the Wall Inspector's ⋯ overflow. The seam worth pinning is the
 * ack-driven pending logic extracted from ScreenRow, whose settle rules are all edge cases that
 * shipped for a reason (see the composable's header comment):
 *   - chrome arms open the tab IMMEDIATELY (inside the user gesture), then settle on the ack;
 *   - a NEW refusal settles + notifies (a refusal leaves `inspecting` unchanged — the flag alone
 *     would spin forever on exactly the case the operator most needs to hear about);
 *   - the server clearing a STALE error must not settle a fresh request's pending state;
 *   - an unrelated broadcast (fresh objects, same values) settles nothing;
 *   - switching the target screen (the Inspector follows the canvas selection) resets silently;
 *   - surf asks first and never opens a tab; offline no-ops; API errors and timeouts notify.
 *
 * Transport is injected, so this runs without Pinia, a server, or a DOM.
 */
import { describe, expect, test } from "bun:test";
import { effectScope, nextTick, ref, type Ref } from "vue";
import type { ScreenView } from "@polyptic/protocol";

import { useScreenInspect, type InspectTarget } from "../src/components/useInspect";

function screen(over: Partial<ScreenView> = {}): ScreenView {
  return {
    id: "scr-1",
    friendlyName: "Nessie",
    machineId: "m-1",
    connector: "HDMI-A-1",
    online: true,
    revision: 0,
    surfaceCount: 1,
    ...over,
  };
}

interface Harness {
  target: Ref<InspectTarget | undefined>;
  api: ReturnType<typeof useScreenInspect>;
  notices: string[];
  opened: string[];
  inspectCalls: Array<{ id: string; on: boolean }>;
  /** Push a fresh broadcast for the current screen (new objects, like admin/state). */
  broadcast: (over?: Partial<ScreenView>, machineOnline?: boolean) => Promise<void>;
  stop: () => void;
}

function harness(opts?: {
  browser?: "chrome" | "surf";
  inspectResult?: string | null;
  confirm?: boolean;
  timeoutMs?: number;
}): Harness {
  const notices: string[] = [];
  const opened: string[] = [];
  const inspectCalls: Array<{ id: string; on: boolean }> = [];
  const target = ref<InspectTarget | undefined>({
    screen: screen(),
    machineLabel: "wall-1",
    machineOnline: true,
    browser: opts?.browser ?? "chrome",
  });

  const scope = effectScope();
  const api = scope.run(() =>
    useScreenInspect(target, {
      inspect: async (id, on) => {
        inspectCalls.push({ id, on });
        return opts?.inspectResult ?? null;
      },
      devtoolsUrl: (id) => `http://cp/api/v1/screens/${id}/devtools`,
      notify: (m) => notices.push(m),
      openTab: (url) => opened.push(url),
      confirm: () => opts?.confirm ?? true,
      timeoutMs: opts?.timeoutMs ?? 20_000,
    }),
  )!;

  return {
    target,
    api,
    notices,
    opened,
    inspectCalls,
    broadcast: async (over = {}, machineOnline = true) => {
      const prev = target.value!;
      target.value = {
        ...prev,
        machineOnline,
        screen: screen({ ...prev.screen, ...over }),
      };
      await nextTick();
    },
    stop: () => scope.stop(),
  };
}

describe("useScreenInspect (POL-85 shared Inspect/DevTools toggle)", () => {
  test("chrome arm: opens the DevTools tab inside the gesture, pends, settles on the ack", async () => {
    const h = harness();
    await h.api.toggle();
    // The tab opens immediately (user gesture) and the arm POST went out.
    expect(h.opened).toEqual(["http://cp/api/v1/screens/scr-1/devtools"]);
    expect(h.inspectCalls).toEqual([{ id: "scr-1", on: true }]);
    expect(h.api.pending.value).toBe(true);

    // The agent's ack lands on the next admin/state → pending settles, no noise.
    await h.broadcast({ inspecting: true });
    expect(h.api.pending.value).toBe(false);
    expect(h.api.inspecting.value).toBe(true);
    expect(h.notices).toEqual([]);
    h.stop();
  });

  test("a NEW refusal settles pending and notifies (inspecting stays false)", async () => {
    const h = harness();
    await h.api.toggle();
    expect(h.api.pending.value).toBe(true);

    await h.broadcast({ inspectError: "no browser owns that output" });
    expect(h.api.pending.value).toBe(false);
    expect(h.api.inspecting.value).toBe(false);
    expect(h.notices).toEqual(["Inspector: no browser owns that output"]);
    h.stop();
  });

  test("the server clearing a STALE error does not settle a fresh request", async () => {
    const h = harness();
    // A previous attempt left a refusal on the screen.
    await h.broadcast({ inspectError: "stale refusal" });
    h.notices.length = 0;

    await h.api.toggle();
    expect(h.api.pending.value).toBe(true);
    // The server clears the stale error when it delivers the new request — NOT an answer.
    await h.broadcast({});
    expect(h.api.pending.value).toBe(true);
    // The real ack still settles it.
    await h.broadcast({ inspecting: true });
    expect(h.api.pending.value).toBe(false);
    h.stop();
  });

  test("an unrelated broadcast (fresh objects, same values) settles nothing", async () => {
    const h = harness();
    await h.api.toggle();
    expect(h.api.pending.value).toBe(true);
    await h.broadcast({}); // e.g. another screen renamed → full snapshot re-emitted
    expect(h.api.pending.value).toBe(true);
    expect(h.notices).toEqual([]);
    h.stop();
  });

  test("switching to a different screen resets pending silently", async () => {
    const h = harness();
    await h.api.toggle();
    expect(h.api.pending.value).toBe(true);

    h.target.value = {
      screen: screen({ id: "scr-2", friendlyName: "Bertha" }),
      machineLabel: "wall-2",
      machineOnline: true,
      browser: "chrome",
    };
    await nextTick();
    expect(h.api.pending.value).toBe(false);
    expect(h.notices).toEqual([]); // no phantom refusal for the old screen
    h.stop();
  });

  test("surf: asks first, never opens a tab; declining sends nothing", async () => {
    const declined = harness({ browser: "surf", confirm: false });
    await declined.api.toggle();
    expect(declined.opened).toEqual([]);
    expect(declined.inspectCalls).toEqual([]);
    expect(declined.api.pending.value).toBe(false);
    declined.stop();

    const accepted = harness({ browser: "surf", confirm: true });
    await accepted.api.toggle();
    expect(accepted.opened).toEqual([]); // on-panel inspector — nothing to open here
    expect(accepted.inspectCalls).toEqual([{ id: "scr-1", on: true }]);
    expect(accepted.api.pending.value).toBe(true);
    accepted.stop();
  });

  test("an offline machine no-ops (the affordance is disabled, and toggle guards anyway)", async () => {
    const h = harness();
    await h.broadcast({}, false);
    expect(h.api.disabled.value).toBe(true);
    await h.api.toggle();
    expect(h.opened).toEqual([]);
    expect(h.inspectCalls).toEqual([]);
    h.stop();
  });

  test("a transport error settles pending and notifies with the server's sentence", async () => {
    const h = harness({ inspectResult: "wall-1 is offline — nothing to show an inspector on." });
    await h.api.toggle();
    expect(h.api.pending.value).toBe(false);
    expect(h.notices).toEqual(["wall-1 is offline — nothing to show an inspector on."]);
    h.stop();
  });

  test("a box that never answers times out with a check-the-screen notice", async () => {
    const h = harness({ timeoutMs: 30 });
    await h.api.toggle();
    expect(h.api.pending.value).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(h.api.pending.value).toBe(false);
    expect(h.notices).toEqual(["Nessie did not confirm the inspector — check the screen."]);
    h.stop();
  });

  test("disarm (chrome, already inspecting) posts on:false and opens no tab", async () => {
    const h = harness();
    await h.broadcast({ inspecting: true });
    await h.api.toggle();
    expect(h.opened).toEqual([]);
    expect(h.inspectCalls).toEqual([{ id: "scr-1", on: false }]);
    expect(h.api.pending.value).toBe(true);
    await h.broadcast({ inspecting: false });
    expect(h.api.pending.value).toBe(false);
    h.stop();
  });
});
