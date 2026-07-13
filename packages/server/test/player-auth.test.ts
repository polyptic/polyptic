/**
 * PlayerAuth (POL-54) — the per-screen bearer tokens gating the /player WS.
 *
 * What must hold, and why:
 *   - Tokens are DETERMINISTIC per (secret, screenId): a wall reconnecting with the URL it was
 *     launched with must verify forever — repaint-on-reconnect is how the wall survives (D5).
 *   - The secret PERSISTS: a server restart must not invalidate the URLs running on every box.
 *   - A token authorizes exactly ONE screen: replaying screen A's token as screen B must fail.
 *   - playerUrl carries the token once the minter is wired, so the trust chain is automatic:
 *     server → authenticated agent (server/apply) → browser launch → player hello.
 */
import { describe, expect, test } from "bun:test";

import { PlayerAuth } from "../src/player-auth";
import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store";

/** A logger stub — PlayerAuth.init logs one line on first-boot generation. */
const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

describe("PlayerAuth tokens", () => {
  test("first boot generates + persists a secret; a second init mints IDENTICAL tokens", async () => {
    const store = new MemoryStore();
    const first = await PlayerAuth.init(store, true, log);
    const again = await PlayerAuth.init(store, true, log);
    expect(await store.getPlayerTokenSecret()).toBeDefined();
    // A restarted server must keep honouring the URLs the fleet is already running on.
    expect(again.tokenFor("screen-1")).toBe(first.tokenFor("screen-1"));
  });

  test("tokens are per-screen: distinct screens get distinct tokens, same screen is stable", () => {
    const auth = PlayerAuth.fromSecret("ab".repeat(32), true);
    expect(auth.tokenFor("screen-1")).toBe(auth.tokenFor("screen-1"));
    expect(auth.tokenFor("screen-1")).not.toBe(auth.tokenFor("screen-2"));
    // 64 hex chars — an HMAC-SHA256, not something guessable or truncated.
    expect(auth.tokenFor("screen-1")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("verify admits exactly the minted (screenId, token) pair", () => {
    const auth = PlayerAuth.fromSecret("cd".repeat(32), true);
    const token = auth.tokenFor("screen-1");
    expect(auth.verify("screen-1", token)).toBe(true);
    // Missing, corrupted, and CROSS-SCREEN tokens must all fail.
    expect(auth.verify("screen-1", undefined)).toBe(false);
    expect(auth.verify("screen-1", "")).toBe(false);
    expect(auth.verify("screen-1", token.slice(0, -1) + "0")).toBe(false);
    expect(auth.verify("screen-2", token)).toBe(false);
  });

  test("different deployments (secrets) never honour each other's tokens", () => {
    const a = PlayerAuth.fromSecret("11".repeat(32), true);
    const b = PlayerAuth.fromSecret("22".repeat(32), true);
    expect(b.verify("screen-1", a.tokenFor("screen-1"))).toBe(false);
  });

  test("registerMachine's playerUrl carries the screen's token once the minter is wired", async () => {
    const store = new MemoryStore();
    const auth = await PlayerAuth.init(store, true, log);
    const control = new ControlPlane(store);
    await control.init();
    control.setPlayerTokenMinter((screenId) => auth.tokenFor(screenId));

    const { assignments } = await control.registerMachine({
      machineId: "m-1",
      agentVersion: "test",
      backend: "dev-open",
      outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
    });
    expect(assignments.length).toBe(1);
    const url = new URL(assignments[0]!.playerUrl);
    const screenId = url.searchParams.get("screen")!;
    const token = url.searchParams.get("token");
    expect(screenId).toBeTruthy();
    expect(token).toBe(auth.tokenFor(screenId));
    // And the pair the URL carries is exactly what the /player gate will admit.
    expect(auth.verify(screenId, token ?? undefined)).toBe(true);
  });

  test("without a minter (unit-test control planes) playerUrl stays tokenless — no crash", async () => {
    const control = new ControlPlane(new MemoryStore());
    await control.init();
    const { assignments } = await control.registerMachine({
      machineId: "m-2",
      agentVersion: "test",
      backend: "dev-open",
      outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
    });
    expect(new URL(assignments[0]!.playerUrl).searchParams.get("token")).toBeNull();
  });
});
