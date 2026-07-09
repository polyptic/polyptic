/**
 * deploy/k8s-run-job.ts — the IMAGE_REBUILD_CMD / IMAGE_FULL_REBUILD_CMD hook for Kubernetes
 * (POL-43). The POL-41 contract says the rebuild hook is a COMMAND the server shells out to; in a
 * cluster that command is this script: create a privileged rebuild Job from a chart-rendered
 * template, wait for it, and relay its logs + exit status back to the server's Settings card.
 *
 *   IMAGE_REBUILD_CMD="bun deploy/k8s-run-job.ts refresh"
 *   IMAGE_FULL_REBUILD_CMD="bun deploy/k8s-run-job.ts full"
 *
 * The Helm chart renders the two Job manifests into a ConfigMap mounted at
 * POLYPTIC_JOB_TEMPLATE_DIR (default /etc/polyptic/jobs): refresh.json (nightly in-place apt
 * refresh, kernel held) and full.json (weekly rebuild from the base ISO — the kernel-CVE cycle).
 * Both templates run privileged (chroot + loop mounts) with the image-depot PVC mounted, and carry
 * ttlSecondsAfterFinished so Kubernetes garbage-collects finished Jobs.
 *
 * Talks to the API server directly with the pod's ServiceAccount (token + CA from the usual
 * projected volume) via Bun's fetch — no kubectl in the image. RBAC needed: create/get jobs,
 * list pods, get pods/log (see the chart's role.yaml).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const TEMPLATE_DIR = process.env.POLYPTIC_JOB_TEMPLATE_DIR?.trim() || "/etc/polyptic/jobs";
/** Bounded below the server's 45-minute hook killer so THIS process reports the timeout. */
const WAIT_TIMEOUT_MS = 40 * 60 * 1000;
const POLL_MS = 10 * 1000;
const LOG_TAIL_LINES = 120;

const kind = process.argv[2];
if (kind !== "refresh" && kind !== "full") {
  console.error("usage: bun deploy/k8s-run-job.ts <refresh|full>");
  process.exit(2);
}

const token = readFileSync(join(SA_DIR, "token"), "utf8").trim();
const ca = readFileSync(join(SA_DIR, "ca.crt"), "utf8");
const namespace = readFileSync(join(SA_DIR, "namespace"), "utf8").trim();
const apiBase = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT ?? "443"}`;

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${apiBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    // Bun extension: pin the cluster CA instead of the system trust store.
    tls: { ca },
  } as RequestInit);
}

const template = JSON.parse(readFileSync(join(TEMPLATE_DIR, `${kind}.json`), "utf8")) as {
  metadata: { name?: string; generateName?: string; [k: string]: unknown };
  [k: string]: unknown;
};
// Unique per run; generateName keeps concurrent-history names readable (polyptic-image-refresh-xxxxx).
delete template.metadata.name;
template.metadata.generateName = `polyptic-image-${kind}-`;

const created = await api("POST", `/apis/batch/v1/namespaces/${namespace}/jobs`, template);
if (!created.ok) {
  console.error(`failed to create ${kind} job: HTTP ${created.status} ${await created.text()}`);
  process.exit(1);
}
const jobName = ((await created.json()) as { metadata: { name: string } }).metadata.name;
console.log(`created job ${namespace}/${jobName} (${kind})`);

let succeeded = false;
const deadline = Date.now() + WAIT_TIMEOUT_MS;
for (;;) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  const res = await api("GET", `/apis/batch/v1/namespaces/${namespace}/jobs/${jobName}`);
  if (!res.ok) {
    console.error(`job status poll failed: HTTP ${res.status}`);
    continue; // transient API blips must not fail a 15-minute build
  }
  const status = ((await res.json()) as { status?: { succeeded?: number; failed?: number } }).status ?? {};
  if ((status.succeeded ?? 0) > 0) {
    succeeded = true;
    break;
  }
  // Templates set backoffLimit: 0 — one failed pod IS the verdict.
  if ((status.failed ?? 0) > 0) break;
  if (Date.now() > deadline) {
    console.error(`job ${jobName} still running after ${WAIT_TIMEOUT_MS / 60000} minutes — giving up (job left for inspection)`);
    break;
  }
}

// Relay the pod log tail so apt's verdict / the failure lands in the Settings card.
try {
  const pods = await api(
    "GET",
    `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(`job-name=${jobName}`)}`,
  );
  const items = ((await pods.json()) as { items: { metadata: { name: string } }[] }).items ?? [];
  for (const pod of items) {
    const log = await api(
      "GET",
      `/api/v1/namespaces/${namespace}/pods/${pod.metadata.name}/log?tailLines=${LOG_TAIL_LINES}`,
    );
    if (log.ok) {
      console.log(`--- ${pod.metadata.name} (last ${LOG_TAIL_LINES} lines) ---`);
      console.log(await log.text());
    }
  }
} catch (err) {
  console.error(`log relay failed (job outcome unaffected): ${(err as Error).message}`);
}

console.log(`job ${jobName}: ${succeeded ? "SUCCEEDED" : "FAILED"}`);
process.exit(succeeded ? 0 : 1);
