/**
 * POL-99 — data sources: the parsers, the poller, and (the point of the ticket) the FAILURE MODES.
 *
 * The wall's contract is: never blank, never a half-row, never a silent lie. So these tests pin
 *   - JSON (incl. a rows path, a lone object, nested fields) and CSV (quoted, ragged, malformed);
 *   - an endpoint that 500s / times out / returns garbage keeps LAST-GOOD rows, flagged `stale`,
 *     and re-pushes so the wall gains its stale tell;
 *   - an endpoint that never worked yields NO dataset (the elements draw their no-data tell) plus a
 *     human error the console shows;
 *   - a credentialed endpoint is fetched with the profile's CURRENT token (bearer or query), and the
 *     token is never stored on the source;
 *   - polling is scoped to pages on glass and honours each source's own cadence.
 *
 * The last block runs against a REAL local HTTP server (Bun.serve) — CSV, a credentialed endpoint,
 * a 500 and a slow endpoint — so the fetch path itself (headers, status, body) is exercised, not a
 * stub's idea of it.
 */
import { describe, expect, test } from "bun:test";

import { PageDataService, parseCsv, parseJsonRows } from "../src/page-data";
import type { DataSourceAuth, DataSourceSpec, PageDataControl } from "../src/page-data";

// ─────────────────────────────────────────────────────────────────────────────
// Parsers
// ─────────────────────────────────────────────────────────────────────────────

describe("parseJsonRows", () => {
  test("an array of objects becomes a table, column order = first appearance", () => {
    const table = parseJsonRows(`[{"name":"A","value":3},{"name":"B","value":4}]`, "");
    expect(table.columns).toEqual(["name", "value"]);
    expect(table.rows).toEqual([
      { name: "A", value: 3 },
      { name: "B", value: 4 },
    ]);
  });

  test("a rows path walks into the document (and a bad path is a HUMAN error)", () => {
    const body = `{"data":{"items":[{"q":1}]}}`;
    expect(parseJsonRows(body, "data.items").rows).toEqual([{ q: 1 }]);
    expect(() => parseJsonRows(body, "data.nope")).toThrow('no data at path "data.nope"');
  });

  test("a lone object is a ONE-row table (the KPI-endpoint case), nested fields flatten to dots", () => {
    const table = parseJsonRows(`{"queue":{"depth":12},"open":true}`, "");
    expect(table.columns).toEqual(["queue.depth", "open"]);
    expect(table.rows[0]).toEqual({ "queue.depth": 12, open: "true" });
  });

  test("ragged objects are null-filled — every row carries every column (no half-rows)", () => {
    const table = parseJsonRows(`[{"a":1,"b":2},{"a":3}]`, "");
    expect(table.columns).toEqual(["a", "b"]);
    expect(table.rows[1]).toEqual({ a: 3, b: null });
  });

  test("invalid JSON throws a message an operator can act on", () => {
    expect(() => parseJsonRows("<html>nope</html>", "")).toThrow("response is not valid JSON");
  });
});

describe("parseCsv", () => {
  test("headers, quoted cells with commas, and numeric coercion", () => {
    const table = parseCsv('name,price\r\n"Beans, baked",1.25\nBread,0.9\n');
    expect(table.columns).toEqual(["name", "price"]);
    expect(table.rows).toEqual([
      { name: "Beans, baked", price: 1.25 },
      { name: "Bread", price: 0.9 },
    ]);
  });

  test("MALFORMED csv: ragged rows are padded/truncated, an unclosed quote does not drop a row", () => {
    const table = parseCsv('a,b,c\n1,2\n4,5,6,7\n"unclosed,8,9\n');
    expect(table.columns).toEqual(["a", "b", "c"]);
    // Short row → nulls, never a half-row.
    expect(table.rows[0]).toEqual({ a: 1, b: 2, c: null });
    // Long row → truncated to the header.
    expect(table.rows[1]).toEqual({ a: 4, b: 5, c: 6 });
    // Unclosed quote → one long cell, but the row is still THERE with every column.
    expect(Object.keys(table.rows[2]!)).toEqual(["a", "b", "c"]);
  });

  test("blank/duplicate headers get positional names rather than colliding", () => {
    const table = parseCsv("a,,a\n1,2,3");
    expect(table.columns).toEqual(["a", "column2", "a_3"]);
  });

  test("an empty body is an error, not an empty wall", () => {
    expect(() => parseCsv("   \n")).toThrow("the CSV is empty");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The poller
// ─────────────────────────────────────────────────────────────────────────────

interface StubOpts {
  specs: DataSourceSpec[];
  onGlass: string[];
  auth?: Record<string, DataSourceAuth>;
  /** page source ids to re-push per data-source id */
  pages?: Record<string, string[]>;
}

function stubControl(opts: StubOpts): PageDataControl {
  return {
    pageDataRequirements: () => ({
      feeds: new Set<string>(),
      locations: new Set<string>(),
      sourcesByFeed: new Map(),
      sourcesByLocation: new Map(),
      dataSources: new Set(opts.onGlass),
      sourcesByDataSource: new Map(
        Object.entries(opts.pages ?? {}).map(([id, pages]) => [id, new Set(pages)]),
      ),
    }),
    dataSourceSpecs: () => opts.specs,
    dataSourceAuth: (id) => opts.auth?.[id],
  };
}

const JSON_SPEC: DataSourceSpec = {
  id: "data-1",
  url: "https://example.test/kpi.json",
  format: "json",
  pollSeconds: 10,
  rowsPath: "",
};

/** A fetch stub whose responses (and recorded requests) the test drives. */
function stubFetch(responses: () => { status?: number; body?: string } | Error, seen: RequestInit[] = []) {
  const fn = (async (_url: unknown, init?: RequestInit) => {
    seen.push(init ?? {});
    const next = responses();
    if (next instanceof Error) throw next;
    return new Response(next.body ?? "", { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

describe("PageDataService — data sources", () => {
  test("a good poll produces a dataset and re-pushes the pages showing it", async () => {
    const changed: string[] = [];
    const { fn } = stubFetch(() => ({ body: `[{"line":"A","output":92}]` }));
    const service = new PageDataService({
      control: stubControl({ specs: [JSON_SPEC], onGlass: ["data-1"], pages: { "data-1": ["source-9"] } }),
      onChange: (ids) => changed.push(...ids),
      fetchFn: fn,
    });

    await service.tick();

    const set = service.datasetFor("data-1")!;
    expect(set.columns).toEqual(["line", "output"]);
    expect(set.rows).toEqual([{ line: "A", output: 92 }]);
    expect(set.stale).toBe(false);
    expect(changed).toEqual(["source-9"]);
    expect(service.dataSourceHealth("data-1").status).toBe("ok");
  });

  test("ENDPOINT 500s → last-good rows STAY on glass, flagged stale, and the wall is re-pushed", async () => {
    let fail = false;
    const changed: string[][] = [];
    const { fn } = stubFetch(() => (fail ? { status: 500 } : { body: `[{"v":1}]` }));
    const service = new PageDataService({
      control: stubControl({ specs: [{ ...JSON_SPEC, pollSeconds: 0 }], onGlass: ["data-1"], pages: { "data-1": ["source-9"] } }),
      onChange: (ids) => changed.push([...ids]),
      fetchFn: fn,
    });

    await service.tick();
    expect(service.datasetFor("data-1")?.stale).toBe(false);

    fail = true;
    await service.tick();

    const set = service.datasetFor("data-1")!;
    expect(set.rows).toEqual([{ v: 1 }]); // last-good survives — the wall never blanks
    expect(set.stale).toBe(true); // …but it is marked, so the element draws its tell
    expect(changed[1]).toEqual(["source-9"]); // newly-stale is itself a change worth pushing

    const health = service.dataSourceHealth("data-1");
    expect(health.status).toBe("stale");
    expect(health.lastError).toBe("endpoint returned HTTP 500");
  });

  test("an endpoint that NEVER worked yields no dataset and an honest error (no invented rows)", async () => {
    const { fn } = stubFetch(() => ({ status: 503 }));
    const service = new PageDataService({
      control: stubControl({ specs: [JSON_SPEC], onGlass: ["data-1"] }),
      onChange: () => {},
      fetchFn: fn,
    });

    await service.tick();

    expect(service.datasetFor("data-1")).toBeUndefined();
    const health = service.dataSourceHealth("data-1");
    expect(health.status).toBe("error");
    expect(health.lastError).toBe("endpoint returned HTTP 503");
    expect(health.rowCount).toBe(0);
  });

  test("GARBAGE body (valid HTTP, unparseable payload) also keeps last-good + stale", async () => {
    let garbage = false;
    const { fn } = stubFetch(() => ({ body: garbage ? "<html>502 Bad Gateway</html>" : `[{"v":7}]` }));
    const service = new PageDataService({
      control: stubControl({ specs: [{ ...JSON_SPEC, pollSeconds: 0 }], onGlass: ["data-1"] }),
      onChange: () => {},
      fetchFn: fn,
    });
    await service.tick();
    garbage = true;
    await service.tick();

    expect(service.datasetFor("data-1")?.rows).toEqual([{ v: 7 }]);
    expect(service.datasetFor("data-1")?.stale).toBe(true);
    expect(service.dataSourceHealth("data-1").lastError).toBe("response is not valid JSON");
  });

  test("a SLOW endpoint (fetch aborts on the timeout) is a failure like any other — never a hang", async () => {
    const { fn } = stubFetch(() => Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }));
    const service = new PageDataService({
      control: stubControl({ specs: [JSON_SPEC], onGlass: ["data-1"] }),
      onChange: () => {},
      fetchFn: fn,
    });

    await service.tick();

    expect(service.datasetFor("data-1")).toBeUndefined();
    expect(service.dataSourceHealth("data-1").lastError).toBe("endpoint timed out");
  });

  test("only sources a page ON GLASS binds are polled; an unbound endpoint costs nothing", async () => {
    let calls = 0;
    const { fn } = stubFetch(() => {
      calls += 1;
      return { body: `[{"v":1}]` };
    });
    const service = new PageDataService({
      control: stubControl({ specs: [JSON_SPEC, { ...JSON_SPEC, id: "data-2" }], onGlass: ["data-1"] }),
      onChange: () => {},
      fetchFn: fn,
    });

    await service.tick();

    expect(calls).toBe(1);
    expect(service.datasetFor("data-2")).toBeUndefined();
    expect(service.dataSourceHealth("data-2").status).toBe("pending");
  });

  test("each source polls on its OWN cadence — a tick before it is due fetches nothing", async () => {
    let calls = 0;
    const { fn } = stubFetch(() => {
      calls += 1;
      return { body: `[{"v":1}]` };
    });
    const service = new PageDataService({
      control: stubControl({ specs: [{ ...JSON_SPEC, pollSeconds: 3600 }], onGlass: ["data-1"] }),
      onChange: () => {},
      fetchFn: fn,
    });

    await service.tick();
    await service.tick();
    await service.tick();

    expect(calls).toBe(1);
  });

  test("unchanged rows do NOT re-push (a wall is not redrawn for a fetch that changed nothing)", async () => {
    const changed: string[][] = [];
    const { fn } = stubFetch(() => ({ body: `[{"v":1}]` }));
    const service = new PageDataService({
      control: stubControl({ specs: [{ ...JSON_SPEC, pollSeconds: 0 }], onGlass: ["data-1"], pages: { "data-1": ["source-9"] } }),
      onChange: (ids) => changed.push([...ids]),
      fetchFn: fn,
    });

    await service.tick();
    await service.tick();

    expect(changed).toEqual([["source-9"]]); // the first poll only
  });

  test("a deleted source's cache is dropped (memory is bounded by what is configured)", async () => {
    const { fn } = stubFetch(() => ({ body: `[{"v":1}]` }));
    let specs: DataSourceSpec[] = [JSON_SPEC];
    const service = new PageDataService({
      control: {
        pageDataRequirements: () => ({
          feeds: new Set<string>(),
          locations: new Set<string>(),
          sourcesByFeed: new Map(),
          sourcesByLocation: new Map(),
          dataSources: new Set(specs.map((s) => s.id)),
          sourcesByDataSource: new Map(),
        }),
        dataSourceSpecs: () => specs,
        dataSourceAuth: () => undefined,
      },
      onChange: () => {},
      fetchFn: fn,
    });

    await service.tick();
    expect(service.datasetFor("data-1")).toBeDefined();

    specs = [];
    await service.tick();
    expect(service.datasetFor("data-1")).toBeUndefined();
  });

  test("a credentialed source is fetched with the CURRENT token — bearer header or query param", async () => {
    const seen: RequestInit[] = [];
    const urls: string[] = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      seen.push(init ?? {});
      return new Response(`[{"v":1}]`, { status: 200 });
    }) as unknown as typeof fetch;

    const header = new PageDataService({
      control: stubControl({
        specs: [JSON_SPEC],
        onGlass: ["data-1"],
        auth: { "data-1": { in: "header", param: "auth_token", token: "TOK-1" } },
      }),
      onChange: () => {},
      fetchFn,
    });
    await header.tick();
    expect((seen[0]!.headers as Record<string, string>).authorization).toBe("Bearer TOK-1");
    expect(urls[0]).toBe("https://example.test/kpi.json"); // untouched

    const query = new PageDataService({
      control: stubControl({
        specs: [JSON_SPEC],
        onGlass: ["data-1"],
        auth: { "data-1": { in: "query", param: "auth_token", token: "TOK-2" } },
      }),
      onChange: () => {},
      fetchFn,
    });
    await query.tick();
    expect(urls[1]).toBe("https://example.test/kpi.json?auth_token=TOK-2");
    expect((seen[1]!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("testDataSource fetches NOW regardless of cadence or glass, and warms the cache", async () => {
    const { fn } = stubFetch(() => ({ body: `[{"v":5}]` }));
    const service = new PageDataService({
      control: stubControl({ specs: [{ ...JSON_SPEC, pollSeconds: 86400 }], onGlass: [] }),
      onChange: () => {},
      fetchFn: fn,
    });

    const result = await service.testDataSource({ ...JSON_SPEC, pollSeconds: 86400 });

    expect(result.ok).toBe(true);
    expect(service.datasetFor("data-1")?.rows).toEqual([{ v: 5 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Against a REAL HTTP server: CSV, a credentialed endpoint, a 500, and a slow one.
// ─────────────────────────────────────────────────────────────────────────────

describe("PageDataService — real endpoints (Bun.serve)", () => {
  test("CSV, credentialed, 500 and slow endpoints behave as the wall needs", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/menu.csv") {
          return new Response("dish,price\nPie & mash,4.20\n\"Soup, of the day\",3.10\n");
        }
        if (url.pathname === "/private.json") {
          const bearer = request.headers.get("authorization");
          if (bearer !== "Bearer SECRET") return new Response("no", { status: 401 });
          return new Response(JSON.stringify({ rows: [{ team: "Ops", open: 3 }] }));
        }
        if (url.pathname === "/boom") return new Response("kaboom", { status: 500 });
        if (url.pathname === "/slow") {
          await Bun.sleep(300);
          return new Response("[]");
        }
        return new Response("not found", { status: 404 });
      },
    });
    const base = `http://localhost:${server.port}`;

    try {
      const service = new PageDataService({
        control: stubControl({ specs: [], onGlass: [] }),
        onChange: () => {},
      });

      // CSV, over the wire.
      const csv = await service.testDataSource({
        id: "csv",
        url: `${base}/menu.csv`,
        format: "csv",
        pollSeconds: 60,
        rowsPath: "",
      });
      expect(csv.ok).toBe(true);
      if (csv.ok) {
        expect(csv.data.columns).toEqual(["dish", "price"]);
        expect(csv.data.rows).toEqual([
          { dish: "Pie & mash", price: 4.2 },
          { dish: "Soup, of the day", price: 3.1 },
        ]);
      }

      // Credentialed: the token really does travel as a bearer header, and without it we get a 401.
      const authed = new PageDataService({
        control: stubControl({
          specs: [],
          onGlass: [],
          auth: { private: { in: "header", param: "auth_token", token: "SECRET" } },
        }),
        onChange: () => {},
      });
      const ok = await authed.testDataSource({
        id: "private",
        url: `${base}/private.json`,
        format: "json",
        pollSeconds: 60,
        rowsPath: "rows",
      });
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.data.rows).toEqual([{ team: "Ops", open: 3 }]);

      const unauthed = await service.testDataSource({
        id: "private",
        url: `${base}/private.json`,
        format: "json",
        pollSeconds: 60,
        rowsPath: "rows",
      });
      expect(unauthed.ok).toBe(false);
      if (!unauthed.ok) expect(unauthed.error).toBe("endpoint returned HTTP 401");

      // A 500 is a human message, not an exception.
      const boom = await service.testDataSource({
        id: "boom",
        url: `${base}/boom`,
        format: "json",
        pollSeconds: 60,
        rowsPath: "",
      });
      expect(boom.ok).toBe(false);
      if (!boom.ok) expect(boom.error).toBe("endpoint returned HTTP 500");

      // A slow endpoint that answers within the timeout still fails HONESTLY if it has no rows —
      // "the endpoint returned no rows" beats a blank card that looks like a working empty table.
      const slow = await service.testDataSource({
        id: "slow",
        url: `${base}/slow`,
        format: "json",
        pollSeconds: 60,
        rowsPath: "",
      });
      expect(slow.ok).toBe(false);
      if (!slow.ok) expect(slow.error).toBe("no fields found in the response");
    } finally {
      await server.stop(true);
    }
  });
});
