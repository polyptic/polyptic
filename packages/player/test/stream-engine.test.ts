/**
 * Stream engine (POL-108) — the tests pin the FAILURE behaviour, because the happy path of a live
 * stream is the part that needs no engine at all.
 *
 * What must stay true on a wall nobody is watching:
 *   - a fatal error re-attaches the pipeline, with backoff — a restreamer bouncing heals by itself;
 *   - a SILENT stall (frames stop; the element reports nothing, ever) is caught by the progress
 *     watchdog — this is the failure mode that would otherwise leave a black tile up for a week;
 *   - a stream that comes back RESETS the backoff, so the next outage starts fast again;
 *   - a stream that stays dead is HANDED BACK (onGiveUp) instead of hammered forever — the POL-86
 *     prober then owns it, re-proving the playlist URL calmly until the source returns;
 *   - after handing back, the engine is inert: a late error event cannot re-enter the loop.
 */
import { describe, expect, test } from "bun:test";

import { StreamEngine } from "../src/stream-engine";
import type { StreamHealth } from "../src/stream-engine";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function harness(overrides: { mediaTime?: () => number } = {}) {
  const events: Array<[StreamHealth, string]> = [];
  const gaveUp: string[] = [];
  let attaches = 0;
  let detaches = 0;
  let progressing = true;
  // A stand-in for `video.currentTime`: it advances while frames are arriving and freezes when they
  // are not. A DEAD pipeline reads 0 forever — which is exactly the case that must not read as live.
  let mediaClock = 0;
  const engine = new StreamEngine({
    attach: () => {
      attaches += 1;
      mediaClock = 0; // a fresh pipeline starts at position zero
    },
    detach: () => {
      detaches += 1;
    },
    mediaTime:
      overrides.mediaTime ??
      ((): number => {
        if (progressing) mediaClock += 1;
        return mediaClock;
      }),
    onHealth: (health, detail) => events.push([health, detail]),
    onGiveUp: (reason) => gaveUp.push(reason),
    stallTimeoutMs: 30,
    stallPollMs: 5,
    retryMinMs: 10,
    retryMaxMs: 40,
    giveUpAfter: 3,
  });
  return {
    engine,
    events,
    gaveUp,
    healths: (): StreamHealth[] => events.map(([h]) => h),
    counts: (): { attaches: number; detaches: number } => ({ attaches, detaches }),
    setProgressing: (v: boolean): void => {
      progressing = v;
    },
  };
}

describe("StreamEngine", () => {
  test("attaches on start and reports live once frames arrive", async () => {
    const h = harness();
    h.engine.start();
    expect(h.counts().attaches).toBe(1);
    expect(h.engine.currentHealth()).toBe("connecting");

    await sleep(20); // the watchdog sees progress
    expect(h.engine.currentHealth()).toBe("live");
    expect(h.healths()).toEqual(["connecting", "live"]);
    h.engine.stop();
  });

  test("a fatal error re-attaches with backoff and recovers", async () => {
    const h = harness();
    h.engine.start();
    await sleep(20);
    expect(h.engine.currentHealth()).toBe("live");

    h.engine.fail("networkError: fragLoadError");
    expect(h.engine.currentHealth()).toBe("recovering");
    expect(h.counts().detaches).toBe(1); // the dead pipeline is torn down, not left decoding
    expect(h.events.at(-1)?.[1]).toContain("reconnecting (attempt 1 of 3)");

    await sleep(40); // retry (10ms) + a poll that sees progress again
    expect(h.counts().attaches).toBe(2);
    expect(h.engine.currentHealth()).toBe("live");
    expect(h.gaveUp).toEqual([]);
    h.engine.stop();
  });

  test("a SILENT stall (no error event, frames just stop) is caught and re-attached", async () => {
    const h = harness();
    h.engine.start();
    await sleep(20);
    expect(h.engine.currentHealth()).toBe("live");

    // The source stops sending. The element fires nothing at all — this is the black-rectangle case.
    h.setProgressing(false);
    await sleep(60); // > stallTimeoutMs
    expect(h.engine.currentHealth()).toBe("recovering");
    expect(h.events.at(-1)?.[1]).toContain("the source stopped sending");
    expect(h.counts().attaches).toBeGreaterThanOrEqual(2);

    // The source comes back: the engine is already re-attached and simply goes live again.
    h.setProgressing(true);
    await sleep(30);
    expect(h.engine.currentHealth()).toBe("live");
    h.engine.stop();
  });

  test("a recovered stream resets the backoff, so the next outage starts fast again", async () => {
    const h = harness();
    h.engine.start();
    await sleep(20);

    h.engine.fail("networkError: fragLoadError");
    expect(h.events.at(-1)?.[1]).toContain("attempt 1 of 3");
    await sleep(40); // re-attach + go live again

    h.engine.fail("networkError: fragLoadError");
    // Not "attempt 2": frames flowed in between, so this is a NEW outage, not a continuing one.
    expect(h.events.at(-1)?.[1]).toContain("attempt 1 of 3");
    h.engine.stop();
  });

  test("a stream that stays dead is handed back to the prober, and the engine goes inert", async () => {
    const h = harness({ mediaTime: () => 0 });
    h.engine.start();

    // Four consecutive failures with no frames in between: 3 reconnects, then give up.
    h.engine.fail("networkError: manifestLoadError");
    await sleep(20);
    h.engine.fail("networkError: manifestLoadError");
    await sleep(30);
    h.engine.fail("networkError: manifestLoadError");
    await sleep(50);
    h.engine.fail("networkError: manifestLoadError");

    expect(h.gaveUp).toEqual(["networkError: manifestLoadError"]);
    expect(h.engine.currentHealth()).toBe("down");
    const attachesAtGiveUp = h.counts().attaches;

    // Inert: a late error event (a stray hls callback) must not restart the loop behind the prober.
    h.engine.fail("networkError: manifestLoadError");
    await sleep(30);
    expect(h.gaveUp).toHaveLength(1);
    expect(h.counts().attaches).toBe(attachesAtGiveUp);
    h.engine.stop();
  });

  test("the prober's heal (restart) re-attaches a given-up engine and clears the give-up state", async () => {
    const h = harness({ mediaTime: () => 0 });
    h.engine.start();
    for (let i = 0; i < 4; i += 1) {
      h.engine.fail("networkError: manifestLoadError");
      await sleep(50);
    }
    expect(h.engine.currentHealth()).toBe("down");
    const before = h.counts().attaches;

    // The prober proved the URL reachable again and healed the surface in place.
    h.engine.restart("the prober healed this surface");
    expect(h.counts().attaches).toBe(before + 1);
    expect(h.engine.currentHealth()).toBe("connecting");

    // And it is live again the moment the engine's own failure budget is back.
    h.engine.fail("networkError: fragLoadError");
    expect(h.events.at(-1)?.[1]).toContain("attempt 1 of 3");
    h.engine.stop();
  });

  test("a burst of errors during a backoff counts as ONE failure — no hammer loop", async () => {
    // Real feeds fail in bursts (hls.js fatal + the element's own error event, back to back), and a
    // teardown fires an error of its OWN. If every one of them advanced the counter, four "attempts"
    // would be spent in a second and the wall would declare a merely-flapping feed dead. Caught in
    // live verification against a real ffmpeg origin — see StreamSurface.vue's own-error window.
    const h = harness();
    h.engine.start();
    await sleep(20);

    h.engine.fail("networkError: fragLoadError");
    h.engine.fail("the browser rejected the stream");
    h.engine.fail("networkError: fragLoadError");
    expect(h.events.at(-1)?.[1]).toContain("attempt 1 of 3");
    expect(h.counts().detaches).toBe(1);
    expect(h.gaveUp).toEqual([]);
    h.engine.stop();
  });

  test("a re-attached pipeline that delivers NOTHING never reports live — position 0 is not progress", async () => {
    // The black-rectangle bug, pinned. A fresh pipeline sits at currentTime 0; if that first reading
    // counts as progress, a feed whose segments all 404 flaps live→stalled→live forever, green light
    // over an empty tile, and the give-up (and therefore the prober's re-prove) NEVER happens. Seen
    // for real against an ffmpeg origin that had been killed.
    const h = harness({ mediaTime: () => 0 });
    h.engine.start();

    await sleep(400); // several stall+backoff cycles' worth
    expect(h.healths()).not.toContain("live");
    expect(h.gaveUp).toHaveLength(1); // it converged on "down" instead of flapping forever
    h.engine.stop();
  });

  test("stop() tears the pipeline down and nothing fires afterwards", async () => {
    const h = harness();
    h.engine.start();
    await sleep(20);
    h.engine.stop();
    const after = h.events.length;

    h.engine.fail("networkError: fragLoadError");
    await sleep(40);
    expect(h.counts().detaches).toBe(1); // exactly the stop()'s teardown
    expect(h.events).toHaveLength(after);
  });
});
