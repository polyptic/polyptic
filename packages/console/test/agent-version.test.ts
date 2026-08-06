/**
 * POL-192 — the fleet's agent versions, read at a glance.
 *
 * The case these pin is the one that actually happened: every box on agent 0.3.6 while the server
 * offered 0.6.0, each one saying it could never self-update, and a console that showed a healthy
 * fleet. The two properties that must hold are that the stuck fleet SHOUTS and the healthy fleet is
 * SILENT — and, in between, that a box which reports nothing reads as "not reported" rather than fine.
 */
import { describe, expect, test } from "bun:test";
import type { MachineView } from "@polyptic/protocol";

import {
  agentChipTitle,
  agentStandingFor,
  fleetAgentHeadline,
  selfUpdateFor,
  stuckLine,
  summarizeFleetAgents,
} from "../src/agent-version";

type Box = Pick<MachineView, "agentVersion" | "agentRuntime" | "online">;

/** A box on the OLD agent — the field reality: no runtime reported at all. */
function oldBox(version = "0.3.6", online = true): Box {
  return { agentVersion: version, online };
}
/** A box on a new agent that knows it can never swap itself (the production trap). */
function stuckBox(version = "0.3.6", online = true): Box {
  return {
    agentVersion: version,
    online,
    agentRuntime: {
      launch: "source",
      updatable: false,
      reason: "not running as an updatable binary (dev/source run)",
    },
  };
}
/** A healthy box: compiled binary, updates itself. */
function healthyBox(version = "0.6.0", online = true): Box {
  return {
    agentVersion: version,
    online,
    agentRuntime: { launch: "binary", binaryPath: "/usr/local/bin/polyptic-agent", updatable: true },
  };
}

describe("agentStandingFor", () => {
  test("older than the offered version is BEHIND, and carries both numbers", () => {
    expect(agentStandingFor({ agentVersion: "0.3.6" }, "0.6.0")).toEqual({
      state: "behind",
      version: "0.3.6",
      offered: "0.6.0",
    });
  });
  test("equal is current; ahead (a canary) is current too — we never chase a box downwards", () => {
    expect(agentStandingFor({ agentVersion: "0.6.0" }, "0.6.0").state).toBe("current");
    expect(agentStandingFor({ agentVersion: "0.7.0" }, "0.6.0").state).toBe("current");
  });
  test("no offered version supports no verdict", () => {
    expect(agentStandingFor({ agentVersion: "0.3.6" }, null)).toEqual({
      state: "unmeasured",
      version: "0.3.6",
    });
  });
  test("a box that never reported a version is unknown, not current", () => {
    expect(agentStandingFor({}, "0.6.0").state).toBe("unknown");
    expect(agentStandingFor({ agentVersion: "  " }, "0.6.0").state).toBe("unknown");
  });
});

describe("selfUpdateFor — an absent runtime is never 'able'", () => {
  test("a reporting agent is taken at its word, in both directions", () => {
    expect(selfUpdateFor(healthyBox())).toEqual({ state: "able" });
    expect(selfUpdateFor(stuckBox())).toEqual({
      state: "blocked",
      reason: "not running as an updatable binary (dev/source run)",
    });
  });
  test("an old agent reports nothing, and that reads as unreported", () => {
    expect(selfUpdateFor(oldBox())).toEqual({ state: "unreported" });
  });
});

describe("stuckLine — only a stale box gets a sentence", () => {
  test("behind and blocked names the box's OWN reason and both versions", () => {
    expect(stuckLine(stuckBox(), "0.6.0")).toBe(
      "Agent 0.3.6 cannot update itself: not running as an updatable binary (dev/source run). The server offers 0.6.0.",
    );
  });
  test("behind with no runtime says the agent does not report it — never that it is fine", () => {
    const line = stuckLine(oldBox(), "0.6.0");
    expect(line).toContain("does not report whether it can update itself");
    expect(line).toContain("0.6.0");
  });
  test("an OFFLINE box says its version is the last one reported", () => {
    expect(stuckLine(oldBox("0.3.6", false), "0.6.0")).toContain("before this box went offline");
  });
  test("current, or behind but updatable, gets no strip — the healthy case is quiet", () => {
    expect(stuckLine(healthyBox(), "0.6.0")).toBeNull();
    expect(stuckLine(healthyBox("0.5.0"), "0.6.0")).toBeNull();
    expect(stuckLine(oldBox("0.6.0"), "0.6.0")).toBeNull();
    expect(stuckLine(stuckBox(), null)).toBeNull(); // nothing offered, nothing to be behind
  });
});

describe("agentChipTitle", () => {
  test("names the launch, the binary it would replace, and the running/offered pair", () => {
    const title = agentChipTitle(healthyBox("0.5.0"), "0.6.0");
    expect(title).toContain("Running 0.5.0, offered 0.6.0");
    expect(title).toContain("Launched as a compiled binary");
    expect(title).toContain("Replaces /usr/local/bin/polyptic-agent");
    expect(title).toContain("Updates itself");
  });
  test("a blocked box carries its reason", () => {
    expect(agentChipTitle(stuckBox(), "0.6.0")).toContain(
      "Cannot update itself: not running as an updatable binary (dev/source run)",
    );
  });
  test("an old agent's silence is stated, not filled in", () => {
    expect(agentChipTitle(oldBox(), "0.6.0")).toContain("does not report how it runs");
  });
});

describe("summarizeFleetAgents / fleetAgentHeadline", () => {
  test("THE FIELD CASE: a whole fleet five releases back, every box blocked", () => {
    const fleet = [stuckBox(), stuckBox(), stuckBox(), stuckBox()];
    const s = summarizeFleetAgents(fleet, "0.6.0");
    expect(s.behind).toBe(4);
    expect(s.blocked).toBe(4);
    expect(s.quiet).toBe(false);
    expect(fleetAgentHeadline(s)).toBe("4 of 4 machines are behind agent 0.6.0.");
  });

  test("one lagging box in a healthy fleet is still not quiet", () => {
    const s = summarizeFleetAgents([healthyBox(), healthyBox(), healthyBox("0.3.6")], "0.6.0");
    expect(s.behind).toBe(1);
    expect(s.quiet).toBe(false);
    expect(fleetAgentHeadline(s)).toBe("1 of 3 machines is behind agent 0.6.0.");
    // The version spread is the whole point: both versions, most-populated first.
    expect(s.versions).toEqual([
      { version: "0.6.0", count: 2, behind: false },
      { version: "0.3.6", count: 1, behind: true },
    ]);
  });

  test("a uniform, current, self-updating fleet is QUIET and says so once", () => {
    const s = summarizeFleetAgents([healthyBox(), healthyBox(), healthyBox()], "0.6.0");
    expect(s).toMatchObject({ behind: 0, blocked: 0, unknown: 0, quiet: true });
    expect(fleetAgentHeadline(s)).toBe("All 3 machines on agent 0.6.0.");
  });

  test("a current box that cannot self-update still breaks the quiet — it will miss the NEXT release", () => {
    const blockedButCurrent: Box = {
      agentVersion: "0.6.0",
      online: true,
      agentRuntime: { launch: "source", updatable: false, reason: "dev/source run" },
    };
    const s = summarizeFleetAgents([healthyBox(), blockedButCurrent], "0.6.0");
    expect(s.behind).toBe(0);
    expect(s.quiet).toBe(false);
    expect(fleetAgentHeadline(s)).toBe("1 of 2 machines cannot update the agent.");
  });

  test("with no offered version nothing is called behind, but a mixed fleet is still not quiet", () => {
    const s = summarizeFleetAgents([healthyBox("0.6.0"), healthyBox("0.5.0")], null);
    expect(s.behind).toBe(0);
    expect(s.versions.every((v) => !v.behind)).toBe(true);
    expect(s.quiet).toBe(false);
    expect(fleetAgentHeadline(s)).toBe("2 machines on 2 agent versions.");
  });

  test("boxes that never reported a version are counted as unknown, never folded into a version", () => {
    const s = summarizeFleetAgents([healthyBox(), { online: false }], "0.6.0");
    expect(s.unknown).toBe(1);
    expect(s.versions).toEqual([{ version: "0.6.0", count: 1, behind: false }]);
    expect(s.quiet).toBe(false);
    expect(fleetAgentHeadline(s)).toBe("1 of 2 machines reports no agent version.");
  });

  test("an empty fleet says nothing about versions", () => {
    const s = summarizeFleetAgents([], "0.6.0");
    expect(s.quiet).toBe(true);
    expect(fleetAgentHeadline(s)).toBe("No machines.");
  });
});
