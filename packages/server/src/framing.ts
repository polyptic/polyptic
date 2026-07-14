/**
 * POL-18 — the server-side framing probe: can this web/dashboard source be shown in an iframe on a
 * wall, or does it refuse cross-origin framing (CSP `frame-ancestors` / `X-Frame-Options`)?
 *
 * Why server-side: the player cannot ask — a framed page that refuses framing renders as a silently
 * dead tile, and the browser hides the refusal from script (the load event fires either way, and the
 * blocking headers are on a cross-origin response the page can never read). The SERVER can simply
 * fetch the URL and read the headers — the same posture as the POL-42 page-data poller (server-side
 * fetches, tolerant parsing, failure = degrade never crash).
 *
 * Verdicts:
 *   - "blocked": the response says it will not render in OUR frame. `X-Frame-Options: DENY` or
 *     `SAMEORIGIN` (the player's origin is never the dashboard's — SAMEORIGIN blocks a wall just as
 *     hard as DENY), or a CSP `frame-ancestors` directive that is not a plain wildcard. We are
 *     deliberately conservative about allow-lists: a `frame-ancestors https://intranet.corp` MIGHT
 *     include the deployment's player origin, but the server can't know every URL a wall loads the
 *     player from — and the operator override exists exactly for the cases detection gets wrong.
 *   - "ok": a response arrived and carried no framing restriction.
 *   - "unknown": the probe itself failed (network error, timeout, non-HTTP url). Resolution treats
 *     `unknown` like `ok` — a false "blocked" would windowize content that frames fine.
 */
import type { FramingVerdict } from "@polyptic/protocol";

const PROBE_TIMEOUT_MS = 10_000;

/** Judge framing from response headers alone (pure — the unit-testable core). */
export function framingVerdictFromHeaders(
  xFrameOptions: string | null,
  contentSecurityPolicy: string | null,
): FramingVerdict {
  const xfo = xFrameOptions?.trim().toLowerCase() ?? "";
  // XFO values: DENY / SAMEORIGIN / (obsolete) ALLOW-FROM uri — every one of them blocks a
  // cross-origin wall. An unrecognised value is ignored by browsers, so we ignore it too.
  if (xfo === "deny" || xfo === "sameorigin" || xfo.startsWith("allow-from")) return "blocked";

  const csp = contentSecurityPolicy ?? "";
  // CSP may carry several directives; find frame-ancestors and read its source list.
  const directive = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith("frame-ancestors"));
  if (directive) {
    const sources = directive.slice("frame-ancestors".length).trim().toLowerCase();
    // `frame-ancestors *` (or `* something`) genuinely allows any embedder; everything else
    // ('none', 'self', scheme sources, host allow-lists) blocks an arbitrary wall origin.
    const allowsAny = sources.split(/\s+/).includes("*");
    if (!allowsAny) return "blocked";
  }
  return "ok";
}

/** What probeFraming needs from fetch — injectable for tests. */
export type FetchLike = (
  url: string,
  init: { redirect: "follow"; signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ headers: { get(name: string): string | null } }>;

/**
 * Fetch `url` (following redirects — the FINAL response is what the iframe would render) and judge
 * its framing headers. Any failure → "unknown", never a throw: a probe must not take a REST write
 * down with it, and must never windowize content on bad evidence.
 */
export async function probeFraming(
  url: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<FramingVerdict> {
  if (!/^https?:\/\//i.test(url)) return "unknown";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // GET, not HEAD: plenty of dashboard servers answer HEAD with different (or no) headers.
    // The body is never read, so the cost is one response's headers.
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      // Present as a browser-ish document fetch; some apps vary headers on it.
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    return framingVerdictFromHeaders(
      res.headers.get("x-frame-options"),
      res.headers.get("content-security-policy"),
    );
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}
