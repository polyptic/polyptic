/**
 * POL-192 — the base URL a box is told to come back to, and specifically its PORT.
 *
 * Everything the boot chain fetches after the GRUB menu (kernel, initrd, squashfs) and the agent's
 * own WebSocket are built from `computeBaseUrl`. GRUB and dracut send `Host:` WITHOUT a port, so the
 * port has to be recovered from somewhere: behind a reverse proxy that is X-Forwarded-Port, and on a
 * direct hit it is the socket we were accepted on. Losing it is silent at the server and fatal at the
 * box — the menu paints, then the kernel fetch goes to :80 and finds nothing.
 */
import { describe, expect, test } from "bun:test";
import type { FastifyRequest } from "fastify";

import { computeBaseUrl } from "../src/provision";

/** A request stub carrying only what computeBaseUrl reads. `listenPort` is the bound listener. */
function req(opts: {
  headers?: Record<string, string | string[]>;
  protocol?: "http" | "https";
  listenPort?: number | null;
  socketPort?: number;
}): FastifyRequest {
  const { headers = {}, protocol = "http", listenPort = 8080, socketPort } = opts;
  return {
    headers,
    protocol,
    server: { server: { address: () => (listenPort === null ? null : { port: listenPort }) } },
    socket: socketPort === undefined ? undefined : { localPort: socketPort },
  } as unknown as FastifyRequest;
}

const FALLBACK = "https://polyptic.example.com";

describe("computeBaseUrl — the proxy's port (POL-192)", () => {
  test("X-Forwarded-Port is honoured when the forwarded host carries no port", () => {
    // The AMRC shape: a plain-http Traefik entrypoint on :8081, kept off the :80 -> :443 redirect.
    const base = computeBaseUrl(
      req({
        headers: {
          "x-forwarded-host": "polyptic-boot.example",
          "x-forwarded-proto": "http",
          "x-forwarded-port": "8081",
        },
      }),
      FALLBACK,
    );
    expect(base).toBe("http://polyptic-boot.example:8081");
  });

  test("the LISTENER port is never used behind a proxy — the box must dial the proxy", () => {
    // Bind port 8080, proxy on 8081: 8080 is an internal detail the box can't reach.
    const base = computeBaseUrl(
      req({
        headers: { "x-forwarded-host": "boot.example", "x-forwarded-port": "8081" },
        listenPort: 8080,
      }),
      FALLBACK,
    );
    expect(base).toBe("http://boot.example:8081");
    expect(base).not.toContain("8080");
  });

  test("a port already in X-Forwarded-Host wins — a proxy that sends both is not double-stamped", () => {
    const base = computeBaseUrl(
      req({ headers: { "x-forwarded-host": "boot.example:8081", "x-forwarded-port": "8081" } }),
      FALLBACK,
    );
    expect(base).toBe("http://boot.example:8081");
  });

  test("default ports stay out of the URL (443 on https, 80 on http)", () => {
    const https = computeBaseUrl(
      req({
        headers: {
          "x-forwarded-host": "polyptic.example",
          "x-forwarded-proto": "https",
          "x-forwarded-port": "443",
        },
      }),
      FALLBACK,
    );
    expect(https).toBe("https://polyptic.example");

    const http = computeBaseUrl(
      req({ headers: { "x-forwarded-host": "boot.example", "x-forwarded-port": "80" } }),
      FALLBACK,
    );
    expect(http).toBe("http://boot.example");
  });

  test("a junk X-Forwarded-Port is dropped, not pasted into a URL boxes will fetch", () => {
    for (const bad of ["", "  ", "0", "70000", "8081abc", "-1", "80,443x", "1e3"]) {
      const base = computeBaseUrl(
        req({ headers: { "x-forwarded-host": "boot.example", "x-forwarded-port": bad } }),
        FALLBACK,
      );
      expect(base).toBe("http://boot.example");
    }
  });

  test("a comma-joined X-Forwarded-Port takes the first hop, like the other forwarded headers", () => {
    const base = computeBaseUrl(
      req({ headers: { "x-forwarded-host": "boot.example", "x-forwarded-port": "8081, 8080" } }),
      FALLBACK,
    );
    expect(base).toBe("http://boot.example:8081");
  });

  test("an IPv6 literal keeps its brackets and is not mistaken for host:port", () => {
    const withoutPort = computeBaseUrl(
      req({ headers: { "x-forwarded-host": "[2001:db8::1]", "x-forwarded-port": "8081" } }),
      FALLBACK,
    );
    expect(withoutPort).toBe("http://[2001:db8::1]:8081");

    const alreadyPorted = computeBaseUrl(
      req({ headers: { "x-forwarded-host": "[2001:db8::1]:8081", "x-forwarded-port": "9999" } }),
      FALLBACK,
    );
    expect(alreadyPorted).toBe("http://[2001:db8::1]:8081");
  });
});

describe("computeBaseUrl — no proxy in front (POL-39 regression)", () => {
  test("a portless Host: is completed from the bound listener", () => {
    // GRUB's fetch, straight at the server on :8080. Without this the menu bakes :80 and the box
    // dies on the kernel fetch — found live in the POL-39 VM netboot.
    const base = computeBaseUrl(req({ headers: { host: "polyptic.lan" }, listenPort: 8080 }), FALLBACK);
    expect(base).toBe("http://polyptic.lan:8080");
  });

  test("a Host: that already carries the port is left alone", () => {
    const base = computeBaseUrl(req({ headers: { host: "polyptic.lan:8080" } }), FALLBACK);
    expect(base).toBe("http://polyptic.lan:8080");
  });

  test("the socket's localPort is the fallback when the listener address is unavailable", () => {
    const base = computeBaseUrl(
      req({ headers: { host: "polyptic.lan" }, listenPort: null, socketPort: 8080 }),
      FALLBACK,
    );
    expect(base).toBe("http://polyptic.lan:8080");
  });

  test("X-Forwarded-Port still wins over the listener when a proxy sends it without a host", () => {
    const base = computeBaseUrl(
      req({ headers: { host: "boot.example", "x-forwarded-port": "8081" }, listenPort: 8080 }),
      FALLBACK,
    );
    expect(base).toBe("http://boot.example:8081");
  });

  test("native TLS on the listener keeps the scheme https (POL-70/D89)", () => {
    const base = computeBaseUrl(
      req({ headers: { host: "polyptic.lan" }, protocol: "https", listenPort: 8080 }),
      FALLBACK,
    );
    expect(base).toBe("https://polyptic.lan:8080");
  });

  test("no Host and no forwarded header falls back to the configured public base", () => {
    expect(computeBaseUrl(req({}), "https://polyptic.example.com/")).toBe("https://polyptic.example.com");
  });
});
