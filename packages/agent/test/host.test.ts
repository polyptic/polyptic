/**
 * Unit tests for the host reboot guard (packages/agent/src/host.ts) — WHETHER this box may reboot.
 *
 * The headline case is the one that would be embarrassing to get wrong: `dev-open` is the laptop
 * backend, so a `server/reboot` aimed at a developer running `bun run dev` must power-cycle NOTHING.
 * The same goes for any non-Linux host. Both refuse, and the reason travels back to the console.
 *
 * `rebootRefusal` is deliberately pure — it touches no filesystem and spawns no process — so the
 * decision is testable without a systemd, a /run, or a machine we are willing to lose.
 */
import { describe, expect, test } from "bun:test";

import { REBOOT_REQUEST_DIR, REBOOT_REQUEST_PATH, rebootHost, rebootRefusal } from "../src/host";
import {
  REBOOT_REQUEST_DIR as SETUP_REQUEST_DIR,
  REBOOT_REQUEST_PATH as SETUP_REQUEST_PATH,
  rebootPathUnit,
  rebootServiceUnit,
  rebootTmpfilesConf,
} from "../src/setup/templates";

describe("rebootRefusal — which hosts may be rebooted", () => {
  test("dev-open NEVER reboots, on any platform: it is a developer's own machine", () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      const refusal = rebootRefusal("dev-open", platform);
      expect(refusal).toBeString();
      expect(refusal).toContain("dev-open");
    }
  });

  test("a real backend on a non-Linux host refuses, naming the platform", () => {
    expect(rebootRefusal("wayland-sway", "darwin")).toContain("darwin");
    expect(rebootRefusal("x11-i3", "win32")).toContain("win32");
  });

  test("a real backend on Linux is allowed — the only combination a wall box ever has", () => {
    expect(rebootRefusal("wayland-sway", "linux")).toBeNull();
    expect(rebootRefusal("x11-i3", "linux")).toBeNull();
  });
});

describe("rebootHost — never throws, always explains", () => {
  test("a refused reboot resolves (not rejects) with accepted=false and a reason", async () => {
    const outcome = await rebootHost("dev-open");
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toContain("dev-open");
  });
});

describe("the privileged helper's contract with setup", () => {
  // These paths are the ENTIRE interface between the unprivileged agent and the root-owned
  // polyptic-reboot.path unit. If setup's templates and this constant ever drift apart, the agent
  // writes a request nothing is watching for and the reboot silently does nothing.
  test("the request file lives inside the request directory", () => {
    expect(REBOOT_REQUEST_PATH.startsWith(`${REBOOT_REQUEST_DIR}/`)).toBe(true);
  });

  test("the request directory is under /run, so a request cannot survive the reboot it caused", () => {
    expect(REBOOT_REQUEST_DIR.startsWith("/run/")).toBe(true);
  });

  test("the agent and setup agree on the paths — drift here is a reboot that silently does nothing", () => {
    expect(SETUP_REQUEST_DIR).toBe(REBOOT_REQUEST_DIR);
    expect(SETUP_REQUEST_PATH).toBe(REBOOT_REQUEST_PATH);
  });

  test("the .path unit watches the exact file the agent writes, and starts the .service that reboots", () => {
    const pathUnit = rebootPathUnit();
    expect(pathUnit).toContain(`PathExists=${REBOOT_REQUEST_PATH}`);
    expect(pathUnit).toContain("Unit=polyptic-reboot.service");

    const service = rebootServiceUnit();
    // The request is consumed before the reboot, so a failed reboot cannot re-arm the .path unit.
    expect(service).toContain(`rm -f ${REBOOT_REQUEST_PATH}`);
    expect(service).toContain("systemctl --no-block reboot");
  });

  test("tmpfiles hands the kiosk user ONLY the request dir — never /run/polyptic, which holds the token", () => {
    const conf = rebootTmpfilesConf("kiosk");
    expect(conf).toContain(`d ${REBOOT_REQUEST_DIR} 0770 root kiosk -`);
    expect(conf).toContain("d /run/polyptic 0755 root root -");
  });
});
