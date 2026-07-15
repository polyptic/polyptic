/**
 * POL-25 — the agent's mTLS identity helpers: keypair+CSR generation (the key must be usable to
 * pair with the cert the server returns), bundle persistence (0600, like the credential), renewal
 * detection, and the wss:// target derivation.
 */
import "reflect-metadata";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  certNeedsRenewal,
  deriveMtlsUrl,
  generateKeyAndCsr,
  loadMtlsBundle,
  mtlsBundlePath,
  saveMtlsBundle,
} from "../src/mtls";

const x509 = await import("@peculiar/x509");
x509.cryptoProvider.set(globalThis.crypto);

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

/** A throwaway self-signed cert with a chosen expiry, for renewal-window checks. */
async function certExpiring(inMs: number): Promise<string> {
  const keys = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=renewal-test",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + inMs),
    signingAlgorithm: ALG,
    keys,
  });
  return cert.toString("pem");
}

describe("generateKeyAndCsr", () => {
  test("produces a verifiable CSR and a PKCS#8 key", async () => {
    const { keyPem, csrPem } = await generateKeyAndCsr("machine-1");
    expect(keyPem).toContain("BEGIN PRIVATE KEY");
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    expect(await csr.verify()).toBe(true);
    expect(csr.subject).toBe("CN=machine-1");
  });

  test("sanitises DN metacharacters in the machine id", async () => {
    const { csrPem } = await generateKeyAndCsr('we,ird+id="x"');
    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    expect(csr.subject).toBe("CN=we_ird_id__x_");
  });
});

describe("mTLS bundle persistence", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips through disk and is written 0600", () => {
    dir = mkdtempSync(join(tmpdir(), "polyptic-mtls-"));
    const env = { POLYPTIC_STATE_DIR: dir } as NodeJS.ProcessEnv;
    const bundle = { keyPem: "KEY", certPem: "CERT", caPem: "CA", url: "wss://host:8443/agent" };

    expect(loadMtlsBundle("m1", env)).toBeNull();
    saveMtlsBundle("m1", bundle, env);
    expect(loadMtlsBundle("m1", env)).toEqual(bundle);

    const mode = statSync(mtlsBundlePath("m1", env)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("an incomplete or corrupt file loads as null (agent falls back to plain enrolment)", () => {
    dir = mkdtempSync(join(tmpdir(), "polyptic-mtls-"));
    const env = { POLYPTIC_STATE_DIR: dir } as NodeJS.ProcessEnv;
    saveMtlsBundle("m1", { keyPem: "K", certPem: "", caPem: "CA", url: "wss://x/agent" }, env);
    expect(loadMtlsBundle("m1", env)).toBeNull();
  });
});

describe("certNeedsRenewal", () => {
  test("false for a fresh cert, true inside the 30-day window, true for expired or garbage", async () => {
    expect(certNeedsRenewal(await certExpiring(365 * 24 * 3600 * 1000))).toBe(false);
    expect(certNeedsRenewal(await certExpiring(10 * 24 * 3600 * 1000))).toBe(true);
    expect(certNeedsRenewal(await certExpiring(-1000))).toBe(true);
    expect(certNeedsRenewal("not a cert")).toBe(true);
  });
});

describe("deriveMtlsUrl", () => {
  test("same host, wss scheme, advertised port, /agent path", () => {
    expect(deriveMtlsUrl("ws://localhost:8080/agent", { port: 8443 })).toBe("wss://localhost:8443/agent");
    expect(deriveMtlsUrl("wss://walls.example.com/agent", { port: 9443 })).toBe(
      "wss://walls.example.com:9443/agent",
    );
    expect(deriveMtlsUrl("ws://10.0.0.5:8080/", { port: 8443 })).toBe("wss://10.0.0.5:8443/agent");
  });

  test("a full URL override wins verbatim (path normalised to /agent when absent)", () => {
    expect(deriveMtlsUrl("ws://localhost:8080/agent", { port: 1, url: "wss://mtls.example.com" })).toBe(
      "wss://mtls.example.com/agent",
    );
    expect(
      deriveMtlsUrl("ws://localhost:8080/agent", { port: 1, url: "wss://mtls.example.com:7443/custom" }),
    ).toBe("wss://mtls.example.com:7443/custom");
  });

  // POL-143 — the homelab regression, verbatim. The box knows its server as polyptic.homelab (:80,
  // the plain boot host); the server ADVERTISES the NodePort it must dial. Reusing the box's own
  // host and swapping in the advertised port is what makes the migration reachable — dialling the
  // pod's :8443 bind port instead (which stock K3s Traefik never routes) is the whole bug.
  test("reuses the box's own host on the server-advertised NodePort (the reachable door)", () => {
    expect(deriveMtlsUrl("ws://polyptic.homelab/agent", { port: 30843 })).toBe(
      "wss://polyptic.homelab:30843/agent",
    );
  });
});
