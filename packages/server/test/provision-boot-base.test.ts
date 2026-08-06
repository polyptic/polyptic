/**
 * POL-193 — POLYPTIC_BOOT_BASE, the address the served boot menu tells boxes to come back to.
 *
 * Empty is the default and keeps the request-derived behaviour, which is what heals a moved control
 * plane on the next boot. It is set when the request CANNOT carry the truth: a depot on a
 * non-default port, where GRUB sends `Host:` without one and Traefik computes X-Forwarded-Port from
 * that same header — so the real port reaches the pod through no channel at all (POL-192).
 *
 * A malformed value is fatal at config time on purpose: this string is the only address a diskless
 * box is given, so a wrong one strands the fleet, and failing at deploy is the cheap end of that.
 */
import { describe, expect, test } from "bun:test";

import { buildBootGrubCfg, provisionConfigFromEnv } from "../src/provision";

describe("POLYPTIC_BOOT_BASE resolution (POL-193)", () => {
  test("unset or blank means empty — derive from the request, as before", () => {
    expect(provisionConfigFromEnv({}).bootBase).toBe("");
    expect(provisionConfigFromEnv({ POLYPTIC_BOOT_BASE: "" }).bootBase).toBe("");
    expect(provisionConfigFromEnv({ POLYPTIC_BOOT_BASE: "   " }).bootBase).toBe("");
  });

  test("a host and port survive intact — the whole point of the setting", () => {
    expect(
      provisionConfigFromEnv({ POLYPTIC_BOOT_BASE: "http://polyptic-boot.example:8081" }).bootBase,
    ).toBe("http://polyptic-boot.example:8081");
  });

  test("surrounding whitespace and trailing slashes are normalised away", () => {
    expect(
      provisionConfigFromEnv({ POLYPTIC_BOOT_BASE: "  http://boot.example:8081/  " }).bootBase,
    ).toBe("http://boot.example:8081");
  });

  test("a default port is not carried — :80 on http is noise in a URL", () => {
    expect(provisionConfigFromEnv({ POLYPTIC_BOOT_BASE: "http://boot.example:80" }).bootBase).toBe(
      "http://boot.example",
    );
  });

  test("a malformed value is FATAL — a wrong address strands every box at the kernel fetch", () => {
    for (const bad of ["not a url", "//boot.example"]) {
      expect(() => provisionConfigFromEnv({ POLYPTIC_BOOT_BASE: bad })).toThrow(
        /POLYPTIC_BOOT_BASE is not a URL/,
      );
    }
  });

  test("a wrong scheme AND a missing one are both told the form we want", () => {
    // `boot.example:8081` parses — as a URL whose scheme is `boot.example:` — so the message has to
    // work for someone who forgot the scheme, not just someone who picked the wrong one.
    for (const bad of ["ftp://boot.example", "boot.example:8081"]) {
      expect(() => provisionConfigFromEnv({ POLYPTIC_BOOT_BASE: bad })).toThrow(
        /must be http:\/\/host\[:port\]/,
      );
    }
  });

  test("a path is refused — the boot depot lives at the server root", () => {
    for (const bad of ["http://boot.example/depot", "http://boot.example/?x=1", "http://b.ex/#f"]) {
      expect(() => provisionConfigFromEnv({ POLYPTIC_BOOT_BASE: bad })).toThrow(/must carry no path/);
    }
  });
});

describe("the menu built from an explicit boot base (POL-193)", () => {
  const BASE = "http://polyptic-boot.example:8081";

  test("every fetch in the menu carries the port, including GRUB's net device", () => {
    const cfg = buildBootGrubCfg(BASE, "TOKEN");
    // GRUB's device syntax is (http,HOST:PORT); everything else is $net-relative.
    expect(cfg).toContain("set net=(http,polyptic-boot.example:8081)");
    // …and nothing anywhere points at the bare host, which is where :80 would answer.
    expect(cfg).not.toMatch(/\(http,polyptic-boot\.example\)/);
  });

  test("the agent's WebSocket inherits the port too — same host, same door", () => {
    const cfg = buildBootGrubCfg(BASE, "TOKEN");
    expect(cfg).toContain("polyptic.server_url=ws://polyptic-boot.example:8081/agent");
  });

  test("the NTP stamp still drops the port — 123 is the client's, not the depot's", () => {
    const cfg = buildBootGrubCfg(BASE, "TOKEN");
    expect(cfg).toContain("polyptic.ntp=polyptic-boot.example");
    expect(cfg).not.toContain("polyptic.ntp=polyptic-boot.example:8081");
  });
});
