/**
 * Structured content-source addresses (POL-175).
 *
 * The Add/Edit source dialog stopped asking for one opaque URL: a source is now a PROTOCOL + an
 * ADDRESS + (for a Grafana dashboard) DISPLAY CONTROLS that compose the query-string flags Grafana
 * reads (`kiosk`, `from`/`to`, `refresh`, `theme`). This module is the single source of truth for
 * that composition and for its inverse — the paste-to-import parser that splits a full pasted URL
 * back into the controls. Pure functions, shared by the console (the dialog), the server (which
 * composes the canonical `url` it stores, probes and pushes) and the tests.
 *
 * "Grafana" here names a QUERY-STRING DIALECT, not a vendor dependency: the flags are plain URL
 * parameters composed client-of-nothing — a source pointed at anything else simply doesn't use them.
 * The stored `url` stays canonical: everything downstream (framing probe, send-time token stamping,
 * the player, scenes, source health) keeps consuming `url` exactly as before.
 */
import { z } from "zod";

/** The scheme the address is loaded over. The dialog offers exactly these two; the operator never
 *  types a scheme — a pasted one is stripped and captured in the dropdown. */
export const SourceProto = z.enum(["https", "http"]);
export type SourceProto = z.infer<typeof SourceProto>;

/** The auto-refresh cadences the dialog offers. `default` = no `refresh` param — the dashboard's
 *  own saved refresh applies. */
export const GfRefresh = z.enum(["default", "30s", "1m", "5m", "15m", "1h"]);
export type GfRefresh = z.infer<typeof GfRefresh>;

/** The Grafana display controls (dashboard kind only). These compose to query-string flags:
 *
 *    kiosk ON, picker OFF   →  `kiosk`
 *    kiosk ON, picker ON    →  `kiosk=tv`
 *    kiosk OFF              →  (no kiosk param)
 *    range "custom"         →  `from=…&to=…` (Grafana time syntax, e.g. `now-7d`, `now`)
 *    range "inherit"        →  (nothing — the dashboard's saved default applies)
 *    refresh ≠ "default"    →  `refresh=…`
 *    theme ≠ "default"      →  `theme=light` | `theme=dark`
 */
export const GrafanaDisplay = z.object({
  /** Kiosk mode — hides Grafana's chrome so the wall shows only the dashboard. */
  kiosk: z.boolean(),
  /** Keep the date/time picker on screen (`kiosk=tv`). Only meaningful while kiosk is on. */
  picker: z.boolean(),
  /** `inherit` = the dashboard's saved time range; `custom` = the `from`/`to` below. */
  range: z.enum(["inherit", "custom"]),
  /** Grafana time syntax (`now-7d`, `2026-01-01T00:00:00Z`, …). Composed only when range is custom. */
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  refresh: GfRefresh,
  theme: z.enum(["default", "light", "dark"]),
});
export type GrafanaDisplay = z.infer<typeof GrafanaDisplay>;

/** How the dialog's simplified auth picker maps onto what the server does:
 *
 *    none          the page loads with no credentials.
 *    forward-auth  a proxy in front of the content signs every request; Polyptic sends nothing.
 *                  (Same wire behaviour as `none` — recorded so the dialog reopens truthfully.)
 *    kiosk         a POL-24 credential profile's short-lived token is stamped into the URL at send
 *                  time (`credentialProfileId` names the profile).
 */
export const SourceAuthMode = z.enum(["none", "forward-auth", "kiosk"]);
export type SourceAuthMode = z.infer<typeof SourceAuthMode>;

/** The structured breakdown of a URL-backed source's address, stored ALONGSIDE the composed `url`
 *  (never instead of it). `address` carries neither scheme nor query; `keep` is the untouched
 *  passthrough query fragment (`a=b&c=d`, no leading `?`) re-attached verbatim on composition. */
export const SourceComposition = z.object({
  proto: SourceProto,
  address: z.string().min(1).max(2000),
  keep: z.string().max(2000).optional(),
  /** Grafana display controls — dashboard kind only (the contract refines this). */
  gf: GrafanaDisplay.optional(),
  auth: SourceAuthMode.optional(),
});
export type SourceComposition = z.infer<typeof SourceComposition>;

/** The dialog's starting point for a new Grafana dashboard source: kiosk on (a wall wants no
 *  chrome), picker off, everything else the dashboard's own defaults. */
export function gfDefaults(): GrafanaDisplay {
  return {
    kiosk: true,
    picker: false,
    range: "inherit",
    from: "now-6h",
    to: "now",
    refresh: "default",
    theme: "default",
  };
}

/** The `k=v` (or bare-`k`) pairs a GrafanaDisplay composes, in stable order. */
export function gfPairs(gf: GrafanaDisplay): string[] {
  const pairs: string[] = [];
  if (gf.kiosk) pairs.push(gf.picker ? "kiosk=tv" : "kiosk");
  if (gf.range === "custom") {
    pairs.push(`from=${encodeURIComponent(gf.from)}`, `to=${encodeURIComponent(gf.to)}`);
  }
  if (gf.refresh !== "default") pairs.push(`refresh=${gf.refresh}`);
  if (gf.theme !== "default") pairs.push(`theme=${gf.theme}`);
  return pairs;
}

/** The composed query string — `keep` (verbatim, first) then the Grafana flags. `""` when there is
 *  nothing to carry; otherwise starts with `?`. */
export function composeQuery(keep: string | undefined, gf: GrafanaDisplay | undefined): string {
  const parts: string[] = [];
  if (keep) parts.push(keep);
  if (gf) parts.push(...gfPairs(gf));
  return parts.length ? `?${parts.join("&")}` : "";
}

/** The canonical URL a composition resolves to: `{proto}://{address}{query}`. This is what the
 *  server stores in `url`, probes, stamps tokens into and pushes to players. */
export function composeSourceUrl(c: SourceComposition): string {
  return `${c.proto}://${c.address}${composeQuery(c.keep, c.gf)}`;
}

/** Drop the parts of a composition the kind cannot carry: `gf` rides the dashboard kind only, and
 *  a non-URL kind (playlist/page/deck) has no composition at all. */
export function normalizeComposition(
  kind: string,
  c: SourceComposition | undefined,
): SourceComposition | undefined {
  if (c === undefined) return undefined;
  if (kind === "playlist" || kind === "page" || kind === "deck") return undefined;
  if (kind !== "dashboard" && c.gf !== undefined) {
    const { gf: _gf, ...rest } = c;
    return rest;
  }
  return c;
}

/** What the paste-to-import parser makes of one raw address/URL. */
export type ParsedAddress = {
  proto: SourceProto;
  /** Scheme-stripped, query-stripped address (host + path). */
  address: string;
  /** The query pairs, in order, exactly as pasted (`["kiosk=tv", "orgId=1"]`). */
  pairs: string[];
  /** True when the address reads as a Grafana dashboard URL (a `/d/…` path or a `kiosk` flag). */
  grafana: boolean;
  /** A display name suggested from the dashboard slug (`/d/<uid>/<slug>`), when one is present. */
  suggestedName?: string;
};

/**
 * Split a pasted (or typed) address: strip the scheme into `proto`, cut the query into ordered
 * pairs, drop any fragment. Never throws — garbage in stays garbage in `address`, and the composed
 * URL is validated at the boundary like always.
 */
export function parseAddress(raw: string): ParsedAddress {
  let rest = raw.trim();
  let proto: SourceProto = "https";
  const scheme = /^(https?):\/\//i.exec(rest);
  if (scheme) {
    proto = scheme[1]!.toLowerCase() as SourceProto;
    rest = rest.slice(scheme[0].length);
  }
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const q = rest.indexOf("?");
  const address = (q >= 0 ? rest.slice(0, q) : rest).trim();
  const query = q >= 0 ? rest.slice(q + 1) : "";
  const pairs = query.split("&").filter((p) => p.length > 0);
  const grafana =
    /\/d(?:-solo)?\/[^/]+/.test(address) || pairs.some((p) => /^kiosk(=|$)/.test(p));
  const slug = /\/d\/[^/?]+\/([^/?]+)/.exec(address)?.[1];
  const suggestedName = slug ? nameFromSlug(slug) : undefined;
  return { proto, address, pairs, grafana, ...(suggestedName ? { suggestedName } : {}) };
}

/** `factory-overview` → `Factory overview`. */
function nameFromSlug(slug: string): string {
  let s = slug;
  try {
    s = decodeURIComponent(slug);
  } catch {
    // an unparseable escape stays as typed
  }
  const words = s.replace(/[-_]+/g, " ").trim();
  return words.length ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * Read the Grafana flags out of parsed query pairs and split them from the passthrough remainder.
 * Recognised (and captured into the controls): `kiosk` / `kiosk=true` (kiosk on, picker off),
 * `kiosk=tv` (kiosk on, picker on), `from`+`to` as a pair (custom range), `refresh` when it is one
 * of the dialog's cadences, `theme=light|dark`. Everything else — including a `refresh` or `theme`
 * value the controls can't represent, or a `from` without a `to` — stays in `keep` verbatim.
 */
export function extractGrafanaFlags(pairs: string[]): { gf: GrafanaDisplay; keep: string } {
  const gf = gfDefaults();
  gf.kiosk = false;
  const keep: string[] = [];
  let from: string | undefined;
  let to: string | undefined;

  const decode = (v: string): string => {
    try {
      return decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      return v;
    }
  };

  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    const value = eq >= 0 ? pair.slice(eq + 1) : "";
    if (key === "kiosk") {
      if (value === "" || value === "true" || value === "1") {
        gf.kiosk = true;
        gf.picker = false;
      } else if (value === "tv") {
        gf.kiosk = true;
        gf.picker = true;
      } else {
        keep.push(pair); // a kiosk mode the controls don't model rides through verbatim
      }
    } else if (key === "from") {
      from = decode(value);
    } else if (key === "to") {
      to = decode(value);
    } else if (key === "refresh" && GfRefresh.options.includes(value as GfRefresh)) {
      gf.refresh = value as GfRefresh;
    } else if (key === "theme" && (value === "light" || value === "dark")) {
      gf.theme = value;
    } else {
      keep.push(pair);
    }
  }

  if (from !== undefined && to !== undefined && from.length > 0 && to.length > 0) {
    gf.range = "custom";
    gf.from = from;
    gf.to = to;
  } else {
    // An incomplete pair can't drive the range controls — carry it through untouched.
    if (from !== undefined) keep.push(`from=${encodeURIComponent(from)}`);
    if (to !== undefined) keep.push(`to=${encodeURIComponent(to)}`);
  }

  return { gf, keep: keep.join("&") };
}

/** One line naming what the controls will do — the dialog's card summary. */
export function gfSummary(gf: GrafanaDisplay): string {
  const bits: string[] = [];
  bits.push(gf.kiosk ? (gf.picker ? "kiosk with time picker" : "kiosk") : "full Grafana chrome");
  bits.push(gf.range === "custom" ? `${gf.from} → ${gf.to}` : "dashboard time range");
  if (gf.refresh !== "default") bits.push(`refresh ${gf.refresh}`);
  if (gf.theme !== "default") bits.push(`${gf.theme} theme`);
  return bits.join(" · ");
}
