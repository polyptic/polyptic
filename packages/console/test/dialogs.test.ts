/**
 * The in-app confirm/prompt (POL-93) — the promise seam that replaced window.confirm/prompt.
 *
 * The rules worth holding: a request resolves EXACTLY once, with the operator's answer; a cancel is
 * a decline (false / null), never a hang; and a second request opening over the first settles the
 * first as declined — an unanswered dialog must not leave a promise dangling for the page's life.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { useDialogStore } from "../src/stores/dialogs";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("dialog store (POL-93)", () => {
  test("confirm: resolves true when accepted, and closes", async () => {
    const dialogs = useDialogStore();
    const answer = dialogs.confirm({ title: "Reboot wall-1?", message: "It goes dark." });
    expect(dialogs.request?.kind).toBe("confirm");
    dialogs.accept();
    expect(await answer).toBe(true);
    expect(dialogs.request).toBeNull();
  });

  test("confirm: cancelling resolves false — the destructive path never runs", async () => {
    const dialogs = useDialogStore();
    const answer = dialogs.confirm({
      title: "Remove wall-1?",
      message: "Permanent.",
      danger: true,
    });
    expect(dialogs.request).not.toBeNull();
    dialogs.cancel();
    expect(await answer).toBe(false);
  });

  test("confirm: labels and the danger flag reach the host", () => {
    const dialogs = useDialogStore();
    void dialogs.confirm({
      title: "Remove wall-1?",
      message: "Permanent.",
      confirmLabel: "Remove machine",
      danger: true,
    });
    const req = dialogs.request;
    expect(req?.kind).toBe("confirm");
    if (req?.kind !== "confirm") throw new Error("expected a confirm request");
    expect(req.confirmLabel).toBe("Remove machine");
    expect(req.cancelLabel).toBe("Cancel"); // defaulted
    expect(req.danger).toBe(true);
  });

  test("prompt: resolves the typed text, pre-filled with the current value", async () => {
    const dialogs = useDialogStore();
    const answer = dialogs.promptText({ title: "Rename mural", value: "Reception" });
    const req = dialogs.request;
    if (req?.kind !== "prompt") throw new Error("expected a prompt request");
    expect(req.value).toBe("Reception"); // the host selects this, so typing replaces it
    dialogs.accept("Atrium");
    expect(await answer).toBe("Atrium");
  });

  test("prompt: cancelling resolves null (distinct from an EMPTY answer, which is a real answer)", async () => {
    const dialogs = useDialogStore();
    const cancelled = dialogs.promptText({ title: "Reject wall-1?" });
    dialogs.cancel();
    expect(await cancelled).toBeNull();

    // An empty string is what "reject with no reason given" looks like — it must not read as cancel.
    const empty = dialogs.promptText({ title: "Reject wall-1?" });
    dialogs.accept("");
    expect(await empty).toBe("");
  });

  test("a second request settles the first as declined rather than orphaning its promise", async () => {
    const dialogs = useDialogStore();
    const first = dialogs.confirm({ title: "First?", message: "…" });
    const second = dialogs.confirm({ title: "Second?", message: "…" });
    expect(dialogs.request?.title).toBe("Second?");
    expect(await first).toBe(false);

    dialogs.accept();
    expect(await second).toBe(true);
  });

  test("accept/cancel with nothing open is a no-op (a stray Esc cannot answer a dialog that is gone)", () => {
    const dialogs = useDialogStore();
    dialogs.accept();
    dialogs.cancel();
    expect(dialogs.request).toBeNull();
  });
});
