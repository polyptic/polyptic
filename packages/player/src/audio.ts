/**
 * Audio for the wall (POL-112) — the player half.
 *
 * The control plane ships `muted` + `volume` on every audible surface (video, playlist); this module
 * is the ONLY place the player turns that intent into media-element state. Two things it has to get
 * right, both of which are why this is a module and not three lines in a template:
 *
 *   1. The DEFAULT IS SILENCE. A surface that carries no audio fields (an older server, a kind that
 *      cannot sound) is muted, full stop. A wall that nobody asked to make noise makes none.
 *
 *   2. AUTOPLAY MUST SURVIVE A BLOCKED UNMUTE. Browsers only autoplay unmuted media under an explicit
 *      policy — the kiosk Chrome the agent launches passes `--autoplay-policy=no-user-gesture-required`,
 *      so the wall gets sound with no interaction after a cold boot. Anywhere that flag is NOT in
 *      force (the surf fallback under Xwayland, a dev browser, a hardened profile), `play()` on an
 *      unmuted element REJECTS. The wall must never freeze on a dead first frame because it wanted
 *      sound, so we fall back to MUTED playback and keep going: picture always wins over sound.
 */
import type { Surface } from "@polyptic/protocol";

/** What the player actually applies to a media element. */
export interface AudioIntent {
  muted: boolean;
  volume: number;
}

/** The silent default: what every non-audible surface, and every legacy payload, resolves to. */
export const SILENT: AudioIntent = { muted: true, volume: 1 };

/** Clamp to the contract's 0–1 range; a NaN/absent level is treated as full (it is muted anyway). */
export function clampVolume(volume: number | undefined): number {
  if (typeof volume !== "number" || Number.isNaN(volume)) return 1;
  return Math.min(1, Math.max(0, volume));
}

/**
 * The audio intent of a surface. Video and playlist carry it; everything else is silent by
 * construction. Note there is no hardcoded `muted` anywhere downstream of this — the flag on the wire
 * is the whole truth (POL-112 deleted the player's hardcode).
 */
export function surfaceAudio(surface: Surface): AudioIntent {
  if (surface.type !== "video" && surface.type !== "playlist") return SILENT;
  return { muted: surface.muted !== false, volume: clampVolume(surface.volume) };
}

/** The minimum of a media element this module needs — keeps it testable without a DOM. */
export interface MediaElementLike {
  muted: boolean;
  volume: number;
  play(): Promise<void>;
}

/** Apply an intent to a media element. Volume is set even while muted, so unmuting later is instant. */
export function applyAudio(el: MediaElementLike, intent: AudioIntent): void {
  el.muted = intent.muted;
  el.volume = clampVolume(intent.volume);
}

/** How a play attempt ended — surfaced for the diag trail, not for the UI. */
export type PlayOutcome = "playing" | "muted-fallback" | "blocked";

/**
 * Start (or resume) playback, degrading to muted rather than to a frozen frame.
 *
 * An unmuted `play()` that the browser's autoplay policy refuses rejects its promise; we mute and try
 * once more. If even muted playback is refused there is nothing sane left to do — report it and let
 * the caller's diag trail carry it.
 */
export async function ensurePlaying(el: MediaElementLike): Promise<PlayOutcome> {
  try {
    await el.play();
    return "playing";
  } catch {
    if (el.muted) return "blocked";
    el.muted = true;
    try {
      await el.play();
      return "muted-fallback";
    } catch {
      return "blocked";
    }
  }
}
