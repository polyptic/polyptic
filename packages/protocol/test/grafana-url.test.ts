/**
 * POL-175 — structured content-source addresses: the flag composer (controls → Grafana query
 * string), the paste-to-import parser (URL → controls) and the contract guards around
 * `SourceComposition` on sources and bodies. The console's dialog and the server both lean on
 * exactly these functions, so the mapping table lives here as executable truth.
 */
import { describe, expect, test } from "bun:test";

import {
  ContentSource,
  CreateContentSourceBody,
  UpdateContentSourceBody,
  composeQuery,
  composeSourceUrl,
  extractGrafanaFlags,
  gfDefaults,
  gfSummary,
  normalizeComposition,
  parseAddress,
  slugName,
  type GrafanaDisplay,
} from "../src/index";

const gf = (over: Partial<GrafanaDisplay> = {}): GrafanaDisplay => ({ ...gfDefaults(), ...over });

describe("flag composition (controls → query)", () => {
  test("kiosk on, picker off → bare `kiosk`", () => {
    expect(composeQuery(undefined, gf({ kiosk: true, picker: false }))).toBe("?kiosk");
  });

  test("kiosk on, picker on → `kiosk=tv`", () => {
    expect(composeQuery(undefined, gf({ kiosk: true, picker: true }))).toBe("?kiosk=tv");
  });

  test("kiosk off → no kiosk param (and defaults compose to nothing at all)", () => {
    expect(composeQuery(undefined, gf({ kiosk: false }))).toBe("");
  });

  test("custom range → from/to in Grafana syntax", () => {
    expect(composeQuery(undefined, gf({ kiosk: false, range: "custom", from: "now-7d", to: "now" }))).toBe(
      "?from=now-7d&to=now",
    );
  });

  test("inherited range composes nothing even with from/to held in the controls", () => {
    expect(composeQuery(undefined, gf({ kiosk: false, range: "inherit", from: "now-7d", to: "now" }))).toBe("");
  });

  test("non-default refresh and theme compose their params", () => {
    expect(composeQuery(undefined, gf({ kiosk: false, refresh: "5m", theme: "dark" }))).toBe(
      "?refresh=5m&theme=dark",
    );
  });

  test("keep rides first, verbatim, then the flags", () => {
    expect(composeQuery("orgId=1&var-line=A", gf({ kiosk: true, refresh: "30s" }))).toBe(
      "?orgId=1&var-line=A&kiosk&refresh=30s",
    );
  });

  test("the full url is proto://address + query", () => {
    expect(
      composeSourceUrl({
        proto: "https",
        address: "grafana.example.com/d/abc123/factory-overview",
        keep: "orgId=1",
        gf: gf({ kiosk: true, picker: true, theme: "light" }),
      }),
    ).toBe("https://grafana.example.com/d/abc123/factory-overview?orgId=1&kiosk=tv&theme=light");
  });

  test("no keep, no gf → no query at all", () => {
    expect(composeSourceUrl({ proto: "http", address: "intranet.local/status" })).toBe(
      "http://intranet.local/status",
    );
  });
});

describe("parseAddress (paste-to-import)", () => {
  test("strips the scheme into proto and the query into pairs", () => {
    const p = parseAddress("https://grafana.example.com/d/abc123/factory-overview?kiosk&orgId=1");
    expect(p.proto).toBe("https");
    expect(p.address).toBe("grafana.example.com/d/abc123/factory-overview");
    expect(p.pairs).toEqual(["kiosk", "orgId=1"]);
    expect(p.grafana).toBe(true);
  });

  test("http scheme is captured, not upgraded", () => {
    expect(parseAddress("http://grafana.local/d/x/y").proto).toBe("http");
  });

  test("no scheme defaults to https and stays grafana-aware via the /d/ path", () => {
    const p = parseAddress("grafana.example.com/d/abc/anything");
    expect(p.proto).toBe("https");
    expect(p.grafana).toBe(true);
  });

  test("a plain web address is not grafana and keeps its query", () => {
    const p = parseAddress("https://example.com/page?a=b");
    expect(p.grafana).toBe(false);
    expect(p.pairs).toEqual(["a=b"]);
  });

  test("a kiosk flag alone marks a URL as grafana", () => {
    expect(parseAddress("https://host/dash?kiosk=tv").grafana).toBe(true);
  });

  test("suggests a title-cased name from the dashboard slug", () => {
    expect(parseAddress("https://g.example.com/d/abc123/factory-overview?kiosk").suggestedName).toBe(
      "Factory Overview",
    );
  });

  test("a fragment is dropped", () => {
    expect(parseAddress("https://example.com/page#panel-3").address).toBe("example.com/page");
  });
});

describe("slugName (the Use-“…” chip)", () => {
  test("title-cases a plain last segment", () => {
    expect(slugName("intranet.example.com/energy-monitoring")).toBe("Energy Monitoring");
  });

  test("prefers the /d/<uid>/<slug> segment", () => {
    expect(slugName("g.example.com/d/abc123/factory-overview/extra")).toBe("Factory Overview");
  });

  test("refuses an opaque hex id, a file name, and anything too short", () => {
    expect(slugName("g.example.com/d/deadbeefdeadbeefdead")).toBe("");
    expect(slugName("cdn.example.com/menu.png")).toBe("");
    expect(slugName("example.com/ab")).toBe("");
    expect(slugName("example.com")).toBe("");
  });
});

describe("extractGrafanaFlags (pairs → controls + keep)", () => {
  test("kiosk bare → kiosk on, picker off", () => {
    const { gf: out } = extractGrafanaFlags(["kiosk"]);
    expect(out.kiosk).toBe(true);
    expect(out.picker).toBe(false);
  });

  test("kiosk=tv → kiosk on, picker on", () => {
    const { gf: out } = extractGrafanaFlags(["kiosk=tv"]);
    expect(out.kiosk).toBe(true);
    expect(out.picker).toBe(true);
  });

  test("no kiosk param → kiosk off", () => {
    expect(extractGrafanaFlags(["orgId=1"]).gf.kiosk).toBe(false);
  });

  test("from+to as a pair set a custom range; recognised refresh and theme land in the controls", () => {
    const { gf: out, keep } = extractGrafanaFlags(["from=now-7d", "to=now", "refresh=1m", "theme=dark"]);
    expect(out.range).toBe("custom");
    expect(out.from).toBe("now-7d");
    expect(out.to).toBe("now");
    expect(out.refresh).toBe("1m");
    expect(out.theme).toBe("dark");
    expect(keep).toBe("");
  });

  test("a from without a to stays in keep verbatim (the range controls need the pair)", () => {
    const { gf: out, keep } = extractGrafanaFlags(["from=now-7d"]);
    expect(out.range).toBe("inherit");
    expect(keep).toBe("from=now-7d");
  });

  test("a refresh cadence the controls can't represent stays in keep", () => {
    const { gf: out, keep } = extractGrafanaFlags(["refresh=10s"]);
    expect(out.refresh).toBe("default");
    expect(keep).toBe("refresh=10s");
  });

  test("an unmodelled kiosk mode and unknown params ride through in order", () => {
    const { gf: out, keep } = extractGrafanaFlags(["kiosk=full", "orgId=1", "var-line=A"]);
    expect(out.kiosk).toBe(false);
    expect(keep).toBe("kiosk=full&orgId=1&var-line=A");
  });

  test("parse-then-compose round-trips a real dashboard URL", () => {
    const url = "https://g.example.com/d/abc/slug?orgId=1&kiosk=tv&from=now-24h&to=now&refresh=5m&theme=light";
    const p = parseAddress(url);
    const { gf: out, keep } = extractGrafanaFlags(p.pairs);
    expect(composeSourceUrl({ proto: p.proto, address: p.address, keep, gf: out })).toBe(url);
  });
});

describe("gfSummary (library row read-out)", () => {
  test("only the non-default choices speak, in the mock's format", () => {
    expect(gfSummary(gf({ kiosk: true, picker: true, range: "custom", from: "now-7d", to: "now", refresh: "5m", theme: "dark" }))).toBe(
      "kiosk · time picker · now-7d → now · refresh 5m · dark theme",
    );
    expect(gfSummary(gf({ kiosk: true }))).toBe("kiosk");
    expect(gfSummary(gf({ kiosk: false }))).toBe("");
  });
});

describe("normalizeComposition", () => {
  const composition = { proto: "https" as const, address: "g.example.com/d/a/b", gf: gf() };

  test("gf sheds off a non-dashboard kind", () => {
    expect(normalizeComposition("web", composition)).toEqual({
      proto: "https",
      address: "g.example.com/d/a/b",
    });
  });

  test("dashboard keeps gf; url-less kinds keep nothing", () => {
    expect(normalizeComposition("dashboard", composition)).toEqual(composition);
    expect(normalizeComposition("playlist", composition)).toBeUndefined();
    expect(normalizeComposition("page", composition)).toBeUndefined();
    expect(normalizeComposition("deck", composition)).toBeUndefined();
  });
});

describe("contract guards", () => {
  const base = { id: "source-1", name: "Factory overview", kind: "dashboard" as const };
  const composition = { proto: "https" as const, address: "g.example.com/d/a/b", gf: gf() };

  test("a dashboard source carries a composition with gf", () => {
    const parsed = ContentSource.safeParse({
      ...base,
      url: composeSourceUrl(composition),
      composition,
    });
    expect(parsed.success).toBe(true);
  });

  test("gf on a web source is refused", () => {
    const parsed = ContentSource.safeParse({
      ...base,
      kind: "web",
      url: "https://g.example.com/d/a/b?kiosk",
      composition,
    });
    expect(parsed.success).toBe(false);
  });

  test("a playlist cannot carry a composition", () => {
    const parsed = ContentSource.safeParse({
      id: "source-2",
      name: "Rotation",
      kind: "playlist",
      items: [],
      composition: { proto: "https", address: "x.example.com" },
    });
    expect(parsed.success).toBe(false);
  });

  test("create accepts a composition INSTEAD of a url, and refuses both", () => {
    expect(
      CreateContentSourceBody.safeParse({ name: "A", kind: "dashboard", composition }).success,
    ).toBe(true);
    expect(
      CreateContentSourceBody.safeParse({
        name: "A",
        kind: "dashboard",
        url: "https://g.example.com/d/a/b",
        composition,
      }).success,
    ).toBe(false);
    expect(CreateContentSourceBody.safeParse({ name: "A", kind: "dashboard" }).success).toBe(false);
  });

  test("update accepts a composition patch", () => {
    expect(UpdateContentSourceBody.safeParse({ composition }).success).toBe(true);
  });
});
