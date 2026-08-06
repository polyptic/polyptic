/**
 * POL-192 — "what is my fleet actually running, and is it updating itself?", answered at a glance.
 *
 * The production wall ran agent 0.3.6 on every box for five releases while the server offered v0.6.0.
 * Nothing in the console was wrong, exactly — it just never showed a version, so the only way to find
 * out was to grep 176 identical skip lines out of a pod log. These are the pure pieces the Machines
 * view leans on: where one box stands against the offered release, whether it can update itself, and
 * the one-line summary of the whole fleet.
 *
 * Two rules run through all of it:
 *
 *   1. **The healthy case is quiet.** A fleet that is uniform and current gets one calm line. Only a
 *      box that is behind, or one that cannot update itself, draws the eye.
 *   2. **Absent is "not reported", never "fine".** The boxes that most need this feature are the old
 *      ones, which report no runtime at all — and a server that offers no binary supports no verdict
 *      about anyone. Neither is allowed to render as healthy.
 */
import { isNewerAgentVersion } from "@polyptic/protocol";
import type { MachineView } from "@polyptic/protocol";

/** Where one box's agent stands against the version the server offers. */
export type AgentStanding =
  /** On the offered version (or ahead of it — a canary), so there is nothing to chase. */
  | { state: "current"; version: string }
  /** Older than the offered version: this box is missing releases right now. */
  | { state: "behind"; version: string; offered: string }
  /** The box reported a version but the server offers none, so nothing can be read against it. */
  | { state: "unmeasured"; version: string }
  /** The box has never reported an agent version at all. */
  | { state: "unknown" };

/** Whether a box can replace its own agent — its answer, not ours. */
export type SelfUpdateStanding =
  | { state: "able" }
  | { state: "blocked"; reason: string }
  /** No `agentRuntime` on the view: an agent too old to report it, or a box that is offline. */
  | { state: "unreported" };

export function agentStandingFor(
  machine: Pick<MachineView, "agentVersion">,
  offered: string | null,
): AgentStanding {
  const version = machine.agentVersion?.trim();
  if (!version) return { state: "unknown" };
  if (!offered) return { state: "unmeasured", version };
  if (isNewerAgentVersion(offered, version)) return { state: "behind", version, offered };
  return { state: "current", version };
}

export function selfUpdateFor(machine: Pick<MachineView, "agentRuntime">): SelfUpdateStanding {
  const runtime = machine.agentRuntime;
  if (!runtime) return { state: "unreported" };
  if (runtime.updatable) return { state: "able" };
  return { state: "blocked", reason: runtime.reason ?? "the agent gave no reason" };
}

/**
 * The sentence for a box an operator is asking "why is this version stale?" about — and null for
 * every box that is not stale, which is what keeps a healthy fleet silent. A box that is behind AND
 * says it cannot update names its own reason; one that is behind and reports nothing says exactly
 * that, because an old agent's silence is a fact about the old agent, not a clean bill of health.
 */
export function stuckLine(
  machine: Pick<MachineView, "agentVersion" | "agentRuntime" | "online">,
  offered: string | null,
): string | null {
  const standing = agentStandingFor(machine, offered);
  if (standing.state !== "behind") return null;
  const update = selfUpdateFor(machine);
  if (update.state === "blocked") {
    return `Agent ${standing.version} cannot update itself: ${update.reason}. The server offers ${standing.offered}.`;
  }
  if (update.state === "unreported") {
    return machine.online
      ? `Agent ${standing.version} does not report whether it can update itself. The server offers ${standing.offered}.`
      : `Agent ${standing.version}, last reported before this box went offline. The server offers ${standing.offered}.`;
  }
  // Behind, but the box says it takes updates: the swap is the server's next offer away, and a
  // transient state does not earn a strip. The chip already reads `0.3.6 → 0.6.0`.
  return null;
}

/** The chip's hover text: everything the box said about how it runs, in one place. */
export function agentChipTitle(
  machine: Pick<MachineView, "agentVersion" | "agentRuntime" | "online">,
  offered: string | null,
): string {
  const standing = agentStandingFor(machine, offered);
  const lines: string[] = [];
  if (standing.state === "unknown") lines.push("This box has never reported an agent version.");
  else if (standing.state === "behind") lines.push(`Running ${standing.version}, offered ${standing.offered}`);
  else if (standing.state === "current") lines.push(`Running ${standing.version}`);
  else lines.push(`Running ${standing.version} — this server offers no agent binary`);

  const runtime = machine.agentRuntime;
  if (!runtime) {
    lines.push(
      machine.online
        ? "This agent does not report how it runs."
        : "Offline, so how it runs is whatever it reports when it comes back.",
    );
  } else {
    lines.push(runtime.launch === "binary" ? "Launched as a compiled binary" : "Launched from source");
    if (runtime.binaryPath) lines.push(`Replaces ${runtime.binaryPath} on an update`);
    lines.push(runtime.updatable ? "Updates itself" : `Cannot update itself: ${runtime.reason ?? "no reason given"}`);
  }
  return lines.join("\n");
}

/** One version and how many boxes are on it. */
export interface AgentVersionCount {
  version: string;
  count: number;
  /** True when this version is older than the one the server offers. */
  behind: boolean;
}

export interface FleetAgentSummary {
  /** The version the server offers, or null when it offers none. */
  offered: string | null;
  /** Machines counted (every approved box, whether online or not). */
  total: number;
  /** Machines that have never reported an agent version. */
  unknown: number;
  /** The version spread, most-populated first — the whole fleet's versions, together. */
  versions: AgentVersionCount[];
  /** Machines running older than the offered version. */
  behind: number;
  /** Machines that say they cannot update themselves. */
  blocked: number;
  /**
   * True when there is nothing to draw the eye to: one version across the fleet, none behind, none
   * blocked. The Machines view renders a calm line for this and a warning band for anything else.
   */
  quiet: boolean;
}

export function summarizeFleetAgents(
  machines: ReadonlyArray<Pick<MachineView, "agentVersion" | "agentRuntime" | "online">>,
  offered: string | null,
): FleetAgentSummary {
  const counts = new Map<string, number>();
  let unknown = 0;
  let behind = 0;
  let blocked = 0;

  for (const m of machines) {
    const standing = agentStandingFor(m, offered);
    if (standing.state === "unknown") unknown += 1;
    else counts.set(standing.version, (counts.get(standing.version) ?? 0) + 1);
    if (standing.state === "behind") behind += 1;
    if (selfUpdateFor(m).state === "blocked") blocked += 1;
  }

  const versions = [...counts.entries()]
    .map(([version, count]) => ({
      version,
      count,
      behind: offered !== null && isNewerAgentVersion(offered, version),
    }))
    // Most-populated first; ties broken newest-version-first, so the odd box out reads last.
    .sort((a, b) => b.count - a.count || (isNewerAgentVersion(a.version, b.version) ? -1 : 1));

  return {
    offered,
    total: machines.length,
    unknown,
    versions,
    behind,
    blocked,
    quiet: behind === 0 && blocked === 0 && versions.length <= 1 && unknown === 0,
  };
}

/** The strip's headline. One sentence, and it is only ever a status. */
export function fleetAgentHeadline(s: FleetAgentSummary): string {
  if (s.total === 0) return "No machines.";
  const machines = (n: number) => `${n} ${n === 1 ? "machine" : "machines"}`;

  if (s.behind > 0) {
    return `${s.behind} of ${machines(s.total)} ${s.behind === 1 ? "is" : "are"} behind agent ${s.offered}.`;
  }
  if (s.blocked > 0) return `${s.blocked} of ${machines(s.total)} cannot update the agent.`;
  if (s.unknown > 0) {
    return `${s.unknown} of ${machines(s.total)} ${s.unknown === 1 ? "reports" : "report"} no agent version.`;
  }
  if (s.versions.length > 1) return `${machines(s.total)} on ${s.versions.length} agent versions.`;

  const only = s.versions[0];
  if (!only) return "No machines.";
  if (s.total === 1) return `On agent ${only.version}.`;
  return `All ${machines(s.total)} on agent ${only.version}.`;
}
