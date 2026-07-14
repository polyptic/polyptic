/**
 * In-app confirms & prompts (POL-93) — the replacement for `window.confirm/prompt/alert`.
 *
 * The native dialogs were wrong for this app on three counts: they are un-styleable (a Chrome
 * chrome-grey box in the middle of the console's design language), they BLOCK the JS thread — which
 * on the Wall view means the admin socket's frames queue behind a modal nobody has answered — and
 * they cannot carry an operator-grade sentence about consequences. This store is the seam: a call
 * site `await`s a promise, the single mounted `<DialogHost>` renders the request (focus-trapped,
 * Esc cancels, Enter confirms), and the operator's answer resolves it.
 *
 * One request is live at a time. Opening a second cancels the first (resolving it as declined) —
 * an unanswered dialog must never leave a promise dangling for the lifetime of the page.
 *
 * `window.alert` has no equivalent here on purpose: an alert is a statement, not a question, and a
 * statement belongs in the toast rail (stores/toasts.ts), which doesn't demand a click to continue.
 */
import { defineStore } from "pinia";

export interface ConfirmOptions {
  title: string;
  /** The consequence, in plain English — what will actually happen if they say yes. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive/irreversible: red primary, and the dialog opens with Cancel focused. */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  /** The field's label ("Name"). */
  label?: string;
  /** Pre-filled value (selected on open, so typing replaces it). */
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export type DialogRequest =
  | ({ kind: "confirm"; id: number } & Required<Omit<ConfirmOptions, "danger">> & {
        danger: boolean;
      })
  | ({ kind: "prompt"; id: number } & Required<Omit<PromptOptions, "message">> & {
        message: string;
      });

// The pending promise's resolver lives at module scope — a function is not state, and Pinia should
// never try to make one reactive.
let resolveCurrent: ((value: unknown) => void) | null = null;
let seq = 0;

export interface DialogState {
  request: DialogRequest | null;
}

export const useDialogStore = defineStore("dialogs", {
  state: (): DialogState => ({ request: null }),

  actions: {
    /** Ask a yes/no question. Resolves true only if the operator confirmed. */
    confirm(opts: ConfirmOptions): Promise<boolean> {
      seq += 1;
      return this.open<boolean>(
        {
          kind: "confirm",
          id: seq,
          title: opts.title,
          message: opts.message,
          confirmLabel: opts.confirmLabel ?? "Confirm",
          cancelLabel: opts.cancelLabel ?? "Cancel",
          danger: opts.danger ?? false,
        },
        false,
      );
    },

    /** Ask for a line of text. Resolves the (untrimmed) value, or null if cancelled. */
    promptText(opts: PromptOptions): Promise<string | null> {
      seq += 1;
      return this.open<string | null>(
        {
          kind: "prompt",
          id: seq,
          title: opts.title,
          message: opts.message ?? "",
          label: opts.label ?? "Name",
          value: opts.value ?? "",
          placeholder: opts.placeholder ?? "",
          confirmLabel: opts.confirmLabel ?? "Save",
          cancelLabel: opts.cancelLabel ?? "Cancel",
        },
        null,
      );
    },

    /** @internal Park a request and hand back the promise the caller awaits. */
    open<T>(request: DialogRequest, declined: T): Promise<T> {
      // A dialog already up is answered as declined — never leave its awaiter hanging.
      this.settle(declined);
      this.request = request;
      return new Promise<T>((resolve) => {
        resolveCurrent = resolve as (value: unknown) => void;
      });
    },

    /** @internal Resolve whatever is pending with `value` and close the dialog. */
    settle(value: unknown): void {
      const resolve = resolveCurrent;
      resolveCurrent = null;
      this.request = null;
      resolve?.(value);
    },

    /** The operator said yes (a prompt carries its text; a confirm resolves true). */
    accept(value?: string): void {
      if (!this.request) return;
      this.settle(this.request.kind === "prompt" ? (value ?? "") : true);
    },

    /** The operator said no — Cancel, Esc, or a click outside the dialog. */
    cancel(): void {
      if (!this.request) return;
      this.settle(this.request.kind === "prompt" ? null : false);
    },
  },
});
