/**
 * Unit tests for output resolution (packages/agent/src/outputs.ts) — WHICH outputs the agent
 * advertises on `agent/hello`.
 *
 * The headline case is POL-9: a REAL backend (wayland-sway / x11-i3) whose compositor reports no
 * outputs, with no explicit override, must advertise ZERO outputs — never a guessed "HDMI-1". The
 * other cases pin the behaviour that must NOT regress: discovery preferred, dev-open falls back to
 * the default connector, and explicit overrides are honoured verbatim (discovery skipped).
 */
import { describe, expect, test } from "bun:test";

import type { DisplayBackend as BackendId } from "@polyptic/protocol";
import type { DisplayBackend } from "../src/backends/types";
import { resolveAdvertisedOutputs, resolveConnector } from "../src/outputs";

/** A backend test double: `id` + a scripted `discoverOutputs`; the placement methods are inert. */
function fakeBackend(
  id: BackendId,
  discover: () => Promise<string[] | null>,
): DisplayBackend & { calls: number } {
  const backend = {
    id,
    calls: 0,
    async discoverOutputs(): Promise<string[] | null> {
      backend.calls += 1;
      return discover();
    },
    async showScreen(): Promise<void> {},
    async hideScreen(): Promise<void> {},
    async showWindow(): Promise<void> {},
    async hideWindow(): Promise<void> {},
    async ident(): Promise<void> {},
    async capture(): Promise<Buffer | null> {
      return null;
    },
  };
  return backend;
}

/** No sleeping between (few) attempts so the tests are instant. */
const fast = { attempts: 1, retryMs: 0, env: {} as NodeJS.ProcessEnv };

describe("resolveAdvertisedOutputs", () => {
  test("real backend: advertises the compositor's REAL discovered connectors", async () => {
    const backend = fakeBackend("wayland-sway", async () => ["Virtual-1", "HDMI-A-1"]);
    const outputs = await resolveAdvertisedOutputs(backend, "HDMI-1", fast);
    expect(outputs.map((o) => o.connector)).toEqual(["Virtual-1", "HDMI-A-1"]);
    expect(outputs.every((o) => o.width === 1920 && o.height === 1080)).toBe(true);
  });

  test("POL-9: real backend + no override + discovery yields NOTHING → zero outputs (no screen)", async () => {
    const backend = fakeBackend("wayland-sway", async () => null);
    const outputs = await resolveAdvertisedOutputs(backend, "HDMI-1", fast);
    expect(outputs).toEqual([]);
    expect(backend.calls).toBe(1); // it did try to discover
  });

  test("POL-9: real backend + no override + discovery returns an EMPTY array → zero outputs", async () => {
    const backend = fakeBackend("x11-i3", async () => []);
    const outputs = await resolveAdvertisedOutputs(backend, "HDMI-1", fast);
    expect(outputs).toEqual([]);
  });

  test("dev-open: no compositor to ask → falls back to the default connector (one screen)", async () => {
    const backend = fakeBackend("dev-open", async () => null);
    const outputs = await resolveAdvertisedOutputs(backend, "HDMI-1", fast);
    expect(outputs).toEqual([{ connector: "HDMI-1", width: 1920, height: 1080 }]);
    expect(backend.calls).toBe(0); // dev-open discovery is skipped entirely
  });

  test("explicit POLYPTIC_CONNECTOR override wins verbatim and skips discovery", async () => {
    // main() composes these: resolveConnector() turns POLYPTIC_CONNECTOR into the defaultConnector.
    const env = { POLYPTIC_CONNECTOR: "DP-9" } as NodeJS.ProcessEnv;
    const backend = fakeBackend("wayland-sway", async () => ["Virtual-1"]);
    const outputs = await resolveAdvertisedOutputs(backend, resolveConnector(env), { ...fast, env });
    expect(outputs).toEqual([{ connector: "DP-9", width: 1920, height: 1080 }]);
    expect(backend.calls).toBe(0); // override short-circuits before discovery
  });

  test("explicit POLYPTIC_OUTPUTS override advertises each connector verbatim (deduped/trimmed)", async () => {
    const backend = fakeBackend("wayland-sway", async () => ["Virtual-1"]);
    const outputs = await resolveAdvertisedOutputs(backend, "HDMI-1", {
      ...fast,
      env: { POLYPTIC_OUTPUTS: "HDMI-1, HDMI-2 ,HDMI-1," } as NodeJS.ProcessEnv,
    });
    expect(outputs.map((o) => o.connector)).toEqual(["HDMI-1", "HDMI-2"]);
    expect(backend.calls).toBe(0);
  });

  test("discovery retries while the compositor warms up, then advertises what it finds", async () => {
    let attempt = 0;
    const backend = fakeBackend("wayland-sway", async () => {
      attempt += 1;
      return attempt < 3 ? [] : ["Virtual-1"];
    });
    const outputs = await resolveAdvertisedOutputs(backend, "HDMI-1", {
      attempts: 5,
      retryMs: 0,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(outputs.map((o) => o.connector)).toEqual(["Virtual-1"]);
    expect(backend.calls).toBe(3);
  });
});
