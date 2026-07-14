/**
 * The console's one feedback rail (POL-93).
 *
 * Every mutation an operator makes goes out optimistically and is reconciled by the server's next
 * admin/state broadcast. Before this store, a REST refusal in between was logged to `console.error`
 * and nothing else: the UI showed a state the server never accepted, then silently reverted on the
 * next broadcast. A toast is how the console now says what it did, or what the server refused and
 * why — the server's own sentence (`{error: string}`), never "something went wrong".
 *
 * Shape of a toast:
 *   - `message` — what happened, in the operator's words ("Couldn't rename Nessie").
 *   - `detail`  — WHY, verbatim from the server where it has an opinion.
 *   - `action`  — an optional affordance, in practice "Undo": the INVERSE call, run against the same
 *     REST API (there is no server-side undo journal — see D90). Running it dismisses the toast.
 *
 * Queueing rules worth pinning (they are what the tests hold):
 *   - DEDUPE: the same severity+message+detail lands on the existing toast (bumping `repeat` and
 *     restarting its timer) rather than stacking a second copy — a failing drag that fires twice
 *     must not paper the screen.
 *   - CAP: at most MAX_TOASTS on screen; the oldest is dropped to make room for the newest.
 *   - HOVER-PAUSE: `pause(id)` banks the remaining time, `resume(id)` re-arms it, so an operator
 *     reading a toast (or reaching for Undo) never has it vanish mid-reach.
 *
 * Timers live at module scope, keyed by toast id — a `setTimeout` handle has no business being
 * reactive (same discipline as the admin socket in stores/console.ts).
 */
import { defineStore } from "pinia";

export type ToastSeverity = "info" | "success" | "error";

/** The optional button on a toast. `run` is awaited; a rejection surfaces as its own error toast. */
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface Toast {
  id: string;
  severity: ToastSeverity;
  /** What happened, in plain English. */
  message: string;
  /** Why — the server's sentence, when it had one. */
  detail?: string;
  action?: ToastAction;
  /** Auto-dismiss delay in ms; 0 = sticky (dismissed only by the operator or an action). */
  ttlMs: number;
  /** How many times this exact toast has been raised (2+ renders a "×N" chip). */
  repeat: number;
}

export interface ToastInput {
  severity?: ToastSeverity;
  message: string;
  detail?: string | undefined;
  action?: ToastAction | undefined;
  ttlMs?: number;
}

/** How long each severity lingers. Errors sit longest — they are the ones worth reading. */
const TTL_BY_SEVERITY: Record<ToastSeverity, number> = {
  info: 4500,
  success: 5000,
  error: 9000,
};
/** A toast carrying an Undo gets a longer fuse: the operator has to notice it, then reach for it. */
const TTL_WITH_ACTION = 9000;
const MAX_TOASTS = 4;

interface TimerEntry {
  handle: ReturnType<typeof setTimeout>;
  /** Wall-clock ms at which this toast expires (used to bank the remainder on pause). */
  expiresAt: number;
  /** Time left when paused; null while running. */
  remainingMs: number | null;
}

const timers = new Map<string, TimerEntry>();
let seq = 0;

function nextId(): string {
  seq += 1;
  return `toast-${seq}`;
}

export interface ToastState {
  toasts: Toast[];
}

export const useToastStore = defineStore("toasts", {
  state: (): ToastState => ({ toasts: [] }),

  actions: {
    /**
     * Raise a toast (or refresh the identical one already on screen). Returns its id so a caller can
     * dismiss it early — e.g. a long-running action replacing its own "working…" toast.
     */
    push(input: ToastInput): string {
      const severity = input.severity ?? "info";
      const ttlMs =
        input.ttlMs ?? (input.action ? TTL_WITH_ACTION : TTL_BY_SEVERITY[severity]);

      // Dedupe: the same thing failing twice is one toast that has happened twice.
      const twin = this.toasts.find(
        (t) =>
          t.severity === severity && t.message === input.message && t.detail === input.detail,
      );
      if (twin) {
        twin.repeat += 1;
        // The newest raise wins on the action + fuse: a later attempt's Undo is the live one.
        twin.action = input.action;
        twin.ttlMs = ttlMs;
        this.arm(twin.id, ttlMs);
        return twin.id;
      }

      const toast: Toast = {
        id: nextId(),
        severity,
        message: input.message,
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.action ? { action: input.action } : {}),
        ttlMs,
        repeat: 1,
      };
      this.toasts.push(toast);
      // Cap the rail: the newest matters most, so the oldest gives up its slot.
      while (this.toasts.length > MAX_TOASTS) {
        const oldest = this.toasts[0];
        if (!oldest) break;
        this.dismiss(oldest.id);
      }
      this.arm(toast.id, ttlMs);
      return toast.id;
    },

    info(message: string, opts: Omit<ToastInput, "message" | "severity"> = {}): string {
      return this.push({ ...opts, severity: "info", message });
    },

    success(message: string, opts: Omit<ToastInput, "message" | "severity"> = {}): string {
      return this.push({ ...opts, severity: "success", message });
    },

    error(message: string, opts: Omit<ToastInput, "message" | "severity"> = {}): string {
      return this.push({ ...opts, severity: "error", message });
    },

    /** @internal (Re-)arm a toast's auto-dismiss. `ttlMs` of 0 leaves it sticky. */
    arm(id: string, ttlMs: number): void {
      this.clearTimer(id);
      if (ttlMs <= 0) return;
      const handle = setTimeout(() => {
        timers.delete(id);
        this.dismiss(id);
      }, ttlMs);
      timers.set(id, { handle, expiresAt: Date.now() + ttlMs, remainingMs: null });
    },

    /** @internal Drop a toast's timer without touching the toast itself. */
    clearTimer(id: string): void {
      const entry = timers.get(id);
      if (!entry) return;
      clearTimeout(entry.handle);
      timers.delete(id);
    },

    /** Hover (or focus) a toast: bank whatever time is left so it can't vanish while being read. */
    pause(id: string): void {
      const entry = timers.get(id);
      if (!entry || entry.remainingMs !== null) return;
      clearTimeout(entry.handle);
      timers.set(id, {
        ...entry,
        remainingMs: Math.max(0, entry.expiresAt - Date.now()),
      });
    },

    /** Un-hover: re-arm with the banked remainder (never less than a beat, so it doesn't snap away). */
    resume(id: string): void {
      const entry = timers.get(id);
      if (!entry || entry.remainingMs === null) return;
      this.arm(id, Math.max(600, entry.remainingMs));
    },

    dismiss(id: string): void {
      this.clearTimer(id);
      const idx = this.toasts.findIndex((t) => t.id === id);
      if (idx >= 0) this.toasts.splice(idx, 1);
    },

    /**
     * Run a toast's action (in practice: Undo). The toast is dismissed first — the operator has
     * decided — and a failing inverse says so in its own error toast rather than vanishing quietly.
     */
    async runAction(id: string): Promise<void> {
      const toast = this.toasts.find((t) => t.id === id);
      const action = toast?.action;
      this.dismiss(id);
      if (!action) return;
      try {
        await action.run();
      } catch (err) {
        this.error("Undo failed", {
          detail: err instanceof Error ? err.message : undefined,
        });
      }
    },

    /** Drop every toast (used on sign-out — nothing from the old session should linger). */
    clear(): void {
      for (const t of [...this.toasts]) this.dismiss(t.id);
    },
  },
});
