/**
 * POL-148 — the boot cmdline stamps the NTP host the box's timesyncd disciplines to.
 *
 * By default it is the BOOT HOST (the bundled chrony server, reached on UDP/123 via the Traefik
 * route). An explicit host (chart `ntp.clientHost` → env `POLYPTIC_NTP_HOST` → `buildBootGrubCfg`'s
 * third arg) overrides it, so a site points the fleet at its OWN NTP and can turn the bundled server
 * off. Pinned here so the stamp — and the ordering the netboot e2e relies on (ntp BEFORE the token,
 * so `token <splash>$` still matches) — can't silently drift.
 */
import { describe, expect, test } from "bun:test";

import { buildBootGrubCfg, provisionConfigFromEnv } from "../src/provision";

describe("boot cmdline NTP stamp (POL-148)", () => {
  test("defaults to the boot host (bundled server), for both live and verbose entries", () => {
    const cfg = buildBootGrubCfg("http://boot.polyptic.example:8080", undefined);
    // The host only — port 123 is the client default, so the value carries no port.
    const stamps = [...cfg.matchAll(/polyptic\.ntp=(\S+)/g)].map((m) => m[1]);
    expect(stamps.length).toBeGreaterThanOrEqual(2); // live + verbose menu entries
    expect(new Set(stamps)).toEqual(new Set(["boot.polyptic.example"]));
  });

  test("an explicit clientHost overrides the derived boot host", () => {
    const cfg = buildBootGrubCfg("http://boot.polyptic.example", "tok", "ntp.corp.example");
    expect(cfg).toContain("polyptic.ntp=ntp.corp.example");
    expect(cfg).not.toContain("polyptic.ntp=boot.polyptic.example");
  });

  test("ntp stays BEFORE the token so the splash-ordering the netboot e2e pins still holds", () => {
    const cfg = buildBootGrubCfg("http://h", "TOKEN");
    // …polyptic.ntp=h polyptic.token=TOKEN multipath=off quiet splash …
    expect(cfg).toMatch(/polyptic\.ntp=h polyptic\.token=TOKEN multipath=off quiet splash/);
  });

  test("POLYPTIC_NTP_HOST resolves into the provision config (empty → derive)", () => {
    expect(provisionConfigFromEnv({ POLYPTIC_NTP_HOST: "ntp.corp" }).ntpHost).toBe("ntp.corp");
    expect(provisionConfigFromEnv({}).ntpHost).toBe("");
  });
});
