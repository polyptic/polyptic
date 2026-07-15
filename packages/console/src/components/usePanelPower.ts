/**
 * useScreenPower — the Wake/Sleep affordance for ONE screen (POL-101). Two consumers, one
 * implementation: the Machines view's per-screen row and the Wall Inspector.
 *
 * The state machine is deliberately the same shape as `useScreenInspect`, because the underlying
 * truth is the same: `asleep` comes ONLY from the box's `agent/power-ack` (via admin/state), never
 * optimistically. Until the box answers, `pending` is true and the button says so, rather than
 * claiming a wall went dark when it may still be lit. The settle rules:
 *   - `asleep` FLIPPING settles pending (the box answered);
 *   - a NEW refusal (`powerError`) settles pending AND notifies — a refusal leaves `asleep` UNCHANGED,
 *     so watching the flag alone would leave the button spinning for exactly the case the operator
 *     most needs to hear about;
 *   - the server CLEARING a stale error at the start of a fresh request must NOT settle the pending
 *     state that request just set;
 *   - an unrelated broadcast (fresh objects, same values) settles nothing;
 *   - the target switching to another screen resets pending silently.
 *
 * The vocabulary matters as much as the state. A sleeping screen is HEALTHY — it is doing what an
 * operator (or their schedule) asked. The console must never let it read as a fault, or operators
 * will be sent to inspect a wall that is working perfectly.
 */
import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import type { PanelPowerMethod, PowerCapabilities, ScreenView } from "@polyptic/protocol";

/** What the toggle acts on — a screen plus the bits of its machine that gate the affordance. */
export interface PowerTarget {
  screen: ScreenView;
  machineLabel: string;
  /** Is the screen's machine reachable? Panel power rides the agent socket, not the player's. */
  machineOnline: boolean;
  /** What the box can do about panel power (POL-101). Absent = a pre-POL-101 agent → no affordance. */
  power?: PowerCapabilities | undefined;
}

export interface PowerDeps {
  /** POST /screens/:id/power via the store; resolves to an operator-readable error, or null. */
  setPower: (screenId: string, on: boolean) => Promise<string | null>;
  /** Where refusals/timeouts surface (a toast on Machines, the inline notice in the Inspector). */
  notify: (message: string) => void;
  /** How long to wait for the box's ack before giving up. DPMS is instant; a CEC bus can be slow. */
  timeoutMs?: number;
}

/** How the panel was slept, in words an operator can act on. */
export function powerMethodLabel(methods: PanelPowerMethod[] | undefined): string {
  if (methods?.includes("cec")) return "Panel powered down over HDMI-CEC";
  return "Output is dark (DPMS) — without HDMI-CEC the panel itself may stay lit";
}

export function useScreenPower(target: Ref<PowerTarget | undefined>, deps: PowerDeps) {
  const timeoutMs = deps.timeoutMs ?? 20_000;

  const pending = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  onScopeDispose(clearTimer);

  const asleep = computed(() => target.value?.screen.asleep === true);
  const machineOnline = computed(() => target.value?.machineOnline === true);
  /** A box that reports no DPMS (dev-open, or a pre-POL-101 agent) has no panel to power. */
  const supported = computed(() => target.value?.power?.dpms === true);
  const hasCec = computed(() => target.value?.power?.cec === true);
  const disabled = computed(() => !machineOnline.value || !supported.value || pending.value);

  const title = computed(() => {
    const t = target.value;
    if (!t) return "";
    if (!t.machineOnline) return `${t.machineLabel} is offline — panel power rides its agent connection`;
    if (!supported.value) {
      return `${t.machineLabel} cannot drive panel power (no compositor DPMS — a development backend)`;
    }
    if (asleep.value) {
      return `Wake this panel. ${powerMethodLabel(t.screen.powerMethods)}. Content is still rendering underneath, so it comes back instantly.`;
    }
    return hasCec.value
      ? "Sleep this panel — the output goes dark AND the display is powered down over HDMI-CEC"
      : "Sleep this panel — the output goes dark (DPMS). This box has no HDMI-CEC, so the panel itself may stay lit.";
  });

  // The settle watch (rules in the header). `target` is a fresh object on every admin/state broadcast,
  // so this fires for unrelated changes too — only a screen switch, a flip, or a NEW refusal may touch
  // the pending state.
  watch(
    () =>
      [
        target.value?.screen.id ?? "",
        target.value?.screen.asleep === true,
        target.value?.screen.powerError ?? "",
      ] as const,
    ([id, nowAsleep, error], [prevId, wasAsleep, prevError]) => {
      if (id !== prevId) {
        pending.value = false;
        clearTimer();
        return;
      }
      const newRefusal = error !== "" && error !== prevError;
      if (!newRefusal && nowAsleep === wasAsleep) return; // an unrelated broadcast, or a stale error cleared
      pending.value = false;
      clearTimer();
      if (newRefusal) deps.notify(`Panel power: ${error}`);
    },
  );

  async function toggle(): Promise<void> {
    const t = target.value;
    if (!t || pending.value || !t.machineOnline || !supported.value) return;
    const on = asleep.value; // asleep → wake; awake → sleep

    pending.value = true;
    clearTimer();
    timer = setTimeout(() => {
      if (!pending.value) return;
      pending.value = false;
      deps.notify(`${t.screen.friendlyName} did not confirm ${on ? "waking" : "sleeping"} — check the screen.`);
    }, timeoutMs);

    const error = await deps.setPower(t.screen.id, on);
    if (error) {
      pending.value = false;
      clearTimer();
      deps.notify(error);
    }
  }

  return { asleep, pending, supported, hasCec, machineOnline, disabled, title, toggle };
}
