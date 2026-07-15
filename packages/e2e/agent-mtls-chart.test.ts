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
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  // POL-143 — the default publishes the listener on a NodePort so a box can actually reach it on
  // stock K3s (ClusterIP + Traefik-only :80/:443 stranded every migration before this).
  test("the shipped default publishes the listener via a NodePort", () => {
    expect(VALUES).toContain("expose: nodePort");
    expect(VALUES).toMatch(/nodePort: \d+/);
  });

  test("the configmap advertises the NodePort (not the bind port) when expose=nodePort", () => {
    expect(CONFIGMAP).toContain("AGENT_MTLS_ADVERTISE_PORT");
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

  // POL-143 — reachability on stock K3s. The default renders a dedicated NodePort Service AND tells
  // agents the port to dial; expose=none drops both (bring your own LB); publicUrl overrides all.
  test("default render: a NodePort Service publishes agent-mtls and the configmap advertises that port", () => {
    const doc = render();
    expect(doc).toContain("name: test-polyptic-agent-mtls");
    expect(doc).toContain("type: NodePort");
    expect(doc).toContain("nodePort: 30843");
    expect(doc).toContain('AGENT_MTLS_ADVERTISE_PORT: "30843"');
  });

  test("a custom nodePort flows to both the Service and the advertised port", () => {
    const doc = render(["--set", "agentMtls.nodePort=31500"]);
    expect(doc).toContain("nodePort: 31500");
    expect(doc).toContain('AGENT_MTLS_ADVERTISE_PORT: "31500"');
  });

  test("expose=none drops the NodePort Service and the advertised port (BYO reachability)", () => {
    const doc = render(["--set", "agentMtls.expose=none"]);
    expect(doc).not.toContain("test-polyptic-agent-mtls");
    expect(doc).not.toContain("AGENT_MTLS_ADVERTISE_PORT");
    // the listener still binds in the pod — it's only the external publishing that's the operator's.
    expect(doc).toContain('AGENT_MTLS_PORT: "8443"');
  });

  test("an explicit publicUrl wins: no advertised NodePort, the full URL override instead", () => {
    const doc = render(["--set", "agentMtls.publicUrl=wss://agent.example:443/agent"]);
    expect(doc).toContain('AGENT_MTLS_PUBLIC_URL: "wss://agent.example:443/agent"');
    expect(doc).not.toContain("AGENT_MTLS_ADVERTISE_PORT");
  });

  test("agentMtls.enabled=false drops the NodePort Service too", () => {
    expect(render(["--set", "agentMtls.enabled=false"])).not.toContain("test-polyptic-agent-mtls");
  });
});

// ── POL-143 / POL-127: the mTLS NodePort Service survives a version bump. ─────────────────────────
// `spec.ports[].nodePort` and the port shape must render from STABLE inputs (agentMtls.*), never the
// version-carrying label set — an upgrade that re-shuffled the port would churn the Service and, on
// a fixed nodePort, risk an allocation conflict. Mirrors the postgres StatefulSet pin.

/** The one rendered Service document of the given name, as its own string. */
function serviceDoc(rendered: string, name: string): string {
  const found = rendered
    .split(/^---$/m)
    .filter((d) => /^kind: Service$/m.test(d) && new RegExp(`name: ${name}$`, "m").test(d));
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** The `spec:` block (ports + type + selector) of the agent-mtls Service, verbatim. */
function mtlsServiceSpec(rendered: string): string {
  const svc = serviceDoc(rendered, "polyptic-agent-mtls");
  return svc.slice(svc.indexOf("spec:")).trimEnd();
}

function renderAtVersion(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "polyptic-mtls-chart-"));
  try {
    const chart = join(dir, "polyptic");
    cpSync(CHART_DIR, chart, { recursive: true });
    const yaml = readFileSync(join(chart, "Chart.yaml"), "utf8")
      .replace(/^version:.*$/m, `version: ${version}`)
      .replace(/^appVersion:.*$/m, `appVersion: "v${version}"`);
    writeFileSync(join(chart, "Chart.yaml"), yaml);
    const out = spawnSync("helm", ["template", "polyptic", chart], { encoding: "utf8" });
    expect(out.status).toBe(0);
    return out.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!helmAvailable)("the mTLS NodePort Service survives an upgrade (POL-143/POL-127)", () => {
  test("its spec is byte-identical across two chart versions — no version-varying input reaches it", () => {
    expect(mtlsServiceSpec(renderAtVersion("9.9.9"))).toBe(mtlsServiceSpec(renderAtVersion("0.0.1")));
  });

  test("no version-carrying label reaches the port spec", () => {
    const spec = mtlsServiceSpec(renderAtVersion("9.9.9"));
    expect(spec).not.toContain("helm.sh/chart");
    expect(spec).not.toContain("app.kubernetes.io/version");
  });
});
