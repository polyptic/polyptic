/**
 * POL-160 — runtime agent self-update, the SERVER half.
 *
 * The agent binary is baked into the netboot squashfs, so an agent-code fix reached a box only on a
 * FULL image rebuild + reboot. A plain `helm upgrade` rolls the server Deployment and re-bakes the
 * boot medium, but NOT the OS image — so the squashfs the boxes stream still carried the old agent,
 * and nothing said so: v0.2.41 shipped four web-window fixes and every box kept running 0.2.40,
 * silently defeating a whole test cycle.
 *
 * The server already knows two things it needs to close this: each box's reported `agentVersion`
 * (the hello) and its OWN bundled agent version (the binary it serves at `/dist/agent/<arch>`, built
 * and released in lock-step with the server, so `BUILD_VERSION` is that binary's version). When a box
 * reports a version OLDER than the one the server serves for the box's arch, the server offers the
 * update; the agent pulls the binary and re-execs, no rebuild and no reboot — the "instant, zero-click,
 * agents are dumb reconcilers the control plane keeps current" non-negotiables, made literally true.
 *
 * This service is the pure detection half: given what a box reported, decide whether to offer, and
 * with what. It NEVER decides to downgrade (that guard is {@link isNewerAgentVersion}, shared with the
 * agent, which re-checks it before installing anything) and only offers a binary that actually exists
 * on disk for that arch.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { isNewerAgentVersion } from "@polyptic/protocol";

import type { FastifyBaseLogger } from "fastify";

/** The arches the depot serves a binary for (matches provision.ts's `/dist/agent/<arch>`). */
const SERVE_ARCHES = ["arm64", "amd64"] as const;
export type ServeArch = (typeof SERVE_ARCHES)[number];

/**
 * Map the arch a box reports on its hello (`hardware.arch`, "as the agent's runtime reports it" —
 * Bun's `process.arch`, so `x64` / `arm64`, with the kernel's `x86_64` / `aarch64` also tolerated)
 * onto the depot's `<arch>` filename token. Null when we cannot tell — we then make no offer rather
 * than guess a binary the box cannot run.
 */
export function serveArchFor(reportedArch: string | undefined): ServeArch | null {
  const a = (reportedArch ?? "").trim().toLowerCase();
  if (a === "arm64" || a === "aarch64") return "arm64";
  if (a === "x64" || a === "amd64" || a === "x86_64" || a === "x86-64") return "amd64";
  return null;
}

/** What the agent needs to fetch, verify, and swap in a newer binary. */
export interface AgentUpdateOffer {
  version: string;
  /** Same-origin path the agent resolves against the server URL it is already connected to. */
  url: string;
  sha256?: string;
  sizeBytes?: number;
}

export class AgentUpdateService {
  /** sha256 cache keyed by `<arch>@<mtimeMs>:<size>`, so hashing a ~90 MB binary happens once per
   *  build, not once per hello — a rack of boxes re-hellos constantly. */
  private readonly shaCache = new Map<string, string>();

  constructor(
    private readonly agentDistDir: string,
    /** The version of the agent binary this server bundles (== `BUILD_VERSION`). */
    private readonly servedVersion: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** True when we have a real version to advertise (a dev server stamps `0.0.0`, which is never
   *  newer than anything, so the whole feature is inert in dev without a single extra guard). */
  get configured(): boolean {
    const v = this.servedVersion.trim();
    return v.length > 0 && v !== "0.0.0";
  }

  /**
   * The update offer for a box that reported `reportedVersion` on `reportedArch`, or null when there
   * is nothing to offer: the box is current (or ahead), the arch is unknown, the served version is a
   * dev `0.0.0`, or the binary for that arch is not on disk. Never throws — a self-update we cannot
   * compute must never take a hello down.
   */
  async offerFor(reportedVersion: string | undefined, reportedArch: string | undefined): Promise<AgentUpdateOffer | null> {
    if (!this.configured) return null;
    const current = (reportedVersion ?? "").trim();
    if (!current) return null; // a box that reports no version: leave it alone
    if (!isNewerAgentVersion(this.servedVersion, current)) return null; // current or ahead — the guard

    const arch = serveArchFor(reportedArch);
    if (!arch) return null;

    const abs = join(this.agentDistDir, `polyptic-agent-${arch}`);
    let size: number;
    let mtimeMs: number;
    try {
      const st = await stat(abs);
      if (!st.isFile()) return null;
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      // The server advertises a newer version but does not actually carry that arch's binary (e.g. an
      // arm64-only depot answering an amd64 box). Nothing to offer — and worth a line, because it
      // means this arch can never self-update from here.
      this.log.warn(
        { event: "agent.update.missing_binary", arch, servedVersion: this.servedVersion },
        "a box reports an older agent but this server has no bundled binary for its arch — cannot offer a self-update",
      );
      return null;
    }

    const sha256 = await this.sha256For(arch, abs, mtimeMs, size);
    return { version: this.servedVersion, url: `/dist/agent/${arch}`, ...(sha256 ? { sha256 } : {}), sizeBytes: size };
  }

  private async sha256For(arch: ServeArch, abs: string, mtimeMs: number, size: number): Promise<string | undefined> {
    const key = `${arch}@${mtimeMs}:${size}`;
    const cached = this.shaCache.get(key);
    if (cached) return cached;
    try {
      const hash = createHash("sha256");
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const rs = createReadStream(abs);
        rs.on("data", (chunk) => hash.update(chunk));
        rs.on("error", rejectPromise);
        rs.on("end", () => resolvePromise());
      });
      const hex = hash.digest("hex");
      this.shaCache.set(key, hex);
      return hex;
    } catch {
      // sha is best-effort metadata: the agent still verifies size + runs a self-check of the binary.
      return undefined;
    }
  }
}
