/**
 * POL-134 — the chart ships agent mTLS ON by default, and the escape hatch really is one.
 *
 * bundled-postgres.test.ts style: file pins on the seams (run everywhere) + real `helm template`
 * renders in every posture (run wherever helm is installed, skipped cleanly elsewhere).
 *
 * The postures pinned:
 *   - default values render AGENT_MTLS_PORT (listener on) with NO AGENT_MTLS_REQUIRE (the server's
 *     posture manages itself) and expose the raw-TCP port on the Deployment + Service;
 *   - `agentMtls.enabled=false` renders AGENT_MTLS: "off" — it must EXPLICITLY disable, because the
 *     server now brings the listener up by itself when told nothing;
 *   - `agentMtls.require=true|false` pin AGENT_MTLS_REQUIRE to "1"/"0"; the default "" omits it.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHART_DIR = resolve(repoRoot, "deploy", "helm", "polyptic");
const VALUES = readFileSync(join(CHART_DIR, "values.yaml"), "utf8");
const CONFIGMAP = readFileSync(join(CHART_DIR, "templates", "configmap.yaml"), "utf8");

const helmAvailable = spawnSync("helm", ["version"], { encoding: "utf8" }).status === 0;

function render(args: string[] = []): string {
  const res = spawnSync("helm", ["template", "test", CHART_DIR, ...args], { encoding: "utf8" });
  expect(res.status).toBe(0);
  return res.stdout;
}

describe("agent mTLS chart seams (file pins)", () => {
  test("the shipped default is enabled: true with a self-managing require posture", () => {
    expect(VALUES).toMatch(/agentMtls:\n  # [^\n]*\n  # [^\n]*\n  enabled: true/);
    expect(VALUES).toContain('require: ""');
  });

  test("the disabled branch renders an EXPLICIT AGENT_MTLS: off (default-on server otherwise self-enables)", () => {
    expect(CONFIGMAP).toContain('AGENT_MTLS: "off"');
  });
});

describe.skipIf(!helmAvailable)("helm template — every agent-mTLS posture", () => {
  test("default render: listener on at 8443, no require pin, port on Deployment + Service", () => {
    const doc = render();
    expect(doc).toContain('AGENT_MTLS_PORT: "8443"');
    expect(doc).not.toContain("AGENT_MTLS_REQUIRE");
    expect(doc).not.toContain('AGENT_MTLS: "off"');
    expect(doc).toContain("name: agent-mtls");
  });

  test("agentMtls.enabled=false renders AGENT_MTLS: off and drops the ports", () => {
    const doc = render(["--set", "agentMtls.enabled=false"]);
    expect(doc).toContain('AGENT_MTLS: "off"');
    expect(doc).not.toContain("AGENT_MTLS_PORT");
    expect(doc).not.toContain("name: agent-mtls");
  });

  test("require=true pins AGENT_MTLS_REQUIRE=1; require=false pins =0", () => {
    expect(render(["--set", "agentMtls.require=true"])).toContain('AGENT_MTLS_REQUIRE: "1"');
    expect(render(["--set", "agentMtls.require=false"])).toContain('AGENT_MTLS_REQUIRE: "0"');
  });
});
