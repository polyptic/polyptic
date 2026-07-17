/**
 * POL-148 — the bundled NTP server is ON by default, rendering a chrony Deployment/Service/ConfigMap
 * plus (unless told otherwise) a Traefik IngressRouteUDP that carries NTP through the same ingress the
 * rest of the fleet reaches. Escape hatches: `ntp.enabled=false` (run your own — pair with
 * `ntp.clientHost`), and `ntp.upstream` (chain the bundled server to a real time source).
 *
 * Follows agent-mtls-chart.test.ts: file pins on the seams (run everywhere) + real `helm template`
 * renders in every posture (run wherever helm is installed, skipped cleanly elsewhere). The
 * IngressRouteUDP additionally gets a POL-127-style two-version byte-identical render pin — an
 * upgrade must never churn the route that every box's clock sync depends on.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHART_DIR = resolve(repoRoot, "deploy", "helm", "polyptic");
const VALUES = readFileSync(join(CHART_DIR, "values.yaml"), "utf8");

const helmAvailable = spawnSync("helm", ["version"], { encoding: "utf8" }).status === 0;

function render(args: string[] = []): string {
  const res = spawnSync("helm", ["template", "test", CHART_DIR, ...args], { encoding: "utf8" });
  expect(res.status).toBe(0);
  return res.stdout;
}

const OFF = ["--set", "ntp.enabled=false"];

describe("NTP chart seams (file pins)", () => {
  test("the shipped default is ON — clock sync deploys out of the box", () => {
    expect(VALUES).toMatch(/ntp:[\s\S]*?\n  enabled: true/);
  });

  test("the client is decoupled from the server via ntp.clientHost + ntp.upstream", () => {
    expect(VALUES).toContain("clientHost:");
    expect(VALUES).toContain("upstream:");
  });

  test("the default exposure is the Traefik UDP route, with a documented entrypoint default", () => {
    expect(VALUES).toContain("expose: ingressRouteUDP");
    expect(VALUES).toContain("entryPoint: ntp");
  });

  test("the chart does NOT manage Traefik — no HelmChartConfig template", () => {
    // Removed by design (too cluster-specific); the entrypoint is a documented operator step.
    expect(VALUES).not.toContain("manageEntryPoint");
  });
});

describe.skipIf(!helmAvailable)("helm template — NTP postures", () => {
  test("ON by default renders the chrony Deployment, Service (UDP/123) and ConfigMap", () => {
    const doc = render();
    expect(doc).toContain("name: test-polyptic-ntp");
    expect(doc).toContain("kind: Deployment");
    // The chrony command is chart-owned, so any image with chronyd works; -x = serve, never step.
    expect(doc).toContain('command: ["chronyd"]');
    expect(doc).toContain('"-x"');
    // A local reference clock — no internet upstream.
    expect(doc).toContain("local stratum 8");
    expect(doc).toContain("allow all");
    // The Service is UDP.
    expect(doc).toMatch(/kind: Service[\s\S]*?name: test-polyptic-ntp[\s\S]*?protocol: UDP/);
  });

  test("ON by default renders an IngressRouteUDP on the named entrypoint, targeting the chrony Service", () => {
    const doc = render();
    expect(doc).toContain("kind: IngressRouteUDP");
    expect(doc).toContain("- ntp"); // the entrypoint
    expect(doc).toMatch(/name: test-polyptic-ntp\n\s+port: 123/);
  });

  test("no HelmChartConfig is ever rendered — the chart doesn't touch the cluster's Traefik", () => {
    expect(render()).not.toContain("kind: HelmChartConfig");
  });

  test("ntp.enabled=false renders NO NTP resources at all (run your own)", () => {
    const doc = render(OFF);
    expect(doc).not.toContain("-ntp");
    expect(doc).not.toContain("kind: IngressRouteUDP");
  });

  test("ntp.clientHost sets POLYPTIC_NTP_HOST on the server (points the fleet elsewhere)", () => {
    // The escape hatch: server off, client aimed at a site's own NTP.
    const doc = render([...OFF, "--set", "ntp.clientHost=ntp.corp.example"]);
    expect(doc).toContain('POLYPTIC_NTP_HOST: "ntp.corp.example"');
    expect(doc).not.toContain("test-polyptic-ntp"); // no bundled server
  });

  test("ntp.upstream chains the server to a real source: server line, no -x, CAP_SYS_TIME", () => {
    const doc = render(["--set", "ntp.upstream={ntp.corp.example}"]);
    expect(doc).toContain("server ntp.corp.example iburst");
    expect(doc).toContain("makestep");
    expect(doc).toContain("- SYS_TIME");
    // -x is dropped so chronyd actually disciplines the clock to the upstream.
    expect(doc).toContain('args: ["-d", "-f", "/etc/chrony/chrony.conf"]');
  });

  test("a custom stratum + entrypoint + allow flow through", () => {
    const doc = render([
      "--set",
      "ntp.stratum=5",
      "--set",
      "ntp.ingressRouteUDP.entryPoint=time-udp",
      "--set",
      "ntp.allow={10.0.0.0/8}",
    ]);
    expect(doc).toContain("local stratum 5");
    expect(doc).toContain("allow 10.0.0.0/8");
    expect(doc).toContain("- time-udp");
  });

  test("expose=none keeps the server but opens NO Traefik route (bring your own reachability)", () => {
    const doc = render(["--set", "ntp.expose=none"]);
    expect(doc).toContain("name: test-polyptic-ntp"); // the Deployment/Service are still there
    expect(doc).not.toContain("kind: IngressRouteUDP");
  });
});

// ── POL-148 / POL-127: the IngressRouteUDP survives a version bump. ──────────────────────────────
// Its entrypoint + service target must render from STABLE inputs (ntp.*), never the version-carrying
// labels — an upgrade that re-shuffled the route would break every box's clock sync. Mirrors the
// POL-147 IngressRouteTCP pin.

/** The `spec:` block of the ntp IngressRouteUDP, verbatim. */
function ntpRouteSpec(rendered: string): string {
  const found = rendered
    .split(/^---$/m)
    .filter((d) => /^kind: IngressRouteUDP$/m.test(d) && /name: polyptic-ntp$/m.test(d));
  expect(found).toHaveLength(1);
  const doc = found[0]!;
  return doc.slice(doc.indexOf("spec:")).trimEnd();
}

function renderAtVersion(version: string, args: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "polyptic-ntp-chart-"));
  try {
    const chart = join(dir, "polyptic");
    cpSync(CHART_DIR, chart, { recursive: true });
    const yaml = readFileSync(join(chart, "Chart.yaml"), "utf8")
      .replace(/^version:.*$/m, `version: ${version}`)
      .replace(/^appVersion:.*$/m, `appVersion: "v${version}"`);
    writeFileSync(join(chart, "Chart.yaml"), yaml);
    const out = spawnSync("helm", ["template", "polyptic", chart, ...args], { encoding: "utf8" });
    expect(out.status).toBe(0);
    return out.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!helmAvailable)("the NTP IngressRouteUDP survives an upgrade (POL-148/POL-127)", () => {
  test("its spec is byte-identical across two chart versions — no version-varying input reaches it", () => {
    expect(ntpRouteSpec(renderAtVersion("9.9.9"))).toBe(ntpRouteSpec(renderAtVersion("0.0.1")));
  });

  test("no version-carrying label reaches the route spec", () => {
    const spec = ntpRouteSpec(renderAtVersion("9.9.9"));
    expect(spec).not.toContain("helm.sh/chart");
    expect(spec).not.toContain("app.kubernetes.io/version");
  });
});
