/**
 * Media reachability (POL-5) — re-home loopback media URLs onto the origin the player actually reaches.
 *
 * An uploaded image/video becomes a `ContentSource` whose `src` is baked server-side as an ABSOLUTE
 * `${MEDIA_PUBLIC_BASE}/media/<id>` (the protocol validates `src` as `z.string().url()`, so a
 * relative path is not an option). When `MEDIA_PUBLIC_BASE` is left at its `http://localhost:8080`
 * default — e.g. a bring-up where the server runs on the operator's laptop — that loopback host is
 * baked into every media URL. A REMOTE wall box then fetches `http://localhost:8080/media/<id>`, i.e.
 * ITSELF, gets nothing, and paints a broken-image glyph. Web/dashboard iframes are unaffected: they
 * carry genuine external URLs the box can already reach, which is why only media was broken.
 *
 * The player, though, already knows a host it can DEFINITELY reach the control plane at: the very one
 * it dials the player WS on, derived from `window.location` (see `serverAuthority`). So we re-home any
 * media URL whose host is a loopback / unspecified address — unreachable-by-construction from a remote
 * box, hence unambiguously wrong AND unambiguously the server's own default — onto that origin,
 * preserving the path + query. A genuine external URL (a real CDN/host) is left untouched; on a
 * co-located box (dev on the Mac, or the single-image prod deploy) the rewrite resolves to the same
 * origin, so it is a harmless no-op. This fixes already-uploaded media with no re-upload or migration.
 */

/** The dev player is served on :5173 and the server on :8080 (same host); prod serves both
 *  same-origin. Map 5173→8080, pass everything else through — the single source of truth for "where is
 *  the control plane", shared by the WS dialer and the media re-homer so the two can never disagree. */
export function serverAuthority(loc: { hostname: string; port: string }): string {
  const serverPort = loc.port === "5173" ? "8080" : loc.port;
  return serverPort ? `${loc.hostname}:${serverPort}` : loc.hostname;
}

/** True for a host a remote client can never reach back on — loopback (127.0.0.0/8, ::1, localhost) or
 *  the unspecified address (0.0.0.0 / ::). Such a host only appears in a media URL because the server
 *  baked its own default base, so it is always safe to re-home. `URL.hostname` keeps IPv6 brackets. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "0.0.0.0" || h === "::" || h === "::1" || h.startsWith("127.");
}

/**
 * Given a surface's raw media `src` and the HTTP base the player reaches the server at, return a src
 * the wall box can actually fetch. A loopback-hosted URL is re-homed onto `serverHttpBase` (path +
 * query preserved); everything else — external URLs, `data:`/`blob:` URIs, anything unparseable — is
 * returned unchanged.
 */
export function resolveMediaSrc(rawSrc: string, serverHttpBase: string): string {
  if (!rawSrc) return rawSrc;

  let url: URL;
  try {
    url = new URL(rawSrc);
  } catch {
    return rawSrc; // not an absolute URL we can reason about — hand it through untouched
  }
  if (!isLoopbackHost(url.hostname)) return rawSrc;

  let base: URL;
  try {
    base = new URL(serverHttpBase);
  } catch {
    return rawSrc; // no sane base to re-home onto — the original beats a broken rewrite
  }
  url.protocol = base.protocol;
  url.hostname = base.hostname;
  url.port = base.port;
  return url.toString();
}
