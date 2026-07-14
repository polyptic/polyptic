/**
 * Per-source content health (POL-94) — what the GLASS knows, folded per library source.
 *
 * POL-86 gave the player a `SurfaceProber`: before it paints a surface it PROVES the URL fetchable
 * (`fetch(url, {mode:"no-cors"})` rejects on DNS/route/refused/timeout), re-proves on doubt, and
 * heals in place. That knowledge existed only as diag lines in the pod log — an operator learned a
 * dashboard was dead from a passer-by. This registry is the same knowledge, addressed the way an
 * operator thinks: per content source, in the library.
 *
 * The player sends a `player/surface-health` frame ONLY when a surface's state CHANGES (and re-sends
 * its current view once per socket open, because a dropped screen is forgotten here). So the cost of
 * a healthy fleet is zero frames, and a flapping URL costs one frame per flap — no polling, and no
 * server-side prober hammering the operator's dashboards on their behalf.
 *
 * The fold is deliberately pessimistic: ONE screen that cannot fetch a source makes that source
 * `unreachable`, even if three others are happily showing it. A wall that is broken on one panel is
 * broken. Everything this can and cannot know is documented on SourceHealthState in the protocol —
 * in short: it proves REACHABILITY, never that the content rendered correctly (the SOP wall hides a
 * cross-origin iframe's contents from the box itself; a login page and a 500 both fetch fine).
 *
 * Live-only, like Presence: nothing here is persisted. A control-plane restart starts at `unknown`
 * and the players re-report on reconnect.
 */
import type { ContentSourceStatus, SourceHealthState, SourceUsage } from "@polyptic/protocol";

/** One screen's last word about one surface of one source. */
interface Report {
  state: "reachable" | "unreachable";
  /** The reporting box's own ISO clock (like `player/diag` — true ordering even for replays). */
  at: string;
  detail?: string;
}

export interface SourceHealthReport {
  screenId: string;
  surfaceId: string;
  sourceId: string;
  state: "reachable" | "unreachable";
  at: string;
  detail?: string;
}

/** The aggregate for one source: what the console's badge shows. */
export interface SourceHealth {
  health: SourceHealthState;
  lastSeenAt?: string;
  unreachableScreenIds: string[];
  detail?: string;
}

/** ms since epoch for an ISO instant a BOX wrote (its clock may be skewed — we only order by it). */
function instant(at: string): number {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? 0 : ms;
}

export class SourceHealthTracker {
  /** sourceId → screenId → surfaceId → the screen's last report for that surface. */
  private readonly bySource = new Map<string, Map<string, Map<string, Report>>>();

  /** Record one player report. Reports for a source the library no longer knows are harmless — they
   *  are simply never asked for (and `forgetSource` clears them on delete). */
  record(report: SourceHealthReport): void {
    const byScreen = this.bySource.get(report.sourceId) ?? new Map<string, Map<string, Report>>();
    const bySurface = byScreen.get(report.screenId) ?? new Map<string, Report>();
    bySurface.set(report.surfaceId, {
      state: report.state,
      at: report.at,
      ...(report.detail ? { detail: report.detail } : {}),
    });
    byScreen.set(report.screenId, bySurface);
    this.bySource.set(report.sourceId, byScreen);
  }

  /**
   * A screen's player dropped (or is showing something else now): forget everything it told us. A
   * screen that is offline knows nothing about a URL's reachability — keeping its last word would
   * leave a red badge on a source whose only "evidence" is a box that has been unplugged for a week.
   */
  forgetScreen(screenId: string): void {
    for (const [sourceId, byScreen] of this.bySource) {
      if (!byScreen.delete(screenId)) continue;
      if (byScreen.size === 0) this.bySource.delete(sourceId);
    }
  }

  /** The source left the library — drop its reports so a re-used id can never inherit them. */
  forgetSource(sourceId: string): void {
    this.bySource.delete(sourceId);
  }

  /**
   * Fold one source's reports into the badge. Pessimistic: any screen reporting `unreachable` makes
   * the source unreachable. `lastSeenAt` is the newest report of whatever the winning state is — so
   * a green badge says when it was last PROVEN good, and a red one says when it broke.
   */
  statusFor(sourceId: string): SourceHealth {
    const byScreen = this.bySource.get(sourceId);
    if (!byScreen || byScreen.size === 0) return { health: "unknown", unreachableScreenIds: [] };

    const unreachableScreenIds: string[] = [];
    let newestBad = "";
    let newestGood = "";
    let detail: string | undefined;

    for (const [screenId, bySurface] of byScreen) {
      let screenBad = false;
      for (const report of bySurface.values()) {
        if (report.state === "unreachable") {
          screenBad = true;
          if (newestBad === "" || instant(report.at) >= instant(newestBad)) {
            newestBad = report.at;
            detail = report.detail;
          }
        } else if (newestGood === "" || instant(report.at) > instant(newestGood)) {
          newestGood = report.at;
        }
      }
      if (screenBad) unreachableScreenIds.push(screenId);
    }

    if (unreachableScreenIds.length > 0) {
      return {
        health: "unreachable",
        lastSeenAt: newestBad,
        unreachableScreenIds,
        ...(detail ? { detail } : {}),
      };
    }
    if (newestGood !== "") {
      return { health: "reachable", lastSeenAt: newestGood, unreachableScreenIds: [] };
    }
    return { health: "unknown", unreachableScreenIds: [] };
  }

  /** The admin snapshot's `sourceStatus`: every source's usage fold plus its health fold. */
  statusList(usage: readonly SourceUsage[]): ContentSourceStatus[] {
    return usage.map((u) => {
      const health = this.statusFor(u.sourceId);
      return {
        sourceId: u.sourceId,
        usage: u,
        health: health.health,
        ...(health.lastSeenAt ? { lastSeenAt: health.lastSeenAt } : {}),
        unreachableScreenIds: health.unreachableScreenIds,
        ...(health.detail ? { detail: health.detail } : {}),
      } satisfies ContentSourceStatus;
    });
  }
}
