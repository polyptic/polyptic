/**
 * OTA (POL-28) — resolve the depot's advertised agent release.
 *
 * The control plane needs to know the latest agent version it can serve (and the per-arch checksums)
 * so the rollout controller can offer updates + gate on integrity. This resolves an {@link AgentManifest}
 * from the same `AGENT_DIST_DIR` the depot serves binaries out of, preferring an explicit
 * `manifest.json` (written by deploy/gen-manifest.mjs at build) and falling back to hashing whatever
 * binaries are present so a hand-seeded depot still works. The result is served verbatim at
 * `GET /dist/agent/manifest.json` and read by the rollout controller.
 *
 * Integrity: the checksums always describe the exact bytes on disk — either the manifest.json produced
 * by the same build that emitted the binaries, or a fresh hash of the binaries themselves. The
 * provisioning epoch is authoritative from THIS server build (PROVISION_EPOCH), because in the product
 * image the server and the served agent binaries are compiled together from one commit.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { AgentManifest, PROVISION_EPOCH } from "@polyptic/protocol";
import type { AgentArch } from "@polyptic/protocol";

const ARCHES: AgentArch[] = ["amd64", "arm64"];

/** sha256 (hex) of a file, or null if it can't be read. */
async function sha256File(path: string): Promise<{ sha256: string; size: number } | null> {
  try {
    const buf = await readFile(path);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    return { sha256, size: buf.byteLength };
  } catch {
    return null;
  }
}

/**
 * Load the agent manifest from `agentDistDir`. Returns null when there is nothing to advertise (no
 * manifest.json and no binaries, or no version available) — in which case OTA stays effectively off.
 *
 * @param agentDistDir directory the depot serves `polyptic-agent-<arch>` (+ optional manifest.json) from.
 * @param fallbackVersion the version to stamp when synthesizing from bytes (POLYPTIC_VERSION).
 */
export async function loadAgentManifest(
  agentDistDir: string,
  fallbackVersion: string,
): Promise<AgentManifest | null> {
  // 1 ─ explicit manifest.json (build-emitted, authoritative for version + artifacts).
  const manifestPath = resolve(agentDistDir, "manifest.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = AgentManifest.safeParse(JSON.parse(raw));
    if (parsed.success) {
      // The running server's epoch is authoritative (server + binaries are the same build).
      return { ...parsed.data, provisionEpoch: PROVISION_EPOCH };
    }
  } catch {
    // no manifest.json (or unreadable/invalid) — synthesize from the binaries below.
  }

  // 2 ─ synthesize by hashing whatever binaries are present.
  const version = fallbackVersion.trim();
  if (!version || version === "0.0.0") return null; // no meaningful version to advertise

  const artifacts: AgentManifest["artifacts"] = {};
  let any = false;
  for (const arch of ARCHES) {
    const info = await sha256File(resolve(agentDistDir, `polyptic-agent-${arch}`));
    if (info) {
      artifacts[arch] = info;
      any = true;
    }
  }
  if (!any) return null;

  return AgentManifest.parse({ version, provisionEpoch: PROVISION_EPOCH, artifacts });
}

/** Whether the agent dist dir currently holds a manifest.json file (for boot diagnostics). */
export async function hasManifestFile(agentDistDir: string): Promise<boolean> {
  try {
    return (await stat(resolve(agentDistDir, "manifest.json"))).isFile();
  } catch {
    return false;
  }
}
