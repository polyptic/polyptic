<script setup lang="ts">
/**
 * Idle splash (POL-27) — shown fullscreen on a wall screen once the player is up but its slice
 * carries no surfaces, in place of a bare black screen. A calm marketing board: the Polyptic mark,
 * wordmark, and a quiet "No Content Assigned" line, with the screen's identity and build version
 * resting along the bottom. Mirrors the cold-boot lockup so a screen reads as intentional, not dead.
 *
 * Dark by design — this replaces black, and matches the player's chromeless kiosk surface. Fonts
 * are Geist / Geist Mono (loaded in index.html) with a system fallback, so an offline wall box still
 * renders cleanly. The status dot reflects the live connection so an operator can tell a waiting
 * screen (green) from one that never reached the control plane (amber/red).
 */
import type { ConnState } from "./ws";

defineProps<{
  /** The screen's friendly name (as named in the console), falling back to its id pre-first-render.
   *  Labelled exactly as typed — never the raw `screen-N` id once the console has named it (POL-29). */
  name: string;
  /** Drives the status-dot colour: live (green) vs connecting (amber) vs offline (red). */
  connState: ConnState;
  /** Build version string, injected from package.json at build time. */
  version: string;
}>();
</script>

<template>
  <div class="idle">
    <div class="idle-center">
      <div class="idle-mark">
        <svg width="98" height="98" viewBox="0 0 32 32" aria-hidden="true">
          <polygon points="6.6,11 12.3,8.2 12.3,23.8 6.6,21" fill="var(--idle-glyph)" opacity=".55" />
          <polygon points="25.4,11 19.7,8.2 19.7,23.8 25.4,21" fill="var(--idle-glyph)" opacity=".55" />
          <rect x="13.1" y="8" width="5.8" height="16" fill="var(--idle-glyph)" />
        </svg>
      </div>
      <div class="idle-wordmark">Polyptic</div>
      <div class="idle-sub">No Content Assigned</div>
    </div>

    <div class="idle-status">
      <span class="idle-dot" :class="`idle-dot--${connState}`" />
      <span class="idle-screen">{{ name }}</span>
    </div>

    <div class="idle-version">v{{ version }}</div>
  </div>
</template>

<style scoped>
/* Dark idle board (design 2b). Colours live as custom properties so a light variant is a one-line
   swap; the mark/wordmark tokens mirror the canonical brand mark (holder + panels). */
.idle {
  --idle-bg: #0b0b0d;
  --idle-holder: #fafafa;
  --idle-glyph: #161618;
  --idle-wm: #fafafa;
  --idle-subtle: #71717a;
  --idle-muted: #a1a1aa;
  --idle-faint: #4b4d54;
  --idle-track: #1a1a1e;

  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--idle-bg);
  font-family: "Geist", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.idle-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.idle-mark {
  width: 136px;
  height: 136px;
  border-radius: 33px;
  background: var(--idle-holder);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5);
  animation: idle-breathe 5s ease-in-out infinite;
}

.idle-wordmark {
  margin-top: 38px;
  font-size: 52px;
  font-weight: 600;
  letter-spacing: -0.03em;
  color: var(--idle-wm);
}

.idle-sub {
  margin-top: 12px;
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 16px;
  letter-spacing: 5px;
  text-transform: uppercase;
  color: var(--idle-subtle);
}

/* Screen identity — bottom-left pill. Useful in production where the dev badge is hidden. */
.idle-status {
  position: absolute;
  left: 64px;
  bottom: 60px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 15px;
  border-radius: 999px;
  background: var(--idle-track);
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 16px;
  color: var(--idle-muted);
}

.idle-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--idle-faint);
  animation: idle-pulse 2.6s ease-in-out infinite;
}

.idle-dot--open {
  background: #22c55e;
}

.idle-dot--connecting {
  background: #f2c14e;
}

.idle-dot--closed {
  background: #e0533d;
}

.idle-screen {
  font-variant-numeric: tabular-nums;
}

/* Build version — bottom-right. */
.idle-version {
  position: absolute;
  right: 64px;
  bottom: 60px;
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 16px;
  color: var(--idle-faint);
}

@keyframes idle-breathe {
  0%,
  100% {
    opacity: 0.82;
  }
  50% {
    opacity: 1;
  }
}

@keyframes idle-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

/* Kiosks run unattended; honour a reduced-motion preference where the host exposes one. */
@media (prefers-reduced-motion: reduce) {
  .idle-mark,
  .idle-dot {
    animation: none;
  }
}
</style>
