/**
 * Frame watchdog (POL-86) — the wall must heal a failed content load by itself.
 *
 * The behaviour worth pinning is the counter-intuitive half: a frame showing Chrome's
 * ERR_NETWORK_CHANGED error page **fires `load`**, so "it loaded" is not proof it is healthy. That is
 * why a load timeout alone cannot fix the bug this exists for, and why a network signal must reload
 * frames that already reported success. Get that wrong and the wall silently stays broken — exactly
 * the failure we shipped into.
 */
import { describe, expect, mock, test } from "bun:test";

import { FrameWatchdog } from "../src/frame-watchdog";

const OPTS = {
  loadTimeoutMs: 50,
  minReloadIntervalMs: 0, // rate-limiting has its own test; keep the others readable
  healDebounceMs: 1,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("FrameWatchdog", () => {
  test("a frame that never fires `load` is reloaded", async () => {
    const reload = mock((_id: string) => {});
    const wd = new FrameWatchdog({ ...OPTS, reload });
    wd.sync(["s1"]);

    await sleep(90);
    expect(reload).toHaveBeenCalledWith("s1");
    wd.stop();
  });

  test("a frame that loads in time is left alone", async () => {
    const reload = mock((_id: string) => {});
    const wd = new FrameWatchdog({ ...OPTS, reload });
    wd.sync(["s1"]);
    wd.onLoad("s1");

    await sleep(90);
    expect(reload).not.toHaveBeenCalled();
    wd.stop();
  });

  test("THE bug: a network signal reloads a frame even though it reported `load`", async () => {
    // Chrome commits its own ERR_NETWORK_CHANGED page into the iframe and fires `load`. So the frame
    // looks healthy and no timeout will ever fire — only the network signal can save the wall.
    const reload = mock((_id: string) => {});
    const wd = new FrameWatchdog({ ...OPTS, reload });
    wd.sync(["s1"]);
    wd.onLoad("s1");

    wd.heal("browser reported online");
    await sleep(20);

    expect(reload).toHaveBeenCalledWith("s1");
    wd.stop();
  });

  test("a burst of signals collapses into a single reload", async () => {
    const reload = mock((_id: string) => {});
    const wd = new FrameWatchdog({ ...OPTS, reload });
    wd.sync(["s1"]);
    wd.onLoad("s1");

    // online + WS reconnect + three resource errors all land at once, as they do on a real boot.
    wd.heal("online");
    wd.heal("socket reconnected");
    wd.heal("resource error");
    wd.heal("resource error");
    await sleep(20);

    expect(reload).toHaveBeenCalledTimes(1);
    wd.stop();
  });

  test("reloads are rate-limited — a wall must never hammer a struggling server", async () => {
    const reload = mock((_id: string) => {});
    let clock = 1_000;
    const wd = new FrameWatchdog({
      ...OPTS,
      minReloadIntervalMs: 10_000,
      reload,
      now: () => clock,
    });
    wd.sync(["s1"]);
    wd.onLoad("s1");

    wd.heal("first");
    await sleep(20);
    expect(reload).toHaveBeenCalledTimes(1);

    // Another signal moments later: refused, because we only just reloaded.
    wd.heal("second");
    await sleep(20);
    expect(reload).toHaveBeenCalledTimes(1);

    // Once the interval has genuinely passed, healing resumes.
    clock += 10_001;
    wd.heal("third");
    await sleep(20);
    expect(reload).toHaveBeenCalledTimes(2);
    wd.stop();
  });

  test("every framed surface is healed, not just the first", async () => {
    const reloaded: string[] = [];
    const wd = new FrameWatchdog({ ...OPTS, reload: (id) => reloaded.push(id) });
    wd.sync(["s1", "s2", "s3"]);
    for (const id of ["s1", "s2", "s3"]) wd.onLoad(id);

    wd.heal("online");
    await sleep(20);

    expect(reloaded.sort()).toEqual(["s1", "s2", "s3"]);
    wd.stop();
  });

  test("a surface removed from the screen is forgotten (no reloads for dead frames)", async () => {
    const reload = mock((_id: string) => {});
    const wd = new FrameWatchdog({ ...OPTS, reload });
    wd.sync(["s1", "s2"]);
    wd.sync(["s2"]); // the operator removed s1

    wd.heal("online");
    await sleep(20);

    expect(reload).toHaveBeenCalledWith("s2");
    expect(reload).not.toHaveBeenCalledWith("s1");
    wd.stop();
  });

  test("stop() is final — a torn-down player never touches the DOM again", async () => {
    const reload = mock((_id: string) => {});
    const wd = new FrameWatchdog({ ...OPTS, reload });
    wd.sync(["s1"]);
    wd.stop();

    wd.heal("online");
    await sleep(90); // long enough for the never-loaded timeout to have fired too
    expect(reload).not.toHaveBeenCalled();
  });

  test("no frames on screen (idle splash) → a network signal is a no-op", async () => {
    const reload = mock((_id: string) => {});
    const wd = new FrameWatchdog({ ...OPTS, reload });
    wd.sync([]);

    wd.heal("online");
    await sleep(20);
    expect(reload).not.toHaveBeenCalled();
    wd.stop();
  });
});
