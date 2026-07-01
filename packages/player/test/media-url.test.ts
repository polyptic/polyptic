/**
 * Unit tests for the player's media-URL re-homing (POL-5).
 *
 * The bug: uploaded media bakes an ABSOLUTE `${MEDIA_PUBLIC_BASE}/media/<id>` src, defaulting to a
 * loopback host, which a REMOTE wall box can't fetch (it resolves to the box itself → broken-image
 * glyph). `resolveMediaSrc` re-homes loopback-hosted URLs onto the origin the player reaches the
 * server at, and MUST leave genuine external URLs alone. `serverAuthority` is the shared 5173→8080
 * mapping both the WS dialer and the re-homer use. Pure functions, so no DOM/server is needed.
 */
import { describe, expect, test } from "bun:test";

import { resolveMediaSrc, serverAuthority } from "../src/media-url";

describe("serverAuthority", () => {
  test("maps the dev player port 5173 → the server's 8080 on the same host", () => {
    expect(serverAuthority({ hostname: "192.168.1.50", port: "5173" })).toBe("192.168.1.50:8080");
    expect(serverAuthority({ hostname: "localhost", port: "5173" })).toBe("localhost:8080");
  });

  test("passes a non-5173 port through unchanged", () => {
    expect(serverAuthority({ hostname: "wall.example.com", port: "8080" })).toBe(
      "wall.example.com:8080",
    );
  });

  test("omits the port entirely when there is none (prod same-origin on 80/443)", () => {
    expect(serverAuthority({ hostname: "polyptic.example.com", port: "" })).toBe(
      "polyptic.example.com",
    );
  });
});

describe("resolveMediaSrc — re-homes loopback media URLs", () => {
  const BASE = "http://192.168.1.50:8080";

  test("localhost host → re-homed to the reachable server origin (the POL-5 case)", () => {
    expect(resolveMediaSrc("http://localhost:8080/media/abc123", BASE)).toBe(
      "http://192.168.1.50:8080/media/abc123",
    );
  });

  test("127.0.0.1 and other 127.0.0.0/8 hosts are re-homed", () => {
    expect(resolveMediaSrc("http://127.0.0.1:8080/media/abc123", BASE)).toBe(
      "http://192.168.1.50:8080/media/abc123",
    );
    expect(resolveMediaSrc("http://127.1.2.3:8080/media/abc123", BASE)).toBe(
      "http://192.168.1.50:8080/media/abc123",
    );
  });

  test("0.0.0.0 (the unspecified bind-all address) is re-homed", () => {
    expect(resolveMediaSrc("http://0.0.0.0:8080/media/abc123", BASE)).toBe(
      "http://192.168.1.50:8080/media/abc123",
    );
  });

  test("IPv6 loopback ([::1]) is re-homed", () => {
    expect(resolveMediaSrc("http://[::1]:8080/media/abc123", BASE)).toBe(
      "http://192.168.1.50:8080/media/abc123",
    );
  });

  test("a wrong loopback PORT is corrected too — host AND port both come from the base", () => {
    // The baked port (:9999) is dead; the reachable server is on :8080. Both must be rewritten.
    expect(resolveMediaSrc("http://127.0.0.1:9999/media/abc123", BASE)).toBe(
      "http://192.168.1.50:8080/media/abc123",
    );
  });

  test("path AND query are preserved when re-homing", () => {
    expect(resolveMediaSrc("http://localhost:8080/media/abc?v=2#frag", BASE)).toBe(
      "http://192.168.1.50:8080/media/abc?v=2#frag",
    );
  });

  test("a prod https base with no port re-homes to the default port (dropped)", () => {
    expect(resolveMediaSrc("http://localhost:8080/media/abc", "https://polyptic.example.com")).toBe(
      "https://polyptic.example.com/media/abc",
    );
  });
});

describe("resolveMediaSrc — leaves reachable / external URLs untouched", () => {
  const BASE = "http://192.168.1.50:8080";

  test("a genuine external host is passed through unchanged, even with a /media/ path", () => {
    const external = "https://cdn.example.com/media/photo.jpg";
    expect(resolveMediaSrc(external, BASE)).toBe(external);
  });

  test("an external host on a non-standard port is untouched", () => {
    const external = "http://assets.internal.lan:9000/media/clip.mp4";
    expect(resolveMediaSrc(external, BASE)).toBe(external);
  });

  test("data: URIs are passed through untouched", () => {
    const data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA0AAAADoJj";
    expect(resolveMediaSrc(data, BASE)).toBe(data);
  });

  test("an empty src (non-media surface) is returned as-is", () => {
    expect(resolveMediaSrc("", BASE)).toBe("");
  });

  test("an unparseable src is handed through rather than thrown on", () => {
    expect(resolveMediaSrc("not a url", BASE)).toBe("not a url");
  });

  test("a loopback URL with an unparseable base is left as the original (no broken rewrite)", () => {
    const raw = "http://localhost:8080/media/abc";
    expect(resolveMediaSrc(raw, "::::")).toBe(raw);
  });
});
