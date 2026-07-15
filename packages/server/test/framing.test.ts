/**
 * POL-18 — the framing probe: from a source URL's response headers to an "ok | blocked | unknown"
 * verdict. The pure judge (`framingVerdictFromHeaders`) is pinned across the real-world header
 * shapes; `probeFraming` is driven with an injected fetch so no network is touched.
 */
import { describe, expect, test } from "bun:test";

import { framingVerdictFromHeaders, probeFraming } from "../src/framing";
import type { FetchLike } from "../src/framing";

function res(headers: Record<string, string>): { headers: { get(n: string): string | null } } {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (n) => lower.get(n.toLowerCase()) ?? null } };
}

describe("framingVerdictFromHeaders", () => {
  test("no framing headers → ok", () => {
    expect(framingVerdictFromHeaders(null, null)).toBe("ok");
  });

  test("X-Frame-Options DENY / SAMEORIGIN / ALLOW-FROM all block a cross-origin wall", () => {
    expect(framingVerdictFromHeaders("DENY", null)).toBe("blocked");
    expect(framingVerdictFromHeaders("deny", null)).toBe("blocked");
    expect(framingVerdictFromHeaders("SAMEORIGIN", null)).toBe("blocked");
    expect(framingVerdictFromHeaders(" sameorigin ", null)).toBe("blocked");
    expect(framingVerdictFromHeaders("ALLOW-FROM https://a.example", null)).toBe("blocked");
  });

  test("an unrecognised XFO value is ignored (browsers ignore it too)", () => {
    expect(framingVerdictFromHeaders("ALLOWALL", null)).toBe("ok");
  });

  test("CSP frame-ancestors 'none' / 'self' / host allow-lists block; * allows", () => {
    expect(framingVerdictFromHeaders(null, "frame-ancestors 'none'")).toBe("blocked");
    expect(framingVerdictFromHeaders(null, "frame-ancestors 'self'")).toBe("blocked");
    expect(
      framingVerdictFromHeaders(null, "frame-ancestors https://intranet.corp https://x.y"),
    ).toBe("blocked");
    expect(framingVerdictFromHeaders(null, "frame-ancestors *")).toBe("ok");
  });

  test("frame-ancestors is found among other CSP directives, case-insensitively", () => {
    expect(
      framingVerdictFromHeaders(null, "default-src 'self'; Frame-Ancestors 'self'; img-src *"),
    ).toBe("blocked");
    // A CSP without frame-ancestors says nothing about framing.
    expect(framingVerdictFromHeaders(null, "default-src 'self'; img-src *")).toBe("ok");
  });

  test("Grafana-style: XFO deny wins even next to a permissive CSP", () => {
    expect(framingVerdictFromHeaders("deny", "frame-ancestors *")).toBe("blocked");
  });
});

describe("probeFraming", () => {
  test("reads the (final) response's headers", async () => {
    const fetchImpl: FetchLike = async () => res({ "X-Frame-Options": "SAMEORIGIN" });
    expect(await probeFraming("https://dash.example/d/abc", fetchImpl)).toBe("blocked");
  });

  test("a clean response is ok", async () => {
    const fetchImpl: FetchLike = async () => res({ "content-type": "text/html" });
    expect(await probeFraming("https://frames.example/", fetchImpl)).toBe("ok");
  });

  test("a network failure is unknown, never a throw (and never 'blocked')", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await probeFraming("https://down.example/", fetchImpl)).toBe("unknown");
  });

  test("a non-HTTP url is unknown without ever fetching", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return res({});
    };
    expect(await probeFraming("file:///etc/passwd", fetchImpl)).toBe("unknown");
    expect(called).toBe(false);
  });
});
