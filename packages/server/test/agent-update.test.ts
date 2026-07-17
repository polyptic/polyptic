/**
 * POL-160 — the SERVER's detection half: given what a box reported on its hello, decide whether to
 * offer a newer agent binary, and with what. This is the decision that turns "we shipped a fix the
 * fleet never received" into "a box on an older agent is told to self-update on its next hello".
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { AgentUpdateService, serveArchFor } from "../src/agent-update";

const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

/** A depot dir holding a fake agent binary for the given arches. */
function depotWith(arches: string[], bytes = "fake-agent-binary"): string {
  const dir = mkdtempSync(join(tmpdir(), "pol160-agentdist-"));
  mkdirSync(dir, { recursive: true });
  for (const arch of arches) writeFileSync(join(dir, `polyptic-agent-${arch}`), bytes);
  return dir;
}

describe("serveArchFor", () => {
  test("maps the runtime/kernel arch names onto the depot's <arch> token", () => {
    expect(serveArchFor("arm64")).toBe("arm64");
    expect(serveArchFor("aarch64")).toBe("arm64");
    expect(serveArchFor("x64")).toBe("amd64");
    expect(serveArchFor("amd64")).toBe("amd64");
    expect(serveArchFor("x86_64")).toBe("amd64");
    expect(serveArchFor("X64")).toBe("amd64"); // case-insensitive
  });
  test("an unknown or absent arch yields null (we never guess a binary)", () => {
    expect(serveArchFor(undefined)).toBeNull();
    expect(serveArchFor("")).toBeNull();
    expect(serveArchFor("riscv64")).toBeNull();
  });
});

describe("AgentUpdateService.offerFor (POL-160)", () => {
  test("a box on an OLDER agent gets an offer with the arch URL, size, and sha256", async () => {
    const bytes = "the-new-binary";
    const dir = depotWith(["arm64"], bytes);
    const svc = new AgentUpdateService(dir, "0.2.41", log);

    const offer = await svc.offerFor("0.2.40", "arm64");
    expect(offer).not.toBeNull();
    expect(offer?.version).toBe("0.2.41");
    expect(offer?.url).toBe("/dist/agent/arm64");
    expect(offer?.sizeBytes).toBe(Buffer.byteLength(bytes));
    expect(offer?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("a box already on the served version gets NO offer (equal is not newer)", async () => {
    const svc = new AgentUpdateService(depotWith(["arm64"]), "0.2.41", log);
    expect(await svc.offerFor("0.2.41", "arm64")).toBeNull();
  });

  test("a box AHEAD of the server gets no offer (never downgrade)", async () => {
    const svc = new AgentUpdateService(depotWith(["arm64"]), "0.2.41", log);
    expect(await svc.offerFor("0.2.42", "arm64")).toBeNull();
  });

  test("no offer when the arch's binary is not on disk (e.g. an arm64-only depot, an amd64 box)", async () => {
    const svc = new AgentUpdateService(depotWith(["arm64"]), "0.2.41", log);
    expect(await svc.offerFor("0.2.40", "x64")).toBeNull(); // amd64 binary missing
  });

  test("no offer for an unknown arch", async () => {
    const svc = new AgentUpdateService(depotWith(["arm64", "amd64"]), "0.2.41", log);
    expect(await svc.offerFor("0.2.40", "riscv64")).toBeNull();
  });

  test("a box that reports no version at all is left alone", async () => {
    const svc = new AgentUpdateService(depotWith(["arm64"]), "0.2.41", log);
    expect(await svc.offerFor(undefined, "arm64")).toBeNull();
    expect(await svc.offerFor("", "arm64")).toBeNull();
  });

  test("a dev server (BUILD_VERSION 0.0.0) never offers — the whole feature is inert in dev", async () => {
    const svc = new AgentUpdateService(depotWith(["arm64"]), "0.0.0", log);
    expect(svc.configured).toBe(false);
    expect(await svc.offerFor("0.2.40", "arm64")).toBeNull();
  });

  test("the sha is computed once and cached across repeated hellos (same mtime/size)", async () => {
    const dir = depotWith(["amd64"], "stable-bytes");
    const svc = new AgentUpdateService(dir, "0.2.41", log);
    const a = await svc.offerFor("0.2.40", "amd64");
    const b = await svc.offerFor("0.2.39", "amd64");
    expect(a?.sha256).toBeDefined();
    expect(a?.sha256).toBe(b?.sha256);
  });
});
