/**
 * HTTP half of the remote-DevTools tunnel (POL-67), GATED under /api/v1 like every operator route.
 *
 * The operator's browser loads Chrome's OWN bundled DevTools frontend — served by the wall box's
 * Chrome and proxied here over the agent WS — so there is nothing to build, bundle or version-match:
 * the frontend always fits the Chrome it inspects. Proxy rule: `…/devtools/<rest>` on the server maps
 * to `/<rest>` on the box's loopback DevTools port; the frontend's relative subresources resolve
 * through the same prefix, and its CDP WebSocket (`…/devtools/devtools/page/<id>`) upgrades in ws.ts.
 *
 * Two deliberate header choices, both measured against real Chrome (see D63/D77):
 *   - The agent fetches 127.0.0.1 directly, so the Host header Chrome sees is localhost — dodging
 *     its "Host header is not an IP or localhost" 500 on proxied requests.
 *   - Only content-type is forwarded back. Chrome serves the frontend with a CSP whose connect-src
 *     allows only 'self' and ws://127.0.0.1:* — dropping that header is what lets the frontend open
 *     its CDP socket back through THIS host. (Auth is not weakened: every route here sits behind
 *     the operator-session gate.)
 */
import type { FastifyInstance } from "fastify";

import type { DevtoolsRelay } from "./devtools-relay";

/** How long the entry route waits for the arm handshake (console arms + opens the tab in parallel). */
const ARM_WAIT_MS = 8_000;
const ARM_POLL_MS = 250;

/** One target from Chrome's /json/list. */
interface DevtoolsTarget {
  id?: string;
  type?: string;
  url?: string;
}

export function registerDevtoolsRoutes(fastify: FastifyInstance, relay: DevtoolsRelay): void {
  // GET /api/v1/screens/:screenId/devtools — the console's entry point: discover the page target on
  // the box and redirect into the proxied DevTools frontend wired to its CDP socket. The console
  // window.open()s this synchronously (popup-safe) while arming in parallel, so WAIT for the arm.
  fastify.get("/api/v1/screens/:screenId/devtools", async (request, reply) => {
    const { screenId } = request.params as { screenId: string };

    const deadline = Date.now() + ARM_WAIT_MS;
    while (!relay.isArmed(screenId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, ARM_POLL_MS));
    }

    let targets: DevtoolsTarget[];
    try {
      const res = await relay.request(screenId, "/json/list");
      targets = JSON.parse(res.body.toString("utf8")) as DevtoolsTarget[];
    } catch (err) {
      return reply.code(409).send({ error: `DevTools unavailable: ${(err as Error).message}` });
    }
    // One Chrome instance per output shows one page — but be deliberate anyway.
    const page = targets.find((t) => t.type === "page") ?? targets[0];
    if (!page?.id) {
      return reply.code(502).send({ error: "the box's Chrome reported no inspectable page" });
    }

    const prefix = `/api/v1/screens/${encodeURIComponent(screenId)}/devtools`;
    const host = request.headers.host ?? "localhost";
    const wsParam = request.protocol === "https" ? "wss" : "ws";
    const frontend =
      `${prefix}/devtools/inspector.html` +
      `?${wsParam}=${encodeURIComponent(`${host}${prefix}/devtools/page/${page.id}`)}`;
    return reply.redirect(frontend, 302);
  });

  // GET /api/v1/screens/:screenId/devtools/* — the proxy itself: frontend HTML/JS/CSS + /json/*.
  fastify.get("/api/v1/screens/:screenId/devtools/*", async (request, reply) => {
    const { screenId } = request.params as { screenId: string };
    // Derive the box path from the RAW url so the query string survives byte-for-byte.
    const raw = request.raw.url ?? "";
    const prefix = `/api/v1/screens/${encodeURIComponent(screenId)}/devtools`;
    const path = raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
    if (!path || !path.startsWith("/")) {
      return reply.code(400).send({ error: "bad devtools proxy path" });
    }

    try {
      const res = await relay.request(screenId, path);
      reply.code(res.status);
      if (res.contentType) reply.type(res.contentType);
      return reply.send(res.body);
    } catch (err) {
      return reply.code(502).send({ error: `DevTools proxy failed: ${(err as Error).message}` });
    }
  });
}
