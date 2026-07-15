/**
 * The chart brings its own database — POL-123/D108.
 *
 * Before this, `postgresql.*` in values.yaml was a LIE: it advertised a bundled Postgres, Chart.yaml
 * carried no such dependency, and no template rendered one. `postgresql.enabled=true` deployed
 * NOTHING, and the shipped default (store=postgres, postgresql.enabled=false, an empty
 * externalDatabase.url) installed cleanly and then crash-looped the server on
 * `DNSException: getaddrinfo ENOTFOUND` — observed live on the operator's cluster after a k3s
 * reinstall, an hour of downtime, and only ever "worked" because of an undocumented hand-applied
 * companion manifest.
 *
 * Two layers of pinning, boot-splash style:
 *   - file pins on values.yaml / postgres.yaml / _helpers.tpl — the seams, run everywhere;
 *   - real `helm template` renders in every posture, incl. the fail-fast ones — run wherever helm
 *     is installed (CI + dev boxes), skipped cleanly elsewhere.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p: string[]): string => readFileSync(resolve(repoRoot, ...p), "utf8");
const CHART_DIR = resolve(repoRoot, "deploy", "helm", "polyptic");

const VALUES = read("deploy", "helm", "polyptic", "values.yaml");
const POSTGRES = read("deploy", "helm", "polyptic", "templates", "postgres.yaml");
const HELPERS = read("deploy", "helm", "polyptic", "templates", "_helpers.tpl");
const DEPLOYMENT = read("deploy", "helm", "polyptic", "templates", "deployment.yaml");

describe("the bundled database's seams (file pins)", () => {
  test("the values that advertise a database are backed by a template that renders one", () => {
    // The whole bug in one assertion: `postgresql:` existed, `kind: StatefulSet` did not.
    expect(VALUES).toContain("\npostgresql:\n");
    expect(POSTGRES).toContain("kind: StatefulSet");
    expect(POSTGRES).toContain("kind: Service");
  });

  test("batteries included: postgresql.enabled defaults TRUE", () => {
    const block = VALUES.slice(VALUES.indexOf("\npostgresql:"), VALUES.indexOf("\nexternalDatabase:"));
    expect(block).toMatch(/\n {2}enabled: true\n/);
    // …and no weak literal password ships in the values file.
    expect(block).toMatch(/\n {4}password: ""\n/);
    expect(block).not.toMatch(/\n\s+password: polyptic\n/);
  });

  test("the password is generated + preserved exactly like the cookie secret", () => {
    const body = HELPERS.slice(HELPERS.indexOf('{{- define "polyptic.postgresqlPassword" -}}'));
    const helper = body.slice(0, body.indexOf("{{- end }}\n{{/*"));
    expect(helper).toContain('lookup "v1" "Secret"'); // preserve across upgrade
    expect(helper).toContain("randAlphaNum 32"); // generate on first install
  });

  test("the bundled password is never baked into a rendered connection string", () => {
    // It rides as POSTGRES_PASSWORD from the Secret and the kubelet expands $(VAR) in the pod.
    expect(HELPERS).toContain("postgres://%s:$(POSTGRES_PASSWORD)@%s:%d/%s");
    expect(DEPLOYMENT).toContain('include "polyptic.postgresql.envUrl"');
  });

  test("data survives: a volumeClaimTemplate, plus an existingClaim adoption path", () => {
    expect(POSTGRES).toContain("volumeClaimTemplates:");
    expect(POSTGRES).toContain("persistence.existingClaim");
    // PGDATA in a subdirectory — initdb refuses a mount root that has a lost+found in it.
    expect(POSTGRES).toContain("/var/lib/postgresql/data/pgdata");
    // pg_isready, not a TCP probe: the port listens long before the database answers.
    expect(POSTGRES).toContain("pg_isready");
  });
});

// ── Real renders, wherever helm exists. ─────────────────────────────────────────────────────────
const helmAvailable = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;

/** Render the chart with `--set` pairs; asserts success and returns the multi-doc YAML. */
function render(...sets: string[]): string {
  const out = spawnSync("helm", ["template", "polyptic", CHART_DIR, ...sets.flatMap((s) => ["--set", s])], {
    encoding: "utf8",
  });
  expect(out.status).toBe(0);
  return out.stdout;
}

/** Render expecting a REFUSAL; returns stderr. */
function refuse(...sets: string[]): string {
  const out = spawnSync("helm", ["template", "polyptic", CHART_DIR, ...sets.flatMap((s) => ["--set", s])], {
    encoding: "utf8",
  });
  expect(out.status).not.toBe(0);
  return out.stderr;
}

describe.skipIf(!helmAvailable)("helm template — every database posture", () => {
  test("a bare install deploys the database AND points the server at it (the one-command promise)", () => {
    const doc = render();
    expect(doc).toMatch(/kind: StatefulSet\nmetadata:\n {2}name: polyptic-db/);
    expect(doc).toMatch(/kind: Service\nmetadata:\n {2}name: polyptic-db/);
    expect(doc).toContain("image: \"postgres:16-alpine\"");
    // The server's DATABASE_URL resolves the bundled Service by name; the password is expanded
    // in the pod from the Secret, never rendered into the string.
    expect(doc).toContain('value: "postgres://polyptic:$(POSTGRES_PASSWORD)@polyptic-db:5432/polyptic"');
    expect(doc).not.toContain("$(POSTGRES_PASSWORD)@polyptic-db:5432/polyptic\"\n  DATABASE_URL");
    // A generated 32-char password landed in the chart's Secret.
    expect(doc).toMatch(/POSTGRES_PASSWORD: "[A-Za-z0-9]{32}"/);
    // Persistent by default.
    expect(doc).toContain("volumeClaimTemplates:");
    expect(doc).toContain('storage: "8Gi"');
  });

  test("an explicit password is used verbatim; an existingSecret is referenced, never read", () => {
    const explicit = render("postgresql.auth.password=hunter2hunter2");
    expect(explicit).toContain('POSTGRES_PASSWORD: "hunter2hunter2"');

    const byRef = render("postgresql.auth.existingSecret=my-db-secret", "postgresql.auth.existingSecretPasswordKey=pw");
    expect(byRef).toContain("name: my-db-secret");
    expect(byRef).toContain("key: pw");
    // The chart's own Secret carries no password when one is supplied out-of-band.
    expect(byRef).not.toContain("POSTGRES_PASSWORD: ");
  });

  test("adopting an existing PVC (the hand-rolled polyptic-db claim) mounts it instead of minting one", () => {
    const doc = render("postgresql.persistence.existingClaim=polyptic-db");
    expect(doc).toContain("claimName: polyptic-db");
    expect(doc).not.toContain("volumeClaimTemplates:");
  });

  test("an external database still works — and nothing bundled renders", () => {
    const doc = render("postgresql.enabled=false", "externalDatabase.url=postgres://u:p@pg.example:5432/polyptic");
    expect(doc).not.toContain("polyptic-db");
    expect(doc).not.toContain("postgres:16-alpine");
    expect(doc).toContain('DATABASE_URL: "postgres://u:p@pg.example:5432/polyptic"');
    // The server still reads it from the Secret, as before.
    expect(doc).toContain("key: DATABASE_URL");
  });

  test("STORE=memory deploys no database at all (a pod nobody talks to is not a default)", () => {
    const doc = render("config.store=memory", "postgresql.enabled=false");
    expect(doc).not.toContain("polyptic-db");
    // Even with the bundled DB left ON, memory means no database is stood up.
    expect(render("config.store=memory")).not.toContain("polyptic-db");
  });

  test("REFUSAL: two databases at once", () => {
    const err = refuse("externalDatabase.url=postgres://u:p@pg.example:5432/polyptic");
    expect(err).toContain("TWO databases are configured");
    expect(err).toContain("postgresql.enabled=false");
  });

  test("REFUSAL: store=postgres with no database — the exact combination that crash-looped", () => {
    const err = refuse("postgresql.enabled=false");
    expect(err).toContain("NO database is configured");
    expect(err).toContain("crash-loop");
  });

  test("REFUSAL: an unknown store backend", () => {
    expect(refuse("config.store=sqlite")).toContain("config.store must be");
  });

  test("the escape hatches are NOT refusals: a DATABASE_URL from an existingSecret / extraEnv", () => {
    const bySecret = render("postgresql.enabled=false", "secrets.existingSecret=polyptic-prod");
    expect(bySecret).toContain("name: polyptic-prod");
    const byEnv = render(
      "postgresql.enabled=false",
      "extraEnv[0].name=DATABASE_URL",
      "extraEnv[0].value=postgres://u:p@pg:5432/polyptic",
    );
    expect(byEnv).toContain("postgres://u:p@pg:5432/polyptic");
  });
});

// ── POL-127: the StatefulSet must survive a version bump. ────────────────────────────────────────
//
// `volumeClaimTemplates` is an IMMUTABLE field of a StatefulSet spec. POL-123 rendered the full
// label set into it — including `helm.sh/chart` and `app.kubernetes.io/version`, which change on
// EVERY release — so the first `helm upgrade` after a version bump was a forbidden patch and the
// release wedged in `failed`. Caught for real on v0.2.32 → v0.2.33: the fresh-install path we had
// tested never exercises a patch, so nothing saw it until an upgrade happened.

/** The one rendered document of the given kind, as its own string. */
function doc(rendered: string, kind: string): string {
  const found = rendered
    .split(/^---$/m)
    .filter((d) => new RegExp(`^kind: ${kind}$`, "m").test(d) && /name: polyptic-db/.test(d));
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** The `volumeClaimTemplates:` block of the rendered polyptic-db StatefulSet, verbatim. */
function pvcTemplateBlock(rendered: string): string {
  const sts = doc(rendered, "StatefulSet");
  const start = sts.indexOf("  volumeClaimTemplates:");
  expect(start).toBeGreaterThan(-1);
  return sts.slice(start).trimEnd();
}

/** Render the chart with Chart.yaml's version/appVersion rewritten — what a new release looks like. */
function renderAtVersion(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "polyptic-chart-"));
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

describe("the database survives an upgrade (POL-127)", () => {
  test("the PVC template is built from STABLE labels, never the version-carrying set", () => {
    // The seam. `polyptic.labels` embeds helm.sh/chart + app.kubernetes.io/version; using it inside
    // volumeClaimTemplates is what made every upgrade a forbidden patch.
    const block = POSTGRES.slice(POSTGRES.indexOf("volumeClaimTemplates:"));
    expect(block).toContain('include "polyptic.selectorLabels"');
    expect(block).not.toContain('include "polyptic.labels"');
  });

  test("selectorLabels really is version-free (the property the fix leans on)", () => {
    const helper = HELPERS.slice(HELPERS.indexOf('define "polyptic.selectorLabels"'));
    const body = helper.slice(0, helper.indexOf("{{- end }}"));
    expect(body).not.toContain("helm.sh/chart");
    expect(body).not.toContain("app.kubernetes.io/version");
  });
});

describe.skipIf(!helmAvailable)("the database survives an upgrade — real renders (POL-127)", () => {
  test("the PVC template is byte-identical across two chart versions", () => {
    // THE WHOLE BUG, IN ONE ASSERTION. If these ever differ again, `helm upgrade` starts failing
    // with "updates to statefulset spec ... are forbidden" and the release wedges.
    expect(pvcTemplateBlock(renderAtVersion("9.9.9"))).toBe(pvcTemplateBlock(renderAtVersion("0.0.1")));
  });

  test("no version-varying label reaches the PVC template", () => {
    const block = pvcTemplateBlock(renderAtVersion("9.9.9"));
    expect(block).not.toContain("helm.sh/chart");
    expect(block).not.toContain("app.kubernetes.io/version");
    // …while the identifying labels an operator selects on are still there.
    expect(block).toContain("app.kubernetes.io/name: polyptic");
    expect(block).toContain("app.kubernetes.io/component: database");
  });

  test("the component label is not duplicated (polyptic.labels used to smuggle in component: server)", () => {
    const block = pvcTemplateBlock(renderAtVersion("9.9.9"));
    const components = block.match(/app\.kubernetes\.io\/component:/g) ?? [];
    expect(components).toHaveLength(1);
  });

  test("the version labels still land where they are harmless: the StatefulSet's own metadata", () => {
    // We are not throwing the provenance labels away — an operator still wants to see which chart
    // version owns this object. Top-level metadata is mutable, so it is the right home for them.
    // (The pod template happens to carry only the stable set already, which is why the pod spec was
    // never the thing blocking the upgrade — the PVC template was.)
    const sts = doc(renderAtVersion("9.9.9"), "StatefulSet");
    const ownMetadata = sts.slice(0, sts.indexOf("spec:"));
    expect(ownMetadata).toContain("helm.sh/chart: polyptic-9.9.9");
    expect(ownMetadata).toContain('app.kubernetes.io/version: "v9.9.9"');
  });
});
