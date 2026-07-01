#!/usr/bin/env bun
// deploy/gen-manifest.mjs — emit the OTA agent release manifest (POL-28).
//
// Hashes whatever `polyptic-agent-<arch>` binaries are present in the dist dir and writes
// `manifest.json` alongside them, so the control plane can advertise the depot's release + per-arch
// sha256 (served at GET /dist/agent/manifest.json and read by the rollout controller). The checksums
// describe the EXACT bytes the depot serves, so a box's post-download verification always matches.
//
// It hashes every binary present, so running it once per arch (build-agent.sh) or once for both
// (server.Dockerfile) both converge to a manifest covering the binaries on disk.
//
// USAGE:  deploy/gen-manifest.mjs [distDir] [version] [provisionEpoch]
//   distDir         default: deploy/dist  (or env AGENT_DIST_DIR)
//   version         default: env VERSION / POLYPTIC_VERSION
//   provisionEpoch  default: env PROVISION_EPOCH / 1
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

const distDir = resolve(argv[0] || process.env.AGENT_DIST_DIR || join(repoRoot, "deploy/dist"));
const version = (argv[1] || process.env.VERSION || process.env.POLYPTIC_VERSION || "").trim().replace(/^v/, "");
const provisionEpoch = Number(argv[2] || process.env.PROVISION_EPOCH || 1);

if (!version) {
  console.error("gen-manifest: no version (pass an arg or set VERSION / POLYPTIC_VERSION)");
  process.exit(1);
}

const ARCHES = ["amd64", "arm64"];
const artifacts = {};
for (const arch of ARCHES) {
  const bin = join(distDir, `polyptic-agent-${arch}`);
  if (!existsSync(bin)) continue;
  const buf = readFileSync(bin);
  artifacts[arch] = {
    sha256: createHash("sha256").update(buf).digest("hex"),
    size: statSync(bin).size,
  };
}

if (Object.keys(artifacts).length === 0) {
  console.error(`gen-manifest: no polyptic-agent-<arch> binaries found in ${distDir}`);
  process.exit(1);
}

const manifest = { version, provisionEpoch, artifacts };
const out = join(distDir, "manifest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`gen-manifest: wrote ${out} (v${version}, epoch ${provisionEpoch}, arches: ${Object.keys(artifacts).join(", ")})`);
