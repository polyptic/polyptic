/**
 * The boot medium never lies about itself — POL-122.
 *
 * Two very different sticks share one filename (`polyptic-boot.img`) at one URL: the FULL universal
 * medium (local payload per arch + Wi-Fi config — boots a screen with no cable) and the LEAN one
 * (`LEAN=1`: wired netboot only). Nothing about the file said which it was, so the helm Job could —
 * and on every fresh install DID — quietly publish the crippled one, and the console offered it as
 * "Download bootloader". Three copies of the intent now have to agree: a helm template, a shell
 * script, and the server. These tests are the join.
 *
 * (The HTTP route that serves the medium lives in netboot.e2e.test.ts, with the rest of the depot.)
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync, closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BootMediumManifest } from "@polyptic/protocol";

import { resolveBootMedium, provisionBootSummary } from "../server/src/provision";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p: string[]): string => readFileSync(resolve(repoRoot, ...p), "utf8");

const JOB = read("deploy", "helm", "polyptic", "templates", "boot-medium-job.yaml");
const BUILD_SH = read("deploy", "build-boot-medium.sh");
const WRITE_MANIFEST_SH = resolve(repoRoot, "deploy", "write-boot-manifest.sh");

const MiB = 1024 * 1024;

/** A throwaway BOOT_DIST_DIR holding a sparse `polyptic-boot.img` of `sizeMiB` and, optionally, a manifest. */
function depot(sizeMiB: number, manifest?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "polyptic-boot-"));
  const img = join(dir, "polyptic-boot.img");
  closeSync(openSync(img, "w"));
  truncateSync(img, sizeMiB * MiB); // sparse: a 400 MiB "image" costs no disk and no time
  if (manifest !== undefined) writeFileSync(join(dir, "polyptic-boot.json"), JSON.stringify(manifest));
  return dir;
}

describe("the helm Job never bakes a LEAN medium behind the operator's back", () => {
  // The bug: an empty depot (i.e. EVERY fresh install) took a deliberate LEAN=1 fallback, so the
  // first medium a new deployment ever published was the wired-only one — indistinguishable from
  // the real thing once downloaded, and unable to boot a Wi-Fi screen.
  const script = JOB.slice(JOB.indexOf("containers:"));

  test("the Job's build command never sets LEAN", () => {
    expect(script).not.toMatch(/LEAN\s*=/);
    expect(script).not.toMatch(/\blean=/);
  });

  test("an empty depot SKIPS the bake and exits 0 — publishing nothing beats publishing a lie", () => {
    // The probe stays (it is how we know the depot is empty); what changes is the conclusion.
    expect(script).toContain("initrd-wifi");
    const guard = script.slice(script.indexOf("initrd-wifi"));
    expect(guard).toContain("exit 0");
    // and it says what is missing + what unblocks it, in that same breath.
    expect(guard).toMatch(/Full rebuild/);
    expect(guard).toMatch(/helm upgrade/);
  });

  test("still publishes the whole boot dist — image AND its manifest ride to the depot together", () => {
    // The manifest is only useful if it lands next to the image the server serves.
    expect(script).toContain("cp -f /repo/deploy/dist/boot/* /depot/boot/");
  });
});

describe("build-boot-medium.sh — the medium describes itself", () => {
  test("LEAN survives ONLY as an explicit, documented escape hatch", () => {
    // Deliberate: someone who genuinely wants a wired-only dongle can still ask for one by name.
    expect(BUILD_SH).toContain('LEAN="${LEAN:-0}"');
    expect(BUILD_SH).toMatch(/ESCAPE HATCH/);
  });

  test("writes the sidecar manifest beside the image, from the script the server's contract pins", () => {
    expect(BUILD_SH).toContain('MANIFEST="$DIST/polyptic-boot.json"');
    expect(BUILD_SH).toContain('sh "$HERE/write-boot-manifest.sh" "$MANIFEST"');
  });

  test("the manifest ships in the server image, so the in-cluster Job can run it", () => {
    // The Job copies /app/deploy/. from the server image: a script that isn't COPY'd isn't there.
    const dockerfile = read("deploy", "server.Dockerfile");
    expect(dockerfile).toContain("deploy/write-boot-manifest.sh");
  });
});

describe("write-boot-manifest.sh — run for real, parsed by the real contract", () => {
  // Executed, not grepped: the whole point is that what the shell emits is what zod accepts.
  function run(args: string[]): { status: number | null; stderr: string; json: unknown } {
    const dir = mkdtempSync(join(tmpdir(), "polyptic-manifest-"));
    const out = join(dir, "polyptic-boot.json");
    const r = spawnSync("sh", [WRITE_MANIFEST_SH, out, ...args], { encoding: "utf8" });
    let json: unknown = undefined;
    try {
      json = JSON.parse(readFileSync(out, "utf8"));
    } catch {
      // left undefined — the assertions below say what that means
    }
    rmSync(dir, { recursive: true, force: true });
    return { status: r.status, stderr: r.stderr ?? "", json };
  }

  test("a FULL medium reports its arches, image ids and baked token", () => {
    const { status, json } = run([
      "0",
      "medium-20260714T090000Z-ab12cd34",
      "2026-07-14T09:00:00Z",
      "1",
      "402653184",
      "amd64:20260714T090000Z-1bdb6281",
      "arm64:20260714T083000Z-9f0e1a22",
    ]);
    expect(status).toBe(0);
    const m = BootMediumManifest.parse(json); // the SERVER's schema, not a local guess
    expect(m.lean).toBe(false);
    expect(m.arches).toEqual(["amd64", "arm64"]);
    expect(m.imageIds).toEqual({
      amd64: "20260714T090000Z-1bdb6281",
      arm64: "20260714T083000Z-9f0e1a22",
    });
    expect(m.tokenBaked).toBe(true);
    expect(m.mediumId).toBe("medium-20260714T090000Z-ab12cd34");
    expect(m.builtAt).toBe("2026-07-14T09:00:00Z");
    expect(m.bytes).toBe(402653184);
  });

  test("a LEAN medium says so, with no arches and no payload (valid JSON with an EMPTY array/object)", () => {
    const { status, json } = run(["1", "medium-x", "2026-07-14T09:00:00Z", "0", "67108864"]);
    expect(status).toBe(0);
    const m = BootMediumManifest.parse(json);
    expect(m.lean).toBe(true);
    expect(m.arches).toEqual([]);
    expect(m.imageIds).toEqual({});
    expect(m.tokenBaked).toBe(false);
  });

  test("it is POSIX sh with no exotic tools (POL-78: the initramfs shipped no `dirname`)", () => {
    const src = readFileSync(WRITE_MANIFEST_SH, "utf8");
    expect(src.startsWith("#!/bin/sh")).toBe(true);
    // Comments may name the banned tools (they explain why); the CODE may not reach for them.
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toContain("bash");
    for (const tool of ["jq", "python", "bun", "node", "dirname", "realpath", "mapfile"]) {
      expect(code).not.toMatch(new RegExp(`\\b${tool}\\b`));
    }
  });
});

describe("the server tells the truth about what it published", () => {
  test("a medium with a LEAN manifest is reported as lean", async () => {
    const dir = depot(64, { lean: true, arches: [], imageIds: {}, tokenBaked: false, mediumId: "medium-x", builtAt: null, bytes: 67108864 });
    const m = await resolveBootMedium(dir);
    expect(m?.lean).toBe(true);
    expect(m?.selfDescribed).toBe(true);
    expect(m?.arches).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a FULL manifest carries the arches + image ids through to the API surface", async () => {
    const dir = depot(400, {
      lean: false,
      arches: ["amd64", "arm64"],
      imageIds: { amd64: "20260714T090000Z-1bdb6281", arm64: "20260714T083000Z-9f0e1a22" },
      tokenBaked: true,
      mediumId: "medium-y",
      builtAt: "2026-07-14T09:00:00Z",
      bytes: 419430400,
    });
    const m = await resolveBootMedium(dir);
    expect(m?.lean).toBe(false);
    expect(m?.arches).toEqual(["amd64", "arm64"]);
    expect(m?.imageIds.amd64).toBe("20260714T090000Z-1bdb6281");
    expect(m?.tokenBaked).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a manifest-less medium (baked before POL-122) is judged by SIZE — 64 MiB can only be lean", async () => {
    // An operator upgrading has a pre-POL-122 medium sitting on the depot PVC. It still has to be
    // called what it is: the lean medium is a flat 64 MiB, a payload medium is >= 384 MiB.
    const lean = depot(64);
    expect((await resolveBootMedium(lean))?.lean).toBe(true);
    expect((await resolveBootMedium(lean))?.selfDescribed).toBe(false);
    rmSync(lean, { recursive: true, force: true });

    const full = depot(400);
    expect((await resolveBootMedium(full))?.lean).toBe(false);
    expect((await resolveBootMedium(full))?.tokenBaked).toBe(null); // unknown — never claimed
    rmSync(full, { recursive: true, force: true });
  });

  test("a corrupt manifest degrades to the inferred shape — it never takes the download down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polyptic-boot-"));
    closeSync(openSync(join(dir, "polyptic-boot.img"), "w"));
    truncateSync(join(dir, "polyptic-boot.img"), 64 * MiB);
    writeFileSync(join(dir, "polyptic-boot.json"), "{ not json");
    const m = await resolveBootMedium(dir);
    expect(m).not.toBeNull();
    expect(m?.selfDescribed).toBe(false);
    expect(m?.lean).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no medium at all is `none`, and the boot banner distinguishes lean from full", async () => {
    const empty = mkdtempSync(join(tmpdir(), "polyptic-boot-"));
    expect(await resolveBootMedium(empty)).toBeNull();

    const cfg = (bootDistDir: string) => ({
      agentDistDir: join(empty, "agent"),
      imageDistDir: join(empty, "image"),
      bootDistDir,
      publicBaseUrl: "",
      ntpHost: "",
    });
    expect((await provisionBootSummary(cfg(empty))).bootMedium).toBe("none");

    const lean = depot(64);
    expect((await provisionBootSummary(cfg(lean))).bootMedium).toBe("lean");
    const full = depot(400, { lean: false, arches: ["amd64"], imageIds: { amd64: "x" }, tokenBaked: true });
    expect((await provisionBootSummary(cfg(full))).bootMedium).toBe("full");

    for (const d of [empty, lean, full]) rmSync(d, { recursive: true, force: true });
  });
});
