/**
 * POL-42 — the page-data poller: tolerant RSS/Atom parsing, Open-Meteo weather (geocode + current),
 * last-good-on-failure semantics, change-driven re-push, and requirement-scoped polling. All against
 * a stubbed fetch — no network.
 */
import { describe, expect, test } from "bun:test";

import { PageDataService, normalizeFeedUrl, parseFeed, weatherDescription } from "../src/page-data";
import type { PageDataControl } from "../src/page-data";

// ─────────────────────────────────────────────────────────────────────────────
// parseFeed — RSS 2.0
// ─────────────────────────────────────────────────────────────────────────────

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example News</title>
  <link>https://example.test</link>
  <item>
    <title>First &amp; foremost</title>
    <link>https://example.test/1</link>
    <pubDate>Fri, 10 Jul 2026 08:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[Second <b>story</b>]]></title>
    <link>https://example.test/2</link>
  </item>
  <item><description>no title — dropped</description></item>
</channel></rss>`;

describe("parseFeed — RSS 2.0", () => {
  test("extracts channel title and items with title/link/timestamp", () => {
    const feed = parseFeed(RSS);
    expect(feed.title).toBe("Example News");
    expect(feed.items.length).toBe(2);
    expect(feed.items[0]).toEqual({
      title: "First & foremost",
      link: "https://example.test/1",
      publishedAt: new Date("2026-07-10T08:00:00Z").toISOString(),
    });
  });

  test("CDATA is unwrapped and inline markup stripped", () => {
    const feed = parseFeed(RSS);
    expect(feed.items[1]?.title).toBe("Second story");
    expect(feed.items[1]?.publishedAt).toBeUndefined();
  });

  test("an unparseable pubDate drops the timestamp, not the item", () => {
    const feed = parseFeed(
      `<rss><channel><title>T</title><item><title>x</title><pubDate>not a date</pubDate></item></channel></rss>`,
    );
    expect(feed.items[0]?.title).toBe("x");
    expect(feed.items[0]?.publishedAt).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseFeed — Atom
// ─────────────────────────────────────────────────────────────────────────────

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <entry>
    <title>Entry one</title>
    <link rel="self" href="https://example.test/self.xml"/>
    <link rel="alternate" href="https://example.test/e1"/>
    <updated>2026-07-11T09:00:00Z</updated>
  </entry>
  <entry>
    <title>Entry two</title>
    <link href="https://example.test/e2"/>
  </entry>
</feed>`;

describe("parseFeed — Atom", () => {
  test("extracts feed title and entries, preferring rel=alternate links", () => {
    const feed = parseFeed(ATOM);
    expect(feed.title).toBe("Atom Blog");
    expect(feed.items.length).toBe(2);
    expect(feed.items[0]?.link).toBe("https://example.test/e1");
    expect(feed.items[0]?.publishedAt).toBe("2026-07-11T09:00:00.000Z");
    expect(feed.items[1]?.link).toBe("https://example.test/e2");
  });

  test("garbage input parses to zero items, never throws", () => {
    expect(parseFeed("not xml at all").items).toEqual([]);
    expect(parseFeed("<rss><channel><item><title></title></item></channel></rss>").items).toEqual([]);
  });
});

describe("normalizeFeedUrl", () => {
  test("prepends https:// to a scheme-less operator-typed url", () => {
    expect(normalizeFeedUrl("feeds.bbci.co.uk/news/rss.xml")).toBe("https://feeds.bbci.co.uk/news/rss.xml");
    expect(normalizeFeedUrl("  http://a.test/f  ")).toBe("http://a.test/f");
  });
});

describe("weatherDescription", () => {
  test("maps the WMO bands to wall captions", () => {
    expect(weatherDescription(0)).toBe("clear sky");
    expect(weatherDescription(2)).toBe("partly cloudy");
    expect(weatherDescription(63)).toBe("rain");
    expect(weatherDescription(96)).toBe("thunderstorm");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PageDataService — poll loop against a stubbed fetch
// ─────────────────────────────────────────────────────────────────────────────

function controlWith(feeds: Record<string, string[]>, locations: Record<string, string[]> = {}): PageDataControl {
  return {
    pageDataRequirements() {
      return {
        feeds: new Set(Object.keys(feeds)),
        locations: new Set(Object.keys(locations)),
        sourcesByFeed: new Map(Object.entries(feeds).map(([k, v]) => [k, new Set(v)])),
        sourcesByLocation: new Map(Object.entries(locations).map(([k, v]) => [k, new Set(v)])),
        dataSources: new Set<string>(),
        sourcesByDataSource: new Map<string, Set<string>>(),
      };
    },
    dataSourceSpecs: () => [],
    dataSourceAuth: () => undefined,
  };
}

function stubFetch(handler: (url: string) => { status?: number; body?: string } | undefined): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const res = handler(url);
    if (!res) return new Response("not found", { status: 404 });
    return new Response(res.body ?? "", { status: res.status ?? 200 });
  }) as typeof fetch;
}

describe("PageDataService", () => {
  test("polls a required feed, exposes last-good data, and reports the changed page ids", async () => {
    const changes: Set<string>[] = [];
    let body = RSS;
    let fail = false;
    const service = new PageDataService({
      control: controlWith({ "feeds.example.test/rss": ["source-1", "source-2"] }),
      onChange: (ids) => changes.push(new Set(ids)),
      fetchFn: stubFetch(() => (fail ? { status: 503 } : { body })),
      feedPollMs: 0, // every tick is "due" so the test drives cadence itself
    });

    await service.tick();
    expect(changes.length).toBe(1);
    expect([...changes[0]!].sort()).toEqual(["source-1", "source-2"]);
    const data = service.feedFor("feeds.example.test/rss");
    expect(data?.items.length).toBe(2);
    expect(data?.title).toBe("Example News");

    // Same body again → no change, no re-push.
    await service.tick();
    expect(changes.length).toBe(1);

    // Provider down → LAST-GOOD data survives, nothing re-pushed.
    fail = true;
    await service.tick();
    expect(service.feedFor("feeds.example.test/rss")?.items.length).toBe(2);
    expect(changes.length).toBe(1);

    // Recovery with a new headline → change reported.
    fail = false;
    body = RSS.replace("First &amp; foremost", "Breaking: something new");
    await service.tick();
    expect(changes.length).toBe(2);
    expect(service.feedFor("feeds.example.test/rss")?.items[0]?.title).toBe("Breaking: something new");
  });

  test("a feed that parses to zero items keeps last-good data", async () => {
    let body = RSS;
    const service = new PageDataService({
      control: controlWith({ "https://f.test/rss": ["source-1"] }),
      onChange: () => {},
      fetchFn: stubFetch(() => ({ body })),
      feedPollMs: 0,
    });
    await service.tick();
    expect(service.feedFor("https://f.test/rss")?.items.length).toBe(2);
    body = "<html>maintenance page</html>";
    await service.tick();
    expect(service.feedFor("https://f.test/rss")?.items.length).toBe(2);
  });

  test("weather geocodes once, then serves cached coordinates to the forecast fetch", async () => {
    let geocodes = 0;
    let forecasts = 0;
    const service = new PageDataService({
      control: controlWith({}, { Sheffield: ["source-9"] }),
      onChange: () => {},
      fetchFn: stubFetch((url) => {
        if (url.includes("geocoding-api")) {
          geocodes += 1;
          return { body: JSON.stringify({ results: [{ latitude: 53.38, longitude: -1.47, name: "Sheffield" }] }) };
        }
        forecasts += 1;
        expect(url).toContain("latitude=53.38");
        return { body: JSON.stringify({ current: { temperature_2m: 17.6, weather_code: 2 } }) };
      }),
      weatherPollMs: 0,
    });

    await service.tick();
    await service.tick();
    expect(geocodes).toBe(1); // cached after the first resolve
    expect(forecasts).toBe(2);
    const data = service.weatherFor("sheffield"); // lookup is case-insensitive
    expect(data?.tempC).toBe(17.6);
    expect(data?.code).toBe(2);
    expect(data?.description).toBe("partly cloudy");
    expect(data?.location).toBe("Sheffield");
  });

  test("an unknown location is negative-cached — no forecast fetch, no data", async () => {
    let calls = 0;
    const service = new PageDataService({
      control: controlWith({}, { Atlantis: ["source-9"] }),
      onChange: () => {},
      fetchFn: stubFetch((url) => {
        calls += 1;
        expect(url).toContain("geocoding-api");
        return { body: JSON.stringify({ results: [] }) };
      }),
      weatherPollMs: 0,
    });
    await service.tick();
    await service.tick();
    expect(calls).toBe(1); // the empty geocode answer is cached; a typo is not retried every tick
    expect(service.weatherFor("Atlantis")).toBeUndefined();
  });

  test("data for a page no longer assigned anywhere is dropped from the cache", async () => {
    let feeds: Record<string, string[]> = { "https://f.test/rss": ["source-1"] };
    const control: PageDataControl = {
      pageDataRequirements: () => ({
        feeds: new Set(Object.keys(feeds)),
        locations: new Set(),
        sourcesByFeed: new Map(Object.entries(feeds).map(([k, v]) => [k, new Set(v)])),
        sourcesByLocation: new Map(),
        dataSources: new Set<string>(),
        sourcesByDataSource: new Map<string, Set<string>>(),
      }),
      dataSourceSpecs: () => [],
      dataSourceAuth: () => undefined,
    };
    const service = new PageDataService({
      control,
      onChange: () => {},
      fetchFn: stubFetch(() => ({ body: RSS })),
      feedPollMs: 0,
    });
    await service.tick();
    expect(service.feedFor("https://f.test/rss")).toBeDefined();
    feeds = {};
    await service.tick();
    expect(service.feedFor("https://f.test/rss")).toBeUndefined();
  });
});
