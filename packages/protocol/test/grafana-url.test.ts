/**
 * POL-175/POL-180/POL-182 — structured content-source addresses: the flag composer (controls →
 * Grafana query string), the paste-to-import parser (URL → controls) and the contract guards
 * around `SourceComposition` on sources and bodies. The console's dialog and the server both lean
 * on exactly these functions, so the mapping table lives here as executable truth.
 */
import { describe, expect, test } from "bun:test";

import {
  ContentSource,
  CreateContentSourceBody,
  GrafanaDisplay,
  UpdateContentSourceBody,
  composeQuery,
  composeSourceUrl,
  extractGrafanaFlags,
  gfDefaults,
  gfSummary,
  normalizeComposition,
  parseAddress,
  slugName,
} from "../src/index";

const gf = (over: Partial<GrafanaDisplay> = {}): GrafanaDisplay => ({ ...gfDefaults(), ...over });
/** Everything off — the parsed-from-nothing baseline (gfDefaults has kiosk ON). */
const off = (over: Partial<GrafanaDisplay> = {}): GrafanaDisplay => gf({ kiosk: false, ...over });

describe("flag composition (controls → query)", () => {
  test("kiosk on, picker off → `kiosk=1` + the derived hide-time-picker (POL-182)", () => {
    expect(composeQuery(undefined, off({ kiosk: true }))).toBe(
      "?kiosk=1&hideLogo=1&_dash.hideTimePicker=true",
    );
  });

  test("kiosk on, picker on → `kiosk=tv`", () => {
    expect(composeQuery(undefined, off({ kiosk: true, picker: true }))).toBe(
      "?kiosk=tv&hideLogo=1",
    );
  });

  test("hideLogo=1 is ALWAYS emitted — even with everything else off", () => {
    expect(composeQuery(undefined, off())).toBe("?hideLogo=1");
  });

  // ONE control decides the picker: `_dash.hideTimePicker=true` is derived from "kiosk on, picker
  // off", so the dialog can never show two switches that contradict each other.
  test("the picker control alone decides `_dash.hideTimePicker` — kiosk=tv never hides it", () => {
    expect(composeQuery(undefined, off({ kiosk: true, picker: true }))).not.toContain(
      "_dash.hideTimePicker",
    );
    expect(composeQuery(undefined, off({ kiosk: true, picker: false }))).toContain(
      "_dash.hideTimePicker=true",
    );
  });

  test("kiosk off means the full Grafana UI — no hide-time-picker either", () => {
    expect(composeQuery(undefined, off({ picker: false }))).toBe("?hideLogo=1");
  });

  test("new-source defaults compose kiosk=1 + hideLogo + hideTimePicker", () => {
    expect(composeQuery(undefined, gf())).toBe("?kiosk=1&hideLogo=1&_dash.hideTimePicker=true");
  });

  test("from/to compose when non-empty, each on its own; whitespace trims away", () => {
    expect(composeQuery(undefined, off({ from: "now-7d", to: "now" }))).toBe(
      "?hideLogo=1&from=now-7d&to=now",
    );
    expect(composeQuery(undefined, off({ from: " now-24h " }))).toBe(
      "?hideLogo=1&from=now-24h",
    );
    expect(composeQuery(undefined, off({ from: "  ", to: "" }))).toBe("?hideLogo=1");
  });

  test("refresh composes any non-empty interval; empty composes nothing", () => {
    expect(composeQuery(undefined, off({ refresh: "10s" }))).toBe("?hideLogo=1&refresh=10s");
    expect(composeQuery(undefined, off({ refresh: "" }))).toBe("?hideLogo=1");
  });

  test("autofit → bare `autofitpanels` (grafana-kiosk's documented form)", () => {
    expect(composeQuery(undefined, off({ autofit: true }))).toBe("?hideLogo=1&autofitpanels");
  });

  test("non-default theme composes its param", () => {
    expect(composeQuery(undefined, off({ theme: "dark" }))).toBe("?hideLogo=1&theme=dark");
  });

  test("keep rides first, verbatim, then the flags", () => {
    expect(composeQuery("orgId=1&var-line=A", off({ kiosk: true, refresh: "30s" }))).toBe(
      "?orgId=1&var-line=A&kiosk=1&hideLogo=1&_dash.hideTimePicker=true&refresh=30s",
    );
  });

  test("the full url is proto://address + query", () => {
    expect(
      composeSourceUrl({
        proto: "https",
        address: "grafana.example.com/d/abc123/factory-overview",
        keep: "orgId=1",
        gf: off({ kiosk: true, picker: true, theme: "light" }),
      }),
    ).toBe(
      "https://grafana.example.com/d/abc123/factory-overview?orgId=1&kiosk=tv&hideLogo=1&theme=light",
    );
  });

  test("no keep, no gf → no query at all", () => {
    expect(composeSourceUrl({ proto: "http", address: "intranet.local/status" })).toBe(
      "http://intranet.local/status",
    );
  });
});

describe("schema evolution (POL-182 — old stored compositions parse stable)", () => {
  test("a pre-POL-182 shape upgrades: inherit range and default refresh empty out", () => {
    const legacy = {
      kiosk: true,
      picker: false,
      range: "inherit",
      from: "now-6h",
      to: "now",
      refresh: "default",
      theme: "default",
    };
    const parsed = GrafanaDisplay.parse(legacy);
    expect(parsed).toEqual(off({ kiosk: true }));
    // The upgraded parse must not leak the held-but-inactive from/to, nor gain the new toggles.
    // It DOES gain the derived hide-time-picker, because the row already said "kiosk, no picker" —
    // Grafana 11.2.x simply ignored that instruction (grafana/grafana#96595).
    expect(composeQuery(undefined, parsed)).toBe("?kiosk=1&hideLogo=1&_dash.hideTimePicker=true");
  });

  test("a pre-POL-182 custom range keeps its from/to and refresh", () => {
    const legacy = {
      kiosk: false,
      picker: false,
      range: "custom",
      from: "now-7d",
      to: "now",
      refresh: "5m",
      theme: "dark",
    };
    expect(GrafanaDisplay.parse(legacy)).toEqual(
      off({ from: "now-7d", to: "now", refresh: "5m", theme: "dark" }),
    );
  });

  test("a current shape without the new keys parses with them off", () => {
    const { autofit: _a, ...rest } = off({ kiosk: true });
    const parsed = GrafanaDisplay.parse(rest);
    expect(parsed.autofit).toBe(false);
  });

  test("gfDefaults (new sources) is kiosk without the picker — which hides it both ways", () => {
    expect(gfDefaults().kiosk).toBe(true);
    expect(gfDefaults().picker).toBe(false);
    expect(gfDefaults().autofit).toBe(false);
  });

  // The field existed only on this branch before the picker became the single control.
  test("a row carrying the short-lived hideTimePicker field still parses", () => {
    const parsed = GrafanaDisplay.parse({ ...off({ kiosk: true }), hideTimePicker: true });
    expect(parsed.kiosk).toBe(true);
    expect("hideTimePicker" in parsed).toBe(false);
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
  test("kiosk bare, kiosk=true and kiosk=1 → kiosk on, picker off", () => {
    for (const pair of ["kiosk", "kiosk=true", "kiosk=1"]) {
      const { gf: out } = extractGrafanaFlags([pair]);
      expect(out.kiosk).toBe(true);
      expect(out.picker).toBe(false);
    }
  });

  test("kiosk=tv → kiosk on, picker on", () => {
    const { gf: out } = extractGrafanaFlags(["kiosk=tv"]);
    expect(out.kiosk).toBe(true);
    expect(out.picker).toBe(true);
  });

  test("no kiosk param → kiosk off (parsed, not defaulted)", () => {
    const { gf: out } = extractGrafanaFlags(["orgId=1"]);
    expect(out.kiosk).toBe(false);
  });

  test("hideLogo is absorbed — composition always re-emits it", () => {
    const { keep } = extractGrafanaFlags(["hideLogo=1", "orgId=1"]);
    expect(keep).toBe("orgId=1");
  });

  test("_dash.hideTimePicker is absorbed — the picker control re-emits it", () => {
    expect(extractGrafanaFlags(["_dash.hideTimePicker=true"]).keep).toBe("");
    expect(extractGrafanaFlags(["_dash.hideTimePicker=1"]).keep).toBe("");
  });

  test("autofitpanels (bare or valued) lands in the toggle", () => {
    expect(extractGrafanaFlags(["autofitpanels"]).gf.autofit).toBe(true);
    expect(extractGrafanaFlags(["autofitpanels=true"]).gf.autofit).toBe(true);
  });

  test("from, to and any refresh land in the controls, each on its own", () => {
    const { gf: out, keep } = extractGrafanaFlags([
      "from=now-7d",
      "to=now",
      "refresh=10s",
      "theme=dark",
    ]);
    expect(out.from).toBe("now-7d");
    expect(out.to).toBe("now");
    expect(out.refresh).toBe("10s");
    expect(out.theme).toBe("dark");
    expect(keep).toBe("");
  });

  test("a from without a to still lands in the from field alone", () => {
    const { gf: out, keep } = extractGrafanaFlags(["from=now-7d"]);
    expect(out.from).toBe("now-7d");
    expect(out.to).toBe("");
    expect(keep).toBe("");
  });

  test("an unmodelled kiosk mode and unknown params ride through in order", () => {
    const { gf: out, keep } = extractGrafanaFlags(["kiosk=full", "orgId=1", "var-line=A"]);
    expect(out.kiosk).toBe(false);
    expect(keep).toBe("kiosk=full&orgId=1&var-line=A");
  });

  test("parse-then-compose round-trips a real dashboard URL", () => {
    const url =
      "https://g.example.com/d/abc/slug?orgId=1&kiosk=1&hideLogo=1&_dash.hideTimePicker=true&from=now-24h&to=now&refresh=5m&autofitpanels&theme=light";
    const p = parseAddress(url);
    const { gf: out, keep } = extractGrafanaFlags(p.pairs);
    expect(composeSourceUrl({ proto: p.proto, address: p.address, keep, gf: out })).toBe(url);
  });
});

describe("gfSummary (library row read-out)", () => {
  test("only the non-default choices speak, in the mock's format", () => {
    expect(
      gfSummary(
        off({
          kiosk: true,
          picker: true,
          from: "now-7d",
          to: "now",
          refresh: "5m",
          theme: "dark",
        }),
      ),
    ).toBe("kiosk · time picker · now-7d → now · refresh 5m · dark theme");
    expect(gfSummary(off({ kiosk: true }))).toBe("kiosk");
    expect(gfSummary(off())).toBe("");
    expect(gfSummary(off({ autofit: true }))).toBe("fit panels");
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

  test("a stored pre-POL-182 composition parses (and upgrades) inside a source", () => {
    const parsed = ContentSource.safeParse({
      ...base,
      url: "https://g.example.com/d/a/b?kiosk=true",
      composition: {
        proto: "https",
        address: "g.example.com/d/a/b",
        gf: {
          kiosk: true,
          picker: false,
          range: "inherit",
          from: "now-6h",
          to: "now",
          refresh: "default",
          theme: "default",
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.composition?.gf).toEqual(off({ kiosk: true }));
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
