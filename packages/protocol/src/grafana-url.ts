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

/** The Grafana display controls (dashboard kind only). These compose to query-string flags
 *  (grafana-kiosk's dialect — POL-182):
 *
 *    kiosk ON, picker OFF   →  `kiosk=1` (POL-180: never bare `kiosk` — some builds ignore it)
 *    kiosk ON, picker ON    →  `kiosk=tv`
 *    kiosk OFF              →  (no kiosk param)
 *    (always)               →  `hideLogo=1` — Grafana's "Powered by" logo has no place on a wall
 *    hideTimePicker ON      →  `_dash.hideTimePicker=true` — belt-and-braces with kiosk: Grafana
 *                              11.2.x left the time picker visible in full kiosk
 *                              (grafana/grafana#96595); grafana-kiosk sends both
 *    from / to non-empty    →  `from=…` / `to=…` (Grafana's grammar — `now-24h`, epoch ms; empty
 *                              = omitted, the dashboard's saved default applies)
 *    refresh non-empty      →  `refresh=…` (`30s`, `1m`, …; empty = omitted)
 *    autofit ON             →  `autofitpanels` (bare, grafana-kiosk's documented form)
 *    theme ≠ "default"      →  `theme=light` | `theme=dark`
 *
 *  Schema evolution (POL-182): parse DEFAULTS reproduce what an already-stored composition
 *  composes today — `hideTimePicker`/`autofit` default OFF and absent `from`/`to`/`refresh`
 *  default empty, so an old row's URL only changes when the operator re-saves it. New sources
 *  start from `gfDefaults()`, where hideTimePicker is ON. A pre-POL-182 stored shape (the
 *  `range: inherit|custom` enum, `refresh: "default"`) is upgraded in a preprocess step to the
 *  same effect.
 */
const GrafanaDisplayShape = z.object({
  /** Kiosk mode — hides Grafana's chrome so the wall shows only the dashboard. */
  kiosk: z.boolean(),
  /** Keep the date/time picker on screen (`kiosk=tv`). Only meaningful while kiosk is on. */
  picker: z.boolean(),
  /** `_dash.hideTimePicker=true` — OFF on parse of old data, ON in `gfDefaults()` (new sources). */
  hideTimePicker: z.boolean().default(false),
  /** Grafana time syntax (`now-24h`, epoch ms, …). Empty = omitted — the dashboard's default. */
  from: z.string().max(64).default(""),
  to: z.string().max(64).default(""),
  /** Auto-refresh interval (`30s`, `1m`, …). Empty = omitted — Grafana owns the grammar. */
  refresh: z.string().max(32).default(""),
  /** `autofitpanels` — grafana-kiosk's panel-fitting flag. */
  autofit: z.boolean().default(false),
  theme: z.enum(["default", "light", "dark"]),
});

/** Upgrade a pre-POL-182 stored shape: the `range` enum gated whether `from`/`to` composed, and
 *  `refresh: "default"` meant no param — map both onto the empty-string form so the parsed
 *  composition composes the same URL the row already stores. */
function upgradeGf(v: unknown): unknown {
  if (v === null || typeof v !== "object" || !("range" in v)) return v;
  const o = v as Record<string, unknown>;
  const { range, ...rest } = o;
  return {
    ...rest,
    from: range === "custom" ? o["from"] : "",
    to: range === "custom" ? o["to"] : "",
    refresh: o["refresh"] === "default" ? "" : o["refresh"],
  };
}

export const GrafanaDisplay = z.preprocess(upgradeGf, GrafanaDisplayShape);
export type GrafanaDisplay = z.infer<typeof GrafanaDisplayShape>;

/** How the dialog's simplified auth picker maps onto what the server does:
 *
 *    none          the page loads with no credentials — nothing is injected.
 *    forward-auth  "Grafana service account · forward-auth": a POL-24 credential profile's
 *                  short-lived token is stamped into the URL at send time
 *                  (`credentialProfileId` names the profile) — credentials injected at the edge,
 *                  the stored URL itself never carries secrets.
 *    kiosk         "Kiosk sign-in · shared account": the screens sign in with a shared kiosk
 *                  account before the page loads — outside Polyptic, so nothing is stored beyond
 *                  the mode itself (recorded so the dialog reopens truthfully).
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
 *  chrome), the time picker hidden twice over (kiosk + `_dash.hideTimePicker` — see
 *  grafana/grafana#96595), everything else the dashboard's own defaults. */
export function gfDefaults(): GrafanaDisplay {
  return {
    kiosk: true,
    picker: false,
    hideTimePicker: true,
    from: "",
    to: "",
    refresh: "",
    autofit: false,
    theme: "default",
  };
}

/** The `k=v` (or bare-`k`) pairs a GrafanaDisplay composes, in stable order. */
export function gfPairs(gf: GrafanaDisplay): string[] {
  const pairs: string[] = [];
  // POL-182: `kiosk=1`, never bare `kiosk` — some Grafana builds ignore a valueless kiosk flag
  // (POL-180), and grafana-kiosk sends the `1` form.
  if (gf.kiosk) pairs.push(gf.picker ? "kiosk=tv" : "kiosk=1");
  // Always: Grafana's "Powered by" logo has no place on a wall.
  pairs.push("hideLogo=1");
  // Belt-and-braces with kiosk — Grafana 11.2.x left the time picker visible in full kiosk
  // (grafana/grafana#96595); grafana-kiosk sends both.
  if (gf.hideTimePicker) pairs.push("_dash.hideTimePicker=true");
  const from = gf.from.trim();
  const to = gf.to.trim();
  if (from) pairs.push(`from=${encodeURIComponent(from)}`);
  if (to) pairs.push(`to=${encodeURIComponent(to)}`);
  const refresh = gf.refresh.trim();
  if (refresh) pairs.push(`refresh=${encodeURIComponent(refresh)}`);
  // Bare `autofitpanels` — grafana-kiosk's documented form.
  if (gf.autofit) pairs.push("autofitpanels");
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
  const suggestedName = slugName(address);
  return { proto, address, pairs, grafana, ...(suggestedName ? { suggestedName } : {}) };
}

/**
 * A display name suggested from an address's last path segment — the dialog's "Use “…”" chip.
 * Prefers a Grafana dashboard slug (`/d/<uid>/<slug>`); refuses to suggest an opaque id (16+ hex
 * chars), a file name (`menu.png`) or anything shorter than 3 characters; title-cases each word.
 * `""` = nothing worth suggesting.
 */
export function slugName(addr: string): string {
  const a = (addr ?? "").split("?")[0] ?? "";
  const segs = a.split("/").filter(Boolean);
  if (segs.length < 2) return "";
  let s = segs[segs.length - 1] ?? "";
  const dm = /\/d\/[\w-]+\/([\w-]+)/i.exec(a);
  if (dm) s = dm[1]!;
  if (!s || /^[a-f0-9-]{16,}$/i.test(s) || /\.\w{2,4}$/.test(s)) return "";
  try {
    s = decodeURIComponent(s);
  } catch {
    // an unparseable escape stays as typed
  }
  s = s.replace(/[-_]+/g, " ").trim();
  if (s.length < 3) return "";
  return s.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Read the Grafana flags out of parsed query pairs and split them from the passthrough remainder.
 * Recognised (and captured into the controls): `kiosk` / `kiosk=true` / `kiosk=1` (kiosk on,
 * picker off), `kiosk=tv` (kiosk on, picker on), `hideLogo` (absorbed — it is always re-emitted),
 * `_dash.hideTimePicker=true`, `from` / `to` (each on its own), any non-empty `refresh`,
 * `autofitpanels`, `theme=light|dark`. Everything else — including a `theme` value the controls
 * can't represent — stays in `keep` verbatim.
 */
export function extractGrafanaFlags(pairs: string[]): { gf: GrafanaDisplay; keep: string } {
  const gf = gfDefaults();
  // The extractor reads what the pairs SAY, so its baseline is everything-off — `gfDefaults()`
  // seeds new sources, not parsed ones (an old URL without `_dash.hideTimePicker` must stay
  // without it).
  gf.kiosk = false;
  gf.hideTimePicker = false;
  const keep: string[] = [];

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
    const truthy = value === "" || value === "true" || value === "1";
    if (key === "kiosk") {
      if (truthy) {
        gf.kiosk = true;
        gf.picker = false;
      } else if (value === "tv") {
        gf.kiosk = true;
        gf.picker = true;
      } else {
        keep.push(pair); // a kiosk mode the controls don't model rides through verbatim
      }
    } else if (key === "hideLogo" && truthy) {
      // Absorbed: composition always emits `hideLogo=1`.
    } else if (key === "_dash.hideTimePicker" && truthy) {
      gf.hideTimePicker = true;
    } else if (key === "autofitpanels" && truthy) {
      gf.autofit = true;
    } else if (key === "from" && value.length > 0) {
      gf.from = decode(value);
    } else if (key === "to" && value.length > 0) {
      gf.to = decode(value);
    } else if (key === "refresh" && value.length > 0) {
      gf.refresh = decode(value);
    } else if (key === "theme" && (value === "light" || value === "dark")) {
      gf.theme = value;
    } else {
      keep.push(pair);
    }
  }

  return { gf, keep: keep.join("&") };
}

/** One line naming what the controls change — the library row's read-out. Only the non-default
 *  choices speak ("kiosk · time picker", "now-7d → now", "refresh 5m", "dark theme"); a dashboard
 *  left entirely on its own defaults reads as nothing at all. `hideTimePicker` and the always-on
 *  `hideLogo` stay quiet — they are the wall's baseline, not a choice worth a row. */
export function gfSummary(gf: GrafanaDisplay): string {
  const bits: string[] = [];
  if (gf.kiosk) bits.push(gf.picker ? "kiosk · time picker" : "kiosk");
  const from = gf.from.trim();
  const to = gf.to.trim();
  if (from && to) bits.push(`${from} → ${to}`);
  else if (from) bits.push(`from ${from}`);
  else if (to) bits.push(`to ${to}`);
  if (gf.refresh.trim()) bits.push(`refresh ${gf.refresh.trim()}`);
  if (gf.autofit) bits.push("fit panels");
  if (gf.theme !== "default") bits.push(`${gf.theme} theme`);
  return bits.join(" · ");
}
