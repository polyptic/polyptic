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
import type { PageFeedData, PageFeedItem, PageWeatherData } from "@polyptic/protocol";
import type { PageDataProvider } from "./state";

const DEFAULT_FEED_POLL_MS = 5 * 60_000;
const DEFAULT_WEATHER_POLL_MS = 15 * 60_000;
const DEFAULT_TICK_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
/** Cap parsed items per feed — element props show at most 8; keep a little slack for re-renders. */
const MAX_FEED_ITEMS = 12;

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

/** What the poller needs from the control plane — kept narrow so tests can stub it. */
export interface PageDataControl {
  pageDataRequirements(): {
    feeds: Set<string>;
    locations: Set<string>;
    sourcesByFeed: Map<string, Set<string>>;
    sourcesByLocation: Map<string, Set<string>>;
  };
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

      // Drop cache entries nothing requires any more (page unassigned/deleted) so memory is bounded
      // by what is on air. Geocode results stay — they are tiny and re-assigning is common.
      const wantedFeeds = new Set([...req.feeds].map(normalizeFeedUrl));
      for (const url of this.feeds.keys()) if (!wantedFeeds.has(url)) this.feeds.delete(url);
      const wantedLocations = new Set([...req.locations].map((l) => l.trim().toLowerCase()));
      for (const key of this.weather.keys()) if (!wantedLocations.has(key)) this.weather.delete(key);

      if (changed.size > 0) this.onChange(changed);
    } finally {
      this.ticking = false;
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
