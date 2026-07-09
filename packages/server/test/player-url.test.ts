/**
 * playerUrlFor / pendingUrlFor — the URLs the server hands a wall box (POL-46 regression).
 *
 * Found on the first real deployment: PLAYER_BASE_URL was set to the deployment's ORIGIN, but the
 * single image serves the CONSOLE at `/` and the player at `/player/`. Every approved box therefore
 * opened the operator's LOGIN PAGE on the wall. The chart now derives `<origin>/player`, and these
 * tests pin the shape of what the server sends so the two can't silently drift apart.
 */
import { describe, expect, test } from "bun:test";

describe("player URLs handed to wall boxes", () => {
  /** Import fresh so each case sees its own PLAYER_BASE_URL (it is read at module load). */
  async function urls(base?: string) {
    if (base === undefined) delete process.env.PLAYER_BASE_URL;
    else process.env.PLAYER_BASE_URL = base;
    const mod = await import(`../src/state?player-url-test=${encodeURIComponent(String(base))}`);
    return mod as { pendingUrlFor: (id: string) => string };
  }

  test("pendingUrlFor hangs ?pending=<machineId> off the configured base", async () => {
    const { pendingUrlFor } = await urls("http://wall.example/player");
    expect(pendingUrlFor("dmi-abc")).toBe("http://wall.example/player/?pending=dmi-abc");
  });

  test("machine ids are url-encoded (they come from DMI and are not vetted)", async () => {
    const { pendingUrlFor } = await urls("http://wall.example/player");
    expect(pendingUrlFor("a b&c")).toBe("http://wall.example/player/?pending=a%20b%26c");
  });

  test("a base pointing at the bare origin is a MISCONFIGURATION — the console lives there", async () => {
    // This is the exact production bug: the box would open the console's login page. The chart is
    // what prevents it (polyptic.playerBaseUrl appends /player); this test documents the contract.
    const { pendingUrlFor } = await urls("http://wall.example");
    expect(pendingUrlFor("m")).toBe("http://wall.example/?pending=m");
    expect(pendingUrlFor("m")).not.toContain("/player");
  });
});
