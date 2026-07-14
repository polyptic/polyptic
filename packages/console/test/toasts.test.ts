/**
 * The toast rail (POL-93) — the console's one place for "what just happened, and why".
 *
 * The behaviours pinned here are the ones an operator would notice the moment they broke:
 *   - a toast auto-dismisses, but HOVER banks the remaining time (reaching for Undo must not race
 *     the fuse);
 *   - the same failure raised twice is ONE toast that has happened twice, not two;
 *   - the rail is capped — a flurry of failures cannot bury the newest one off-screen;
 *   - an action ("Undo") runs its callback and takes the toast with it, and a FAILING inverse says
 *     so rather than vanishing quietly.
 *
 * No DOM, no server: the store is pure state + timers.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { useToastStore } from "../src/stores/toasts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("toast store (POL-93)", () => {
  test("severity helpers queue in order and carry the server's reason as the detail", () => {
    const toasts = useToastStore();
    toasts.success("Removed wall-1");
    toasts.error("Couldn't reboot wall-2", { detail: "wall-2 is offline — nothing to reboot" });

    expect(toasts.toasts.map((t) => [t.severity, t.message])).toEqual([
      ["success", "Removed wall-1"],
      ["error", "Couldn't reboot wall-2"],
    ]);
    expect(toasts.toasts[1]!.detail).toBe("wall-2 is offline — nothing to reboot");
  });

  test("auto-dismiss removes the toast once its fuse burns down", async () => {
    const toasts = useToastStore();
    toasts.push({ message: "transient", ttlMs: 30 });
    expect(toasts.toasts).toHaveLength(1);
    await tick(60);
    expect(toasts.toasts).toHaveLength(0);
  });

  test("a sticky toast (ttlMs 0) waits for the operator", async () => {
    const toasts = useToastStore();
    const id = toasts.push({ message: "sticky", ttlMs: 0 });
    await tick(40);
    expect(toasts.toasts).toHaveLength(1);
    toasts.dismiss(id);
    expect(toasts.toasts).toHaveLength(0);
  });

  test("hover pauses the fuse; leaving re-arms it with the banked remainder", async () => {
    const toasts = useToastStore();
    const id = toasts.push({ message: "read me", ttlMs: 40 });
    toasts.pause(id);
    await tick(80); // long past the original fuse — a paused toast does not burn down
    expect(toasts.toasts).toHaveLength(1);

    toasts.resume(id);
    await tick(30);
    expect(toasts.toasts).toHaveLength(1); // resume never re-arms shorter than a beat
    await tick(700);
    expect(toasts.toasts).toHaveLength(0);
  });

  test("dedupe: the same failure twice is one toast, counted — with its fuse restarted", async () => {
    const toasts = useToastStore();
    toasts.error("Couldn't move Nessie", { detail: "not placed", ttlMs: 60 });
    await tick(40);
    toasts.error("Couldn't move Nessie", { detail: "not placed", ttlMs: 60 });

    expect(toasts.toasts).toHaveLength(1);
    expect(toasts.toasts[0]!.repeat).toBe(2);

    // The second raise restarted the fuse — the toast is still up past the first one's expiry.
    await tick(40);
    expect(toasts.toasts).toHaveLength(1);
    await tick(50);
    expect(toasts.toasts).toHaveLength(0);
  });

  test("dedupe is per severity+message+detail — a different reason is a different toast", () => {
    const toasts = useToastStore();
    toasts.error("Couldn't delete \"Ops board\"", { detail: "in use" });
    toasts.error("Couldn't delete \"Ops board\"", { detail: "the server refused it (HTTP 500)" });
    expect(toasts.toasts).toHaveLength(2);
  });

  test("the rail is capped — the newest survives, the oldest gives up its slot", () => {
    const toasts = useToastStore();
    for (let i = 1; i <= 6; i += 1) toasts.info(`event ${i}`);
    expect(toasts.toasts).toHaveLength(4);
    expect(toasts.toasts.map((t) => t.message)).toEqual([
      "event 3",
      "event 4",
      "event 5",
      "event 6",
    ]);
  });

  test("Undo runs the inverse and takes the toast with it", async () => {
    const toasts = useToastStore();
    const calls: string[] = [];
    const id = toasts.success("Renamed \"Nessie\" to \"Lobby\"", {
      action: { label: "Undo", run: () => void calls.push("rename-back") },
    });
    expect(toasts.toasts[0]!.action?.label).toBe("Undo");

    await toasts.runAction(id);
    expect(calls).toEqual(["rename-back"]);
    expect(toasts.toasts).toHaveLength(0);
  });

  test("an inverse that THROWS says so — an undo must not fail silently either", async () => {
    const toasts = useToastStore();
    const id = toasts.success("Deleted \"Ops board\"", {
      action: {
        label: "Undo",
        run: () => {
          throw new Error("the control plane could not be reached");
        },
      },
    });
    await toasts.runAction(id);

    expect(toasts.toasts).toHaveLength(1);
    expect(toasts.toasts[0]!.severity).toBe("error");
    expect(toasts.toasts[0]!.message).toBe("Undo failed");
    expect(toasts.toasts[0]!.detail).toBe("the control plane could not be reached");
  });

  test("clear() empties the rail (nothing from a signed-out session lingers)", () => {
    const toasts = useToastStore();
    toasts.info("one");
    toasts.error("two");
    toasts.clear();
    expect(toasts.toasts).toHaveLength(0);
  });
});
