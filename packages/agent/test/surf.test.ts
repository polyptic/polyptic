/**
 * surf argv + per-output browser supervision (D63, POL-50).
 *
 * Two things worth pinning, because getting either wrong is silent on a wall:
 *   - surf takes its URL as a POSITIONAL argument and must be LAST, and it takes its Web Inspector
 *     only at launch (`-N`). A flag ordered after the URL is parsed as a second URL.
 *   - The inspector therefore forces a RELAUNCH. `SupervisedBrowser` must treat `(url, inspector)`
 *     as the launch identity — not the url alone — or asking for the inspector would be a no-op.
 */
import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";

import { buildSurfArgs, matchesSurfWindow } from "../src/backends/surf";
import { SupervisedBrowser } from "../src/backends/supervise";
import type { LaunchTarget } from "../src/backends/supervise";

const URL = "http://localhost:5173/player?screen=screen-1";

describe("buildSurfArgs", () => {
  test("the URL is the last argument (surf takes it positionally, not as --app=)", () => {
    const args = buildSurfArgs({ url: URL }, {});
    expect(args.at(-1)).toBe(URL);
    expect(args.join(" ")).not.toContain("--app");
  });

  test("no -N by default: a sealed kiosk carries no developer extras", () => {
    expect(buildSurfArgs({ url: URL }, {})).toEqual([URL]);
  });

  test("-N is added only when the inspector is asked for, and still before the URL", () => {
    const args = buildSurfArgs({ url: URL, inspector: true }, {});
    expect(args).toEqual(["-N", URL]);
    expect(args.indexOf("-N")).toBeLessThan(args.indexOf(URL));
  });

  test("POLYPTIC_BROWSER_ARGS is appended, still ahead of the URL", () => {
    const args = buildSurfArgs({ url: URL, inspector: true }, { POLYPTIC_BROWSER_ARGS: "-g -s" });
    expect(args).toEqual(["-N", "-g", "-s", URL]);
  });

  test("matchesSurfWindow accepts surf's app_id and its XWayland WM class", () => {
    expect(matchesSurfWindow("surf")).toBe(true);
    expect(matchesSurfWindow("Surf")).toBe(true);
    expect(matchesSurfWindow("firefox")).toBe(false);
  });
});

/** A fake, immediately-alive child that never exits on its own. */
function fakeChild(pid: number): ChildProcess {
  const handlers: Array<() => void> = [];
  return {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    once(event: string, cb: () => void) {
      if (event === "exit") handlers.push(cb);
      return this;
    },
    kill() {
      (this as { exitCode: number | null }).exitCode = 0;
      for (const h of handlers.splice(0)) h();
      return true;
    },
  } as unknown as ChildProcess;
}

describe("SupervisedBrowser launch identity", () => {
  function make(): { sup: SupervisedBrowser; launches: LaunchTarget[] } {
    const launches: LaunchTarget[] = [];
    let pid = 100;
    const sup = new SupervisedBrowser(
      "DP-1",
      async (target) => {
        launches.push({ ...target });
        return fakeChild(pid++);
      },
      () => {},
    );
    return { sup, launches };
  }

  test("re-applying the same url does not relaunch", async () => {
    const { sup, launches } = make();
    await sup.setUrl(URL);
    await sup.setUrl(URL);
    expect(launches).toHaveLength(1);
  });

  test("asking for the inspector relaunches the SAME url with -N enabled", async () => {
    const { sup, launches } = make();
    await sup.setUrl(URL);
    expect(sup.inspector).toBe(false);

    await sup.setInspector(true);
    expect(launches).toHaveLength(2);
    expect(launches[1]).toEqual({ url: URL, inspector: true });
    expect(sup.inspector).toBe(true);
  });

  test("turning the inspector off relaunches without it, re-sealing the kiosk", async () => {
    const { sup, launches } = make();
    await sup.setUrl(URL);
    await sup.setInspector(true);
    await sup.setInspector(false);
    expect(launches).toHaveLength(3);
    expect(launches[2]).toEqual({ url: URL, inspector: false });
    expect(sup.inspector).toBe(false);
  });

  test("a later content re-apply keeps the inspector open (it is not silently dropped)", async () => {
    const { sup, launches } = make();
    await sup.setUrl(URL);
    await sup.setInspector(true);
    await sup.setUrl(URL); // same url, inspector still on → no relaunch
    expect(launches).toHaveLength(2);
    expect(sup.inspector).toBe(true);
  });

  test("a NEW url relaunches and carries the inspector setting across", async () => {
    const { sup, launches } = make();
    await sup.setUrl(URL);
    await sup.setInspector(true);
    const next = `${URL}&v=2`;
    await sup.setUrl(next);
    expect(launches.at(-1)).toEqual({ url: next, inspector: true });
  });

  test("setInspector on an output with nothing placed throws — there is no page to inspect", async () => {
    const { sup } = make();
    await expect(sup.setInspector(true)).rejects.toThrow(/nothing is placed/i);
  });

  test("stop() clears the desired target so the inspector cannot be toggled on a torn-down output", async () => {
    const { sup } = make();
    await sup.setUrl(URL);
    await sup.stop();
    expect(sup.url).toBeNull();
    await expect(sup.setInspector(true)).rejects.toThrow(/nothing is placed/i);
  });

  test("the live child's pid is exposed (the backend focuses that window before sending keys)", async () => {
    const { sup } = make();
    await sup.setUrl(URL);
    expect(sup.pid).toBe(100);
    await sup.stop();
    expect(sup.pid).toBeNull();
  });
});
