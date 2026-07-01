/**
 * Output resolution — WHICH outputs this agent advertises on `agent/hello`.
 *
 * Extracted from index.ts so the (pure) resolution logic is unit-testable without importing the
 * reconciler's top-level side effects (config-file seeding, the WS connect in `main()`).
 *
 * Priority order (see `resolveAdvertisedOutputs`):
 *   1. Explicit override — `POLYPTIC_OUTPUTS` (any value, incl. the Phase 3c multi-output dev path)
 *      or a non-empty `POLYPTIC_CONNECTOR` — honoured VERBATIM (Phase 2a/3c behaviour, unchanged).
 *   2. `dev-open` (no compositor to ask) — the configured/default single connector, so a laptop with
 *      no compositor still yields one screen and dev startup stays instant.
 *   3. A real backend — PREFER discovery: ask the compositor for its REAL output names (retrying
 *      briefly while it warms up) and advertise those.
 *   4. A real backend whose compositor reported NOTHING and with no override → advertise ZERO outputs
 *      (POL-9). Guessing "HDMI-1" here is actively harmful: the headless Stage-A system agent enrols
 *      the box BEFORE Stage B installs/starts sway, so there's nothing to discover — a wrong-named
 *      placeholder screen breaks placement ("HDMI-1 is not a known sway output") and lingers next to
 *      the real panels once the kiosk agent later advertises them. No screen until a compositor
 *      reports real outputs.
 */
import type { Output } from "@polyptic/protocol";
import type { DisplayBackend } from "./backends/types";

/** Default advertised connector when `POLYPTIC_CONNECTOR` is unset (dev-open / explicit-override paths). */
export const DEFAULT_CONNECTOR = "HDMI-1";

/** Geometry advertised for a discovered output whose exact mode we don't (yet) re-query. */
const DISCOVERED_OUTPUT_WIDTH = 1920;
const DISCOVERED_OUTPUT_HEIGHT = 1080;
/** Short retry while the compositor (launched alongside the agent) finishes warming up (~5s). */
export const DISCOVERY_ATTEMPTS = 5;
export const DISCOVERY_RETRY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Options for output resolution — all defaulted so production callers pass only what they override. */
export interface ResolveOutputsOptions {
  /** Environment to read overrides from (defaults to `process.env`; injectable for tests). */
  env?: NodeJS.ProcessEnv;
  /** Progress logger (defaults to a no-op so unit tests stay quiet). */
  log?: (msg: string) => void;
  /** Discovery retry count (defaults to `DISCOVERY_ATTEMPTS`; small values keep tests fast). */
  attempts?: number;
  /** Delay between discovery attempts in ms (defaults to `DISCOVERY_RETRY_MS`; 0 in tests). */
  retryMs?: number;
}

/**
 * The advertised connector for this agent's single default output. Overridable via
 * `POLYPTIC_CONNECTOR` so two agents on one box present distinct screens.
 */
export function resolveConnector(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.POLYPTIC_CONNECTOR?.trim();
  return override && override.length > 0 ? override : DEFAULT_CONNECTOR;
}

/**
 * The explicitly-configured outputs.
 *
 * Phase 3c: if `POLYPTIC_OUTPUTS` is set (comma-separated connector names) this agent advertises one
 * 1920×1080 output per connector — so a single `bun run dev` can yield ≥2 screens for a local
 * video-wall demo. Blank entries are trimmed/skipped and duplicates de-duped (first wins). If the
 * variable is unset or yields no usable connector, fall back to the single default output on the
 * resolved connector — Phase 1/2a behaviour, unchanged.
 */
export function resolveOutputs(
  defaultConnector: string,
  env: NodeJS.ProcessEnv = process.env,
): Output[] {
  const raw = env.POLYPTIC_OUTPUTS;
  if (raw !== undefined) {
    const seen = new Set<string>();
    const outputs: Output[] = [];
    for (const part of raw.split(",")) {
      const connector = part.trim();
      if (connector.length === 0 || seen.has(connector)) continue;
      seen.add(connector);
      outputs.push({ connector, width: 1920, height: 1080 });
    }
    if (outputs.length > 0) return outputs;
  }
  return [{ connector: defaultConnector, width: 1920, height: 1080 }];
}

/**
 * Has the operator/dev pinned the advertised outputs explicitly? `POLYPTIC_OUTPUTS` (any value,
 * including the Phase 3c multi-output dev path) or a non-empty `POLYPTIC_CONNECTOR` is treated as an
 * OVERRIDE and honoured verbatim — discovery is then skipped so behaviour is exactly as before.
 */
export function hasExplicitOutputOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.POLYPTIC_OUTPUTS !== undefined) return true;
  const connector = env.POLYPTIC_CONNECTOR?.trim();
  return connector !== undefined && connector.length > 0;
}

/**
 * Ask the backend's compositor what outputs really exist, retrying briefly: the agent is launched
 * by sway, but sway may still be warming up at hello time. Returns the real connector names, or
 * `null` if every attempt yielded nothing (compositor unavailable / no outputs).
 */
export async function discoverOutputsWithRetry(
  backend: DisplayBackend,
  opts: ResolveOutputsOptions = {},
): Promise<string[] | null> {
  const attempts = opts.attempts ?? DISCOVERY_ATTEMPTS;
  const retryMs = opts.retryMs ?? DISCOVERY_RETRY_MS;
  const log = opts.log ?? (() => {});
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let names: string[] | null = null;
    try {
      names = await backend.discoverOutputs();
    } catch (err) {
      log(`output discovery attempt ${attempt}/${attempts} errored: ${(err as Error).message}`);
    }
    if (names && names.length > 0) return names;
    if (attempt < attempts) await sleep(retryMs);
  }
  return null;
}

/**
 * The outputs to advertise on `agent/hello`, in priority order (see the module header for the full
 * rationale):
 *   1. Explicit override → honoured verbatim.
 *   2. `dev-open` (no compositor) → the configured/default single connector.
 *   3. Real backend + discovery yields outputs → those real connector names.
 *   4. Real backend + no override + discovery yields NOTHING → ZERO outputs (no screen). POL-9: never
 *      guess "HDMI-1" for a box whose compositor isn't up yet.
 */
export async function resolveAdvertisedOutputs(
  backend: DisplayBackend,
  defaultConnector: string,
  opts: ResolveOutputsOptions = {},
): Promise<Output[]> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});

  if (hasExplicitOutputOverride(env)) {
    const outputs = resolveOutputs(defaultConnector, env);
    log(
      `advertising ${outputs.length} explicitly configured output(s): ${outputs
        .map((o) => o.connector)
        .join(", ")}`,
    );
    return outputs;
  }

  // dev-open has no compositor to interrogate: skip the (retrying) discovery entirely and advertise
  // the configured/default connector — keeping dev startup instant and a laptop with no compositor
  // still yields one screen to drive.
  if (backend.id === "dev-open") {
    const outputs = resolveOutputs(defaultConnector, env);
    log(`dev-open backend: advertising default connector ${defaultConnector}`);
    return outputs;
  }

  // A real backend sits right next to a compositor — ask it for the REAL outputs.
  const discovered = await discoverOutputsWithRetry(backend, opts);
  if (discovered && discovered.length > 0) {
    log(`advertising ${discovered.length} discovered output(s): ${discovered.join(", ")}`);
    return discovered.map((connector) => ({
      connector,
      width: DISCOVERED_OUTPUT_WIDTH,
      height: DISCOVERED_OUTPUT_HEIGHT,
    }));
  }

  // POL-9: real backend, no explicit override, and the compositor reported nothing — it isn't up yet
  // (e.g. the headless Stage-A system agent enrolling before Stage B installs/starts sway). Advertise
  // ZERO outputs rather than a guessed "HDMI-1": a wrong-named placeholder screen breaks placement
  // and lingers next to the real panels once the kiosk agent later advertises them.
  log(
    "no compositor outputs discovered and no explicit override — advertising zero outputs " +
      "(no screen until a compositor reports real outputs)",
  );
  return [];
}
