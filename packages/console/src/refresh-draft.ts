/**
 * POL-157 / D149 — the content-source refresh control's draft model, kept OUT of the .vue so it can be
 * unit-tested. The console offers three states (Off / Every N minutes·hours·days / At HH:MM on
 * weekdays) but the wire contract stores SECONDS and one IANA timezone. These pure functions convert
 * a `RefreshPolicy` ↔ the form's editable fields, so the round trip is provable.
 */
import type { RefreshPolicy } from "@polyptic/protocol";

export type RefreshUnit = "minutes" | "hours" | "days";
export type RefreshMode = "off" | "interval" | "scheduled";

/** Seconds per interval unit — the multiplier the form applies to reach `everySeconds`. */
const UNIT_SECONDS: Record<RefreshUnit, number> = { minutes: 60, hours: 3600, days: 86_400 };

/** The editable shape of the refresh control. `days` is 0=Sun…6=Sat (the scheduler's model). */
export interface RefreshDraft {
  mode: RefreshMode;
  /** Interval amount, in `unit`s (whole number ≥ 1). */
  every: number;
  unit: RefreshUnit;
  /** Scheduled fire time, `HH:MM`. */
  time: string;
  /** Scheduled weekdays (0=Sun…6=Sat). */
  days: number[];
  /** IANA zone the scheduled time is read in — seeded from the deployment's, never the browser's. */
  timezone: string;
}

/** A fresh, OFF draft. `timezone` is the deployment's (the scene scheduler's), so a scheduled cadence
 *  defaults to the wall's zone rather than whoever is editing. */
export function defaultRefreshDraft(timezone: string): RefreshDraft {
  return {
    mode: "off",
    every: 15,
    unit: "minutes",
    time: "04:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    timezone: timezone || "UTC",
  };
}

/** Populate the form from a stored policy (the edit path). Interval seconds are shown in the LARGEST
 *  whole unit that divides them cleanly (600s → 10 minutes, 7200s → 2 hours), so an operator sees the
 *  cadence the way they set it. */
export function draftFromPolicy(policy: RefreshPolicy | undefined, timezone: string): RefreshDraft {
  const base = defaultRefreshDraft(timezone);
  if (!policy || policy.mode === "off") return base;
  if (policy.mode === "interval") {
    const [every, unit] = largestUnit(policy.everySeconds);
    return { ...base, mode: "interval", every, unit };
  }
  return {
    ...base,
    mode: "scheduled",
    time: policy.atLocal,
    days: [...policy.days].sort((a, b) => a - b),
    timezone: policy.timezone,
  };
}

/** Build the wire policy from the form. Returns `{ mode: "off" }` for off (the server drops it), an
 *  interval in seconds, or a scheduled policy. `null` = the draft is invalid (bad amount / no days). */
export function policyFromDraft(draft: RefreshDraft): RefreshPolicy | null {
  if (draft.mode === "off") return { mode: "off" };
  if (draft.mode === "interval") {
    if (!Number.isInteger(draft.every) || draft.every < 1) return null;
    return { mode: "interval", everySeconds: draft.every * UNIT_SECONDS[draft.unit] };
  }
  if (draft.days.length === 0) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return null;
  return {
    mode: "scheduled",
    atLocal: draft.time,
    days: [...draft.days].sort((a, b) => a - b),
    timezone: draft.timezone,
  };
}

/** Seconds → [amount, unit] in the largest unit that divides cleanly (falls back to minutes). */
function largestUnit(seconds: number): [number, RefreshUnit] {
  if (seconds % UNIT_SECONDS.days === 0) return [seconds / UNIT_SECONDS.days, "days"];
  if (seconds % UNIT_SECONDS.hours === 0) return [seconds / UNIT_SECONDS.hours, "hours"];
  return [Math.max(1, Math.round(seconds / UNIT_SECONDS.minutes)), "minutes"];
}
