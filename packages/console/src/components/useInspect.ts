/**
 * useScreenInspect — the Inspect / DevTools toggle for ONE screen (POL-50 / POL-67), extracted from
 * ScreenRow so the Wall view's Inspector can quick-launch it too (POL-85). One implementation, two
 * consumers: the Machines view's per-screen button and the Inspector's ⋯ overflow menu.
 *
 * The semantics are browser-dependent (driven by the machine's reported kiosk browser):
 *   - chrome: arming opens Chrome DevTools in a NEW TAB on the operator's machine — the tab is
 *     opened INSIDE the user gesture (popup blockers) while the arm POST races it; the server's
 *     entry route waits briefly for the arm ack before proxying. Toggling off disarms the tunnel.
 *   - surf (or an older agent that reports no browser): the Web Inspector pops ON the panel itself
 *     (D63 — WebKitGTK has no remote inspector to tunnel), which relaunches the browser, so the
 *     operator is asked to confirm first.
 *
 * `inspecting` only ever comes from the agent's ack (via admin/state), never optimistically — until
 * the box answers, `pending` is true and the affordance shows a pending label rather than lying
 * about the wall. The settle rules are subtle enough to live in exactly one place:
 *   - the inspector FLIPPING settles pending (the box answered);
 *   - a NEW refusal (`inspectError`) settles pending AND notifies — a refusal leaves `inspecting`
 *     false, i.e. unchanged, so watching the flag alone would leave the button spinning for exactly
 *     the case the operator most needs to hear about;
 *   - the server CLEARING a stale error at the start of a fresh request must NOT settle the pending
 *     state that request just set;
 *   - an unrelated broadcast (fresh objects, same values) settles nothing;
 *   - the target switching to a DIFFERENT screen (the Inspector follows the canvas selection) resets
 *     pending silently — whatever was in flight belonged to the old screen, whose ack will land in
 *     admin/state regardless.
 *
 * Transport is injected (`inspect` = the store action, `devtoolsUrl` = the api helper) so the state
 * machine is testable without a Pinia instance or a browser; window.open/confirm default in.
 */
import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import type { KioskBrowser, ScreenView } from "@polyptic/protocol";

/** What the toggle acts on — a screen plus the bits of its machine that gate the affordance. */
export interface InspectTarget {
  screen: ScreenView;
  machineLabel: string;
  /** Is the screen's machine reachable? The inspector rides the agent socket, not the player's. */
  machineOnline: boolean;
  /** The machine's kiosk browser (POL-67): chrome = remote DevTools, else the on-panel inspector. */
  browser?: KioskBrowser | undefined;
}

export interface InspectDeps {
  /** POST /screens/:id/inspect via the store; resolves to an operator-readable error, or null. */
  inspect: (screenId: string, on: boolean) => Promise<string | null>;
  /** Absolute URL of the screen's remote-DevTools entry (api.devtoolsUrl). */
  devtoolsUrl: (screenId: string) => string;
  /** Where refusals/timeouts surface (a toast on Machines, the inline notice in the Inspector). */
  notify: (message: string) => void;
  /** Test seams; default window.open(url, "_blank", "noopener") / window.confirm. */
  openTab?: (url: string) => void;
  confirm?: (message: string) => boolean;
  /** How long to wait for the agent's ack before giving up (surf relaunches the browser, so its
   *  ack takes a few seconds; chrome acks near-instantly). */
  timeoutMs?: number;
}

export function useScreenInspect(target: Ref<InspectTarget | undefined>, deps: InspectDeps) {
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const openTab =
    deps.openTab ??
    ((url: string) => {
      window.open(url, "_blank", "noopener");
    });
  const confirmAsk = deps.confirm ?? ((message: string) => window.confirm(message));

  const pending = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  onScopeDispose(clearTimer);

  const isChrome = computed(() => target.value?.browser === "chrome");
  const inspecting = computed(() => target.value?.screen.inspecting === true);
  const machineOnline = computed(() => target.value?.machineOnline === true);
  const disabled = computed(() => !machineOnline.value || pending.value);

  const title = computed(() => {
    const t = target.value;
    if (!t) return "";
    if (!t.machineOnline) {
      return `${t.machineLabel} is offline, so the inspector is unavailable`;
    }
    if (isChrome.value) {
      return inspecting.value
        ? "Disarm remote DevTools for this screen (closes any open DevTools tab)"
        : "Open Chrome DevTools for this screen in a new tab";
    }
    return inspecting.value
      ? "Close the Web Inspector on this panel (reloads the page)"
      : "Open the browser's Web Inspector ON this panel (reloads the page)";
  });

  // The settle watch (rules in the header comment). `target` is a fresh object on every admin/state
  // broadcast, so this fires for unrelated changes too — only a screen switch, a flip, or a NEW
  // refusal may touch the pending state.
  watch(
    () =>
      [
        target.value?.screen.id ?? "",
        target.value?.screen.inspecting === true,
        target.value?.screen.inspectError ?? "",
      ] as const,
    ([id, nowOn, error], [prevId, wasOn, prevError]) => {
      if (id !== prevId) {
        // The selection moved to another screen — anything pending belonged to the old target.
        pending.value = false;
        clearTimer();
        return;
      }
      const newRefusal = error !== "" && error !== prevError;
      if (!newRefusal && nowOn === wasOn) return; // an unrelated broadcast, or a stale error cleared
      pending.value = false;
      clearTimer();
      if (newRefusal) deps.notify(`Inspector: ${error}`);
    },
  );

  async function toggle(): Promise<void> {
    const t = target.value;
    if (!t || pending.value || !t.machineOnline) return;
    const on = !inspecting.value;

    if (isChrome.value && on) {
      // POL-67 — remote DevTools: open the tab NOW, inside the user gesture (popup blockers), then
      // arm in parallel. The server's entry route waits briefly for the arm ack before proxying, so
      // the tab and the handshake race safely.
      openTab(deps.devtoolsUrl(t.screen.id));
    } else if (!isChrome.value && on) {
      const yes = confirmAsk(
        `Open the Web Inspector on "${t.screen.friendlyName}"?\n\n` +
          `It appears ON that panel, so anyone looking at the screen will see it.`,
      );
      if (!yes) return;
    }

    pending.value = true;
    // Give up waiting well after surf's relaunch window, rather than leaving the affordance pending
    // forever if the box never answers.
    clearTimer();
    timer = setTimeout(() => {
      if (!pending.value) return;
      pending.value = false;
      deps.notify(`${t.screen.friendlyName} did not confirm the inspector.`);
    }, timeoutMs);

    const error = await deps.inspect(t.screen.id, on);
    if (error) {
      pending.value = false;
      clearTimer();
      deps.notify(error);
    }
  }

  return { isChrome, inspecting, pending, machineOnline, disabled, title, toggle };
}
