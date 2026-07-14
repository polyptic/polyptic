<!--
  ToastHost.vue — the console's single feedback rail (POL-93). Mounted ONCE in App.vue, so every
  view (including the Wall canvas, which had no rail at all) speaks through the same affordance;
  the per-view toasts that Machines and Settings each grew are now this.

  Bottom-centre, stacked newest-last, styled in the console's own tokens (--card / --bad / --ok).
  Hovering — or tabbing into — a toast banks its remaining time, so reaching for Undo never races
  the auto-dismiss. Errors are role="alert" (assertive: the operator's action did NOT happen);
  info/success are polite. The rail itself is pointer-events:none so it never eats a canvas drag.
-->
<script setup lang="ts">
import { useToastStore, type Toast } from "../stores/toasts";

const toasts = useToastStore();

function glyph(t: Toast): string {
  if (t.severity === "error") return "✕";
  if (t.severity === "success") return "✓";
  return "i";
}
</script>

<template>
  <div class="toast-rail" aria-live="polite" aria-atomic="false">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts.toasts"
        :key="t.id"
        class="toast"
        :class="t.severity"
        :role="t.severity === 'error' ? 'alert' : 'status'"
        @mouseenter="toasts.pause(t.id)"
        @mouseleave="toasts.resume(t.id)"
        @focusin="toasts.pause(t.id)"
        @focusout="toasts.resume(t.id)"
      >
        <span class="glyph" aria-hidden="true">{{ glyph(t) }}</span>
        <div class="body">
          <div class="message">
            {{ t.message }}
            <span v-if="t.repeat > 1" class="repeat">×{{ t.repeat }}</span>
          </div>
          <div v-if="t.detail" class="detail">{{ t.detail }}</div>
        </div>
        <button
          v-if="t.action"
          class="action"
          @click="toasts.runAction(t.id)"
        >
          {{ t.action.label }}
        </button>
        <button class="close" aria-label="Dismiss" @click="toasts.dismiss(t.id)">✕</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-rail {
  position: fixed;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 300px;
  max-width: min(560px, 92vw);
  padding: 11px 12px 11px 13px;
  border-radius: 11px;
  border: 1px solid var(--line);
  background: var(--card);
  box-shadow: var(--shadow-lg);
  font-size: 12.5px;
  color: var(--fg2);
}
.toast.error {
  border-color: var(--bad);
  background: var(--bad-soft);
}
.toast.success {
  border-color: var(--ok);
}

.glyph {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  margin-top: 1px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
  color: var(--primary-fg);
  background: var(--muted2);
}
.toast.error .glyph {
  background: var(--bad);
  color: #fff;
}
.toast.success .glyph {
  background: var(--ok);
  color: #fff;
}

.body {
  flex: 1;
  min-width: 0;
}
.message {
  font-weight: 600;
  color: var(--fg);
  line-height: 1.4;
}
.repeat {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.detail {
  margin-top: 2px;
  color: var(--muted);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.action {
  flex: 0 0 auto;
  padding: 6px 11px;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  cursor: pointer;
}
.action:hover {
  background: var(--muted-bg);
}
.close {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-family: inherit;
  font-size: 11px;
  color: var(--muted2);
  cursor: pointer;
}
.close:hover {
  background: var(--muted-bg);
  color: var(--fg2);
}

/* Movement is opacity + translate only — the wall UI's animation rules are about the PLAYER, but a
   cheap transition here keeps the console honest on low-end operator laptops too. */
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
.toast-leave-active {
  position: absolute;
}
</style>
