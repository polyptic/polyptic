<!--
  ConfirmDialog.vue — the console's in-app confirm/prompt (POL-93). Mounted ONCE in App.vue; it
  renders whatever the dialogs store is currently asking (see stores/dialogs.ts for why the native
  dialogs had to go).

  Behaviour the operator can rely on, everywhere:
    - Esc cancels, Enter confirms (in a prompt, Enter in the field commits it).
    - Focus is TRAPPED inside the dialog while it is open and restored to whatever had it before —
      a Tab from the last control wraps to the first, never behind the scrim.
    - A prompt opens with its field focused and the existing value selected, so typing replaces it
      (matching the native prompt an operator's fingers already know).
    - A danger dialog is red and opens with CANCEL focused: a stray Enter must not delete a machine.
    - Clicking the scrim is a cancel. The title says what is being asked; the body says what will
      actually happen — the consequence in plain English, not "Are you sure?".
-->
<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useDialogStore } from "../stores/dialogs";

const dialogs = useDialogStore();

const draft = ref("");
const panel = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const confirmBtn = ref<HTMLButtonElement | null>(null);
const cancelBtn = ref<HTMLButtonElement | null>(null);
let restoreFocusTo: HTMLElement | null = null;

watch(
  () => dialogs.request,
  async (req) => {
    if (!req) {
      // Hand focus back to whatever the operator was on when the dialog took over.
      restoreFocusTo?.focus?.();
      restoreFocusTo = null;
      return;
    }
    restoreFocusTo = (document.activeElement as HTMLElement | null) ?? null;
    draft.value = req.kind === "prompt" ? req.value : "";
    await nextTick();
    if (req.kind === "prompt") {
      input.value?.focus();
      input.value?.select();
    } else if (req.danger) {
      cancelBtn.value?.focus();
    } else {
      confirmBtn.value?.focus();
    }
  },
);

function accept(): void {
  dialogs.accept(draft.value);
}

/** The trap: Esc closes, Enter confirms, and Tab cycles within the panel's own controls. */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    dialogs.cancel();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    accept();
    return;
  }
  if (e.key !== "Tab") return;
  const focusable = Array.from(
    panel.value?.querySelectorAll<HTMLElement>("button, input, [tabindex]:not([tabindex='-1'])") ??
      [],
  ).filter((el) => !el.hasAttribute("disabled"));
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !panel.value?.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="dialogs.request"
      class="scrim"
      @click.self="dialogs.cancel()"
      @keydown="onKeydown"
    >
      <div
        ref="panel"
        class="panel"
        :class="{ danger: dialogs.request.kind === 'confirm' && dialogs.request.danger }"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-message"
      >
        <h2 id="dialog-title" class="title">{{ dialogs.request.title }}</h2>
        <p v-if="dialogs.request.message" id="dialog-message" class="message">
          {{ dialogs.request.message }}
        </p>

        <label v-if="dialogs.request.kind === 'prompt'" class="field">
          <span class="field-label">{{ dialogs.request.label }}</span>
          <input
            ref="input"
            v-model="draft"
            class="input"
            type="text"
            :placeholder="dialogs.request.placeholder"
          />
        </label>

        <div class="actions">
          <button ref="cancelBtn" class="btn ghost" @click="dialogs.cancel()">
            {{ dialogs.request.cancelLabel }}
          </button>
          <button ref="confirmBtn" class="btn primary" @click="accept()">
            {{ dialogs.request.confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(9, 9, 11, 0.42);
  padding: 20px;
}
.panel {
  width: min(440px, 100%);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  padding: 20px 20px 16px;
}
.title {
  margin: 0 0 8px;
  font-size: 15.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--fg);
}
.message {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--muted);
}
.field {
  display: block;
  margin-top: 14px;
}
.field-label {
  display: block;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 5px;
}
.input {
  width: 100%;
  padding: 9px 11px;
  border-radius: 9px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-family: inherit;
  font-size: 13px;
  color: var(--fg);
}
.input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
.btn {
  padding: 8px 15px;
  border-radius: 9px;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
}
.btn.ghost {
  border-color: var(--line2);
  background: var(--surface);
  color: var(--fg2);
}
.btn.ghost:hover {
  background: var(--muted-bg);
}
.btn.primary {
  background: var(--primary);
  color: var(--primary-fg);
}
.btn.primary:hover {
  opacity: 0.92;
}
.panel.danger .btn.primary {
  background: var(--bad);
  color: #fff;
}
.btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
