/**
 * POL-42 — the page-data poller: server-side fetching for the two page element kinds that need live
 * external data, RSS/Atom FEEDS and WEATHER.
 *
 * Why server-side: a player is a sealed kiosk browser pointed at arbitrary walls of third-party
 * content — it can neither fight CORS on a feed URL nor be trusted with provider quirks. The server
 * polls, normalises to the contract's `PageFeedData`/`PageWeatherData`, keeps LAST-GOOD data across
 * failures, and delivers everything inside the page surface's `data` bundle at send time
 * (ControlPlane.decorateSliceForSend). When a poll actually CHANGES something, `onChange` re-pushes
 * the slices showing the affected pages, so a new headline reaches the wall within the poll cadence
 * with no reload (D5).
 *
 * Only pages assigned to ≥1 screen are polled (ControlPlane.pageDataRequirements) — an unassigned
 * draft costs nothing. Feeds refresh ~5 min, weather ~15 min (env-tunable); a tick sweeps every 30 s
 * and fetches only what is due or newly required, so assigning a page gets data quickly.
 *
 * Weather is Open-Meteo (keyless — vendor-neutrality holds: no account, no token, and the provider
 * is isolated behind this module). Locations are free-text; they geocode once through Open-Meteo's
 * geocoding API and the coordinates are cached for the process lifetime.
 *
 * The feed parser below is deliberately a SMALL, TOLERANT extractor (RSS 2.0 + Atom, title/link/
 * timestamp), not an XML library: real-world feeds are routinely malformed, and the failure mode we
 * want is "fewer fields on a card", never a crash or a dependency.
 */
import type {
  DataRow,
  DataSet,
  DataSourceAuthIn,
  DataSourceFormat,
  DataSourceStatus,
  DataValue,
  PageFeedData,
  PageFeedItem,
  PageWeatherData,
} from "@polyptic/protocol";
import type { PageDataProvider } from "./state";

const DEFAULT_FEED_POLL_MS = 5 * 60_000;
const DEFAULT_WEATHER_POLL_MS = 15 * 60_000;
const DEFAULT_TICK_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
/** Cap parsed items per feed — element props show at most 8; keep a little slack for re-renders. */
const MAX_FEED_ITEMS = 12;
/** Ceilings on ONE data source's normalised table. A wall element shows tens of rows, not thousands;
 *  these bound both the poller's memory and the slice we push to every player. */
const MAX_DATA_ROWS = 200;
const MAX_DATA_COLUMNS = 32;
const MAX_CELL_CHARS = 500;
/** Rows the console's binding picker previews. */
const SAMPLE_ROWS = 5;

/** A feed URL as operators type it ("feeds.bbci.co.uk/news/rss.xml") → fetchable (https-prefixed). */
export function normalizeFeedUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Decode the handful of entities feed titles actually carry (incl. numeric). Best-effort. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => {
      const code = Number.parseInt(n, 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Text content of the FIRST <tag>…</tag> in `xml`, CDATA unwrapped + entities decoded. */
function firstTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!match) return undefined;
  const inner = match[1] ?? "";
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(inner);
  const text = (cdata?.[1] ?? inner).replace(/<[^>]+>/g, "").trim();
  return text ? decodeEntities(text) : undefined;
}

/** An Atom <link href="…">, preferring rel="alternate" (or no rel), from an entry's XML. */
function atomLink(entryXml: string): string | undefined {
  const links = [...entryXml.matchAll(/<link\b([^>]*?)\/?>(?:<\/link>)?/gi)];
  let fallback: string | undefined;
  for (const [, attrs] of links) {
    const href = /href\s*=\s*"([^"]*)"/i.exec(attrs ?? "")?.[1];
    if (!href) continue;
    const rel = /rel\s*=\s*"([^"]*)"/i.exec(attrs ?? "")?.[1];
    if (!rel || rel === "alternate") return decodeEntities(href);
    fallback ??= decodeEntities(href);
  }
  return fallback;
}

/** Parse an ISO/RFC-822 feed date into ISO-8601, or drop it — a bad date must not drop the item. */
function parseFeedDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Tolerant RSS 2.0 / Atom extraction: the channel/feed title + up to {@link MAX_FEED_ITEMS} items
 * with title, link, timestamp. Items without a title are dropped (a headline is the one field the
 * feed element cannot render without). Never throws on malformed input — worst case, zero items.
 */
export function parseFeed(xml: string): { title?: string; items: PageFeedItem[] } {
  const items: PageFeedItem[] = [];

  const rssItems = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)];
  if (rssItems.length > 0) {
    for (const [, inner] of rssItems) {
      if (items.length >= MAX_FEED_ITEMS) break;
      const title = firstTag(inner ?? "", "title");
      if (!title) continue;
      const link = firstTag(inner ?? "", "link");
      const publishedAt = parseFeedDate(firstTag(inner ?? "", "pubDate") ?? firstTag(inner ?? "", "dc:date"));
      items.push({ title, ...(link ? { link } : {}), ...(publishedAt ? { publishedAt } : {}) });
    }
    // The channel's own <title> is the first one BEFORE any <item> (items carry their own).
    const head = xml.slice(0, /<item[\s>]/i.exec(xml)?.index ?? xml.length);
    return { title: firstTag(head, "title"), items };
  }

  const atomEntries = [...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)];
  if (atomEntries.length > 0) {
    for (const [, inner] of atomEntries) {
      if (items.length >= MAX_FEED_ITEMS) break;
      const title = firstTag(inner ?? "", "title");
      if (!title) continue;
      const link = atomLink(inner ?? "");
      const publishedAt = parseFeedDate(firstTag(inner ?? "", "updated") ?? firstTag(inner ?? "", "published"));
      items.push({ title, ...(link ? { link } : {}), ...(publishedAt ? { publishedAt } : {}) });
    }
    const head = xml.slice(0, /<entry[\s>]/i.exec(xml)?.index ?? xml.length);
    return { title: firstTag(head, "title"), items };
  }

  return { items };
}

/** Human text for the WMO weather interpretation codes Open-Meteo reports. Coarse on purpose —
 *  this is a wall caption, not a forecast product. */
export function weatherDescription(code: number): string {
  if (code === 0) return "clear sky";
  if (code === 1) return "mainly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code >= 95) return "thunderstorm";
  return "changeable";
}

// ── POL-99 — data sources (JSON/CSV → a normalised table) ─────────────────────
//
// The parsers below are TOLERANT by contract: a wall must degrade, never crash and never paint a
// half-row. So every one of them returns a table whose rows all carry EVERY column (missing cells
// null), or an empty table — never a partial row, never a throw. Garbage in ⇒ few columns and an
// honest "no data" tell on glass, not a blank screen.

/** One cell, normalised: numbers stay numbers (charts/KPIs need them), everything else becomes a
 *  capped string, empty/absent becomes null. */
function normalizeCell(raw: unknown): DataValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    return trimmed.length > MAX_CELL_CHARS ? trimmed.slice(0, MAX_CELL_CHARS) : trimmed;
  }
  // Objects/arrays: a wall cell is a scalar. Stringify so the operator SEES what arrived.
  try {
    const json = JSON.stringify(raw) ?? "";
    return json.slice(0, MAX_CELL_CHARS) || null;
  } catch {
    return null;
  }
}

/** A CSV cell as a value: a clean number stays a number, everything else is text. */
function coerceScalar(text: string): DataValue {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return trimmed.length > MAX_CELL_CHARS ? trimmed.slice(0, MAX_CELL_CHARS) : trimmed;
}

/** Build the table: column order = first appearance, and EVERY row is filled out to every column. */
function tableFrom(records: Record<string, DataValue>[]): { columns: string[]; rows: DataRow[] } {
  const columns: string[] = [];
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!columns.includes(key) && columns.length < MAX_DATA_COLUMNS) columns.push(key);
    }
  }
  const rows: DataRow[] = records.slice(0, MAX_DATA_ROWS).map((record) => {
    const row: DataRow = {};
    for (const column of columns) row[column] = record[column] ?? null;
    return row;
  });
  return { columns, rows };
}

/** Flatten one JSON row to dotted scalar keys ({a:{b:1}} → {"a.b":1}), depth-capped. */
function flattenRow(value: unknown, prefix = "", depth = 0): Record<string, DataValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { [prefix || "value"]: normalizeCell(value) };
  }
  if (depth >= 2) return { [prefix || "value"]: normalizeCell(value) };
  const out: Record<string, DataValue> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(out, flattenRow(child, name, depth + 1));
    } else {
      out[name] = normalizeCell(child);
    }
  }
  return out;
}

/** Walk a dotted path ("data.items", "results.0") into a parsed document. Undefined if it dead-ends —
 *  the caller reports "path not found", which is what the operator needs to see. */
function atPath(doc: unknown, path: string): unknown {
  if (!path.trim()) return doc;
  let cursor: unknown = doc;
  for (const segment of path.split(".")) {
    const key = segment.trim();
    if (key === "") continue;
    if (Array.isArray(cursor)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
    } else if (cursor !== null && typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

/** JSON → table. An array of objects is the common case; an array of scalars becomes a single
 *  `value` column; a lone object becomes a ONE-row table (the KPI-endpoint case). Throws only with a
 *  human message the console shows verbatim. */
export function parseJsonRows(body: string, rowsPath: string): { columns: string[]; rows: DataRow[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new Error("response is not valid JSON");
  }
  const at = atPath(doc, rowsPath);
  if (at === undefined) throw new Error(`no data at path "${rowsPath}"`);
  const records = Array.isArray(at) ? at.map((row) => flattenRow(row)) : [flattenRow(at)];
  const table = tableFrom(records);
  if (table.columns.length === 0) throw new Error("no fields found in the response");
  return table;
}

/** Split one CSV line on commas, honouring "quoted, fields" and "" escapes. Never throws: an unclosed
 *  quote simply swallows the rest of the line (better a long cell than a dropped row). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/** CSV → table. Row 1 is the header (blank/duplicate names get positional fallbacks). RAGGED rows are
 *  the norm in the field: short rows are null-padded, long rows are truncated to the header — a row
 *  is never dropped for being the wrong shape, and never rendered half-full. */
export function parseCsv(body: string): { columns: string[]; rows: DataRow[] } {
  const lines = body
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("the CSV is empty");
  const header = splitCsvLine(lines[0]!).slice(0, MAX_DATA_COLUMNS);
  const columns: string[] = [];
  header.forEach((raw, i) => {
    const name = raw.trim() || `column${i + 1}`;
    columns.push(columns.includes(name) ? `${name}_${i + 1}` : name);
  });
  if (columns.length === 0) throw new Error("the CSV has no header row");

  const rows: DataRow[] = [];
  for (const line of lines.slice(1, MAX_DATA_ROWS + 1)) {
    const cells = splitCsvLine(line);
    const row: DataRow = {};
    columns.forEach((column, i) => {
      row[column] = i < cells.length ? coerceScalar(cells[i]!) : null;
    });
    rows.push(row);
  }
  return { columns, rows };
}

/** The auth a data source's SERVER-side fetch carries, resolved at request time from the POL-24
 *  token cache. Held for the length of one fetch and never stored (D19's clean-at-rest rule). */
export interface DataSourceAuth {
  in: DataSourceAuthIn;
  /** Query-parameter name (the profile's `tokenParam`), used when `in` is "query". */
  param: string;
  token: string;
}

/** One configured data source, as the poller needs it. */
export interface DataSourceSpec {
  id: string;
  url: string;
  format: DataSourceFormat;
  pollSeconds: number;
  rowsPath: string;
}

/** The poll health of one data source, denormalised into the console's DataSourceView. */
export interface DataSourceHealth {
  status: DataSourceStatus;
  lastFetchedAt?: string;
  lastError?: string;
  rowCount: number;
  columns: string[];
  sample: DataRow[];
}

/** What the poller needs from the control plane — kept narrow so tests can stub it. */
export interface PageDataControl {
  pageDataRequirements(): {
    feeds: Set<string>;
    locations: Set<string>;
    sourcesByFeed: Map<string, Set<string>>;
    sourcesByLocation: Map<string, Set<string>>;
    /** POL-99 — data-source ids bound by a page that is ON GLASS (assigned to ≥1 screen). */
    dataSources: Set<string>;
    sourcesByDataSource: Map<string, Set<string>>;
  };
  /** POL-99 — every CONFIGURED data source (on glass or not): the poll specs + what health to keep. */
  dataSourceSpecs(): DataSourceSpec[];
  /** POL-99 — the CURRENT credential-profile token for a data source, resolved per fetch. */
  dataSourceAuth(id: string): DataSourceAuth | undefined;
}

interface PageDataServiceOptions {
  control: PageDataControl;
  /** Called with the page-source ids whose data CHANGED this tick — the caller re-pushes their slices. */
  onChange: (sourceIds: Set<string>) => void;
  log?: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  feedPollMs?: number;
  weatherPollMs?: number;
  tickMs?: number;
}

interface FeedEntry {
  data?: PageFeedData;
  lastAttemptMs: number;
}

interface WeatherEntry {
  data?: PageWeatherData;
  lastAttemptMs: number;
}

/** One data source's cache slot: the last-good table (which SURVIVES failures, flagged `stale`) plus
 *  the last attempt/outcome. `data` absent + `lastError` set = the honest "never worked" case. */
interface DataEntry {
  data?: DataSet;
  lastAttemptMs: number;
  lastError?: string;
}

/** Did the VALUES change? (Cheap structural compare — `fetchedAt` always moves, so it can't be it.) */
function sameRows(a: DataSet, b: DataSet): boolean {
  return JSON.stringify(a.rows) === JSON.stringify(b.rows) && JSON.stringify(a.columns) === JSON.stringify(b.columns);
}

export class PageDataService implements PageDataProvider {
  private readonly control: PageDataControl;
  private readonly onChange: (sourceIds: Set<string>) => void;
  private readonly log?: PageDataServiceOptions["log"];
  private readonly fetchFn: typeof fetch;
  private readonly feedPollMs: number;
  private readonly weatherPollMs: number;
  private readonly tickMs: number;

  /** normalised feed url → last-good data + last attempt time (attempts throttle, data persists). */
  private readonly feeds = new Map<string, FeedEntry>();
  /** lower-cased location → last-good weather + last attempt time. */
  private readonly weather = new Map<string, WeatherEntry>();
  /** lower-cased location → geocoded coordinates, or null when the geocoder found nothing (also
   *  cached: retrying a typo every tick helps nobody). */
  private readonly geocode = new Map<string, { lat: number; lon: number; name: string } | null>();
  /** POL-99 — data-source id → last-good table + last attempt/outcome. */
  private readonly datasets = new Map<string, DataEntry>();

  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(opts: PageDataServiceOptions) {
    this.control = opts.control;
    this.onChange = opts.onChange;
    this.log = opts.log;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.feedPollMs = opts.feedPollMs ?? Number(process.env.PAGE_FEED_POLL_MS ?? DEFAULT_FEED_POLL_MS);
    this.weatherPollMs =
      opts.weatherPollMs ?? Number(process.env.PAGE_WEATHER_POLL_MS ?? DEFAULT_WEATHER_POLL_MS);
    this.tickMs = opts.tickMs ?? Number(process.env.PAGE_DATA_TICK_MS ?? DEFAULT_TICK_MS);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // Prime immediately so a restart repopulates data without waiting a tick.
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ── PageDataProvider (consumed by decorateSliceForSend) ─────────────────────

  feedFor(url: string): PageFeedData | undefined {
    return this.feeds.get(normalizeFeedUrl(url))?.data;
  }

  weatherFor(location: string): PageWeatherData | undefined {
    return this.weather.get(location.trim().toLowerCase())?.data;
  }

  /** POL-99 — the last-good table for a data source (already carrying its `stale` flag), if the
   *  poller ever got one. Absent = the elements bound to it draw their no-data tell. */
  datasetFor(dataSourceId: string): DataSet | undefined {
    return this.datasets.get(dataSourceId)?.data;
  }

  /** POL-99 — poll health for the console (per configured source). Unattempted = "pending". */
  dataSourceHealth(dataSourceId: string): DataSourceHealth {
    const entry = this.datasets.get(dataSourceId);
    const rows = entry?.data?.rows ?? [];
    const status: DataSourceStatus = !entry
      ? "pending"
      : entry.lastError === undefined
        ? "ok"
        : entry.data
          ? "stale"
          : "error";
    return {
      status,
      ...(entry?.data ? { lastFetchedAt: entry.data.fetchedAt } : {}),
      ...(entry?.lastError ? { lastError: entry.lastError } : {}),
      rowCount: rows.length,
      columns: entry?.data?.columns ?? [],
      sample: rows.slice(0, SAMPLE_ROWS),
    };
  }

  /**
   * POL-99 — fetch ONE data source right now, regardless of cadence or whether a page shows it: the
   * console's "Test" button and the Studio's binding picker (which needs field names for an endpoint
   * that is not yet on any wall). The result is cached like any poll, so testing also warms the wall.
   */
  async testDataSource(spec: DataSourceSpec): Promise<{ ok: true; data: DataSet } | { ok: false; error: string }> {
    const result = await this.fetchDataSet(spec);
    const now = Date.now();
    if (result.ok) {
      this.datasets.set(spec.id, { data: result.data, lastAttemptMs: now });
      return result;
    }
    const previous = this.datasets.get(spec.id)?.data;
    this.datasets.set(spec.id, {
      ...(previous ? { data: { ...previous, stale: true } } : {}),
      lastAttemptMs: now,
      lastError: result.error,
    });
    return result;
  }

  // ── The poll loop ────────────────────────────────────────────────────────────

  /** One sweep: fetch every due/new feed + location required by an assigned page. Public for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return; // a slow provider must not stack sweeps
    this.ticking = true;
    try {
      const now = Date.now();
      const req = this.control.pageDataRequirements();
      const changed = new Set<string>();

      for (const rawUrl of req.feeds) {
        const url = normalizeFeedUrl(rawUrl);
        const entry = this.feeds.get(url);
        if (entry && now - entry.lastAttemptMs < this.feedPollMs) continue;
        this.feeds.set(url, { data: entry?.data, lastAttemptMs: now });
        const data = await this.fetchFeed(url);
        if (data) {
          const previous = this.feeds.get(url)?.data;
          this.feeds.set(url, { data, lastAttemptMs: now });
          if (JSON.stringify(previous?.items) !== JSON.stringify(data.items)) {
            for (const id of req.sourcesByFeed.get(rawUrl) ?? []) changed.add(id);
          }
        }
        // Failure: keep last-good (already in the map), attempt time already stamped.
      }

      for (const rawLocation of req.locations) {
        const key = rawLocation.trim().toLowerCase();
        const entry = this.weather.get(key);
        if (entry && now - entry.lastAttemptMs < this.weatherPollMs) continue;
        this.weather.set(key, { data: entry?.data, lastAttemptMs: now });
        const data = await this.fetchWeather(rawLocation.trim());
        if (data) {
          const previous = this.weather.get(key)?.data;
          this.weather.set(key, { data, lastAttemptMs: now });
          if (previous?.tempC !== data.tempC || previous?.code !== data.code) {
            for (const id of req.sourcesByLocation.get(rawLocation) ?? []) changed.add(id);
          }
        }
      }

      // POL-99 — data sources: poll ONLY those a page on glass actually binds (an endpoint nobody
      // shows costs nothing), each on its OWN cadence. A failure keeps the last-good table and flips
      // it to `stale`, which is itself a change worth pushing: the wall must gain its stale tell.
      const specs = this.control.dataSourceSpecs();
      for (const spec of specs) {
        if (!req.dataSources.has(spec.id)) continue;
        const entry = this.datasets.get(spec.id);
        const dueMs = Math.max(0, spec.pollSeconds) * 1000;
        if (entry && now - entry.lastAttemptMs < dueMs) continue;

        const result = await this.fetchDataSet(spec);
        const previous = this.datasets.get(spec.id)?.data;
        if (result.ok) {
          this.datasets.set(spec.id, { data: result.data, lastAttemptMs: now });
          if (!previous || previous.stale || !sameRows(previous, result.data)) {
            for (const id of req.sourcesByDataSource.get(spec.id) ?? []) changed.add(id);
          }
        } else {
          this.log?.warn(
            { event: "page-data.dataset", dataSourceId: spec.id, err: result.error },
            "data source poll failed",
          );
          this.datasets.set(spec.id, {
            ...(previous ? { data: { ...previous, stale: true } } : {}),
            lastAttemptMs: now,
            lastError: result.error,
          });
          // Newly stale (or newly empty) → re-push so the wall shows the tell instead of pretending.
          if (previous && !previous.stale) {
            for (const id of req.sourcesByDataSource.get(spec.id) ?? []) changed.add(id);
          }
        }
      }

      // Drop cache entries nothing requires any more (page unassigned/deleted) so memory is bounded
      // by what is on air. Geocode results stay — they are tiny and re-assigning is common.
      const wantedFeeds = new Set([...req.feeds].map(normalizeFeedUrl));
      for (const url of this.feeds.keys()) if (!wantedFeeds.has(url)) this.feeds.delete(url);
      const wantedLocations = new Set([...req.locations].map((l) => l.trim().toLowerCase()));
      for (const key of this.weather.keys()) if (!wantedLocations.has(key)) this.weather.delete(key);
      // Dataset health outlives "on glass" (the console shows it for every CONFIGURED source) but a
      // DELETED source's cache goes.
      const configured = new Set(specs.map((s) => s.id));
      for (const id of this.datasets.keys()) if (!configured.has(id)) this.datasets.delete(id);

      if (changed.size > 0) this.onChange(changed);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * POL-99 — one data-source fetch: credential-stamped (POL-24 token, at REQUEST time — never stored),
   * timeout-bounded, and normalised to the contract's table. Every failure — transport, timeout, a
   * 500, unparseable body, an empty table — comes back as a HUMAN message, which becomes the console's
   * health line and (via last-good + `stale`) the wall's tell.
   */
  private async fetchDataSet(spec: DataSourceSpec): Promise<{ ok: true; data: DataSet } | { ok: false; error: string }> {
    const auth = this.control.dataSourceAuth(spec.id);
    let url = spec.url;
    const headers: Record<string, string> = { "user-agent": "polyptic-server (data-source poller)" };
    if (auth?.in === "header") headers.authorization = `Bearer ${auth.token}`;
    if (auth?.in === "query") {
      try {
        const parsed = new URL(spec.url);
        parsed.searchParams.set(auth.param, auth.token);
        url = parsed.toString();
      } catch {
        // The URL was validated at the edge; if it somehow won't parse, fetch it unstamped and let
        // the endpoint's own 401 be the (visible) failure.
      }
    }

    let body: string;
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers });
      if (!res.ok) return { ok: false, error: `endpoint returned HTTP ${res.status}` };
      body = await res.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: /timed out|timeout|abort/i.test(message) ? "endpoint timed out" : message };
    }

    try {
      const table = spec.format === "csv" ? parseCsv(body) : parseJsonRows(body, spec.rowsPath);
      if (table.rows.length === 0) return { ok: false, error: "the endpoint returned no rows" };
      return {
        ok: true,
        data: { columns: table.columns, rows: table.rows, fetchedAt: new Date().toISOString(), stale: false },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async fetchText(url: string): Promise<string | null> {
    try {
      const res = await this.fetchFn(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "polyptic-server (page framing poller)" },
      });
      if (!res.ok) {
        this.log?.warn({ event: "page-data.fetch", url, status: res.status }, "page-data fetch failed");
        return null;
      }
      return await res.text();
    } catch (err) {
      this.log?.warn({ event: "page-data.fetch", url, err: String(err) }, "page-data fetch failed");
      return null;
    }
  }

  private async fetchFeed(url: string): Promise<PageFeedData | null> {
    const xml = await this.fetchText(url);
    if (xml === null) return null;
    const parsed = parseFeed(xml);
    if (parsed.items.length === 0) {
      this.log?.warn({ event: "page-data.feed.empty", url }, "feed parsed to zero items");
      return null; // keep last-good rather than blanking the wall's card
    }
    return {
      items: parsed.items,
      fetchedAt: new Date().toISOString(),
      ...(parsed.title ? { title: parsed.title } : {}),
    };
  }

  private async fetchWeather(location: string): Promise<PageWeatherData | null> {
    const key = location.toLowerCase();
    let coords = this.geocode.get(key);
    if (coords === undefined) {
      const body = await this.fetchText(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
      );
      if (body === null) return null; // transient — retry next due tick, geocode NOT negative-cached
      try {
        const json = JSON.parse(body) as {
          results?: { latitude: number; longitude: number; name: string }[];
        };
        const hit = json.results?.[0];
        coords = hit ? { lat: hit.latitude, lon: hit.longitude, name: hit.name } : null;
        this.geocode.set(key, coords);
      } catch {
        return null;
      }
    }
    if (coords === null) return null; // unknown place — cached, shown as the element's placeholder

    const body = await this.fetchText(
      `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,weather_code`,
    );
    if (body === null) return null;
    try {
      const json = JSON.parse(body) as { current?: { temperature_2m?: number; weather_code?: number } };
      const temp = json.current?.temperature_2m;
      const code = json.current?.weather_code ?? 0;
      if (typeof temp !== "number") return null;
      return {
        tempC: temp,
        code,
        description: weatherDescription(code),
        location: coords.name || location,
        fetchedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }
}
