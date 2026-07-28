/**
 * POL-187 — the Logs place's operator surface, GATED under /api/v1 and ADMIN-ONLY.
 *
 *   GET  /api/v1/logs              query the sink (always time-bounded, always capped)
 *   GET  /api/v1/logs/export       the same view, as the plain text you paste into a ticket
 *   GET  /api/v1/settings/logs     retention + what the volume currently holds
 *   PUT  /api/v1/settings/logs     change the two retention numbers
 *
 * ACCESS. None of these appear in `roles.ts`'s widening table, which is deliberate rather than an
 * omission: that table is DENY-BY-DEFAULT, so a route absent from it requires `admin`. Fleet logs
 * are the closest thing the control plane has to a full account of every box — what it launched,
 * which panel it slept, which content origin it reached for — so admin is the right floor, and the
 * safe failure (a new route being admin-only until someone deliberately widens it) is the one we
 * want here.
 *
 * REDACTION HAS ALREADY HAPPENED, at the emitter (see `redactMessage`). That is what makes the
 * export button safe: by the time a line is on this volume, a POL-24 send-time credential is not in
 * it. There is no second redaction pass here, because a redaction that only runs on the way OUT
 * leaves the secret sitting on disk.
 */
import { z } from "zod";

import { LogQuery, UpdateLogRetentionBody } from "@polyptic/protocol";
import type { FastifyInstance } from "fastify";

import { renderLogText } from "./logs";
import type { LogSink } from "./logs";

/**
 * Query params arrive as strings; `limit` is the only number. Parsed leniently into the contract's
 * `LogQuery` so a hand-typed URL fails with a 400 rather than a silent full-range scan.
 */
const LogQueryParams = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
  machineId: z.string().optional(),
  screenId: z.string().optional(),
  minLevel: z.string().optional(),
  subsystem: z.string().optional(),
  source: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export function registerLogRoutes(fastify: FastifyInstance, logs: LogSink): void {
  /** Turn the request's query string into a validated `LogQuery`, or null when it is nonsense. */
  function toQuery(raw: unknown): LogQuery | null {
    const params = LogQueryParams.safeParse(raw);
    if (!params.success) return null;
    // Drop empty strings — the console sends `machineId=` for "all machines", and an empty filter
    // must mean "no filter", not "match the machine whose id is the empty string".
    const cleaned = Object.fromEntries(
      Object.entries(params.data).filter(([, v]) => v !== undefined && v !== ""),
    );
    const query = LogQuery.safeParse(cleaned);
    return query.success ? query.data : null;
  }

  fastify.get("/api/v1/logs", async (request, reply) => {
    const query = toQuery(request.query);
    if (!query) return reply.code(400).send({ error: "invalid log query" });
    const result = await logs.query(query);
    fastify.log.debug(
      { event: "logs.query", lines: result.lines.length, files: result.filesScanned, truncated: result.truncated },
      "served a logs query",
    );
    return result;
  });

  /**
   * The Download button. Exports EXACTLY the view on screen (same query, same filters), as plain
   * text — not NDJSON. The audience is a ticket, and a person reading "why was that panel dark",
   * so the readable rendering is the one that earns its place.
   */
  fastify.get("/api/v1/logs/export", async (request, reply) => {
    const query = toQuery(request.query);
    if (!query) return reply.code(400).send({ error: "invalid log query" });
    const result = await logs.query(query);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const who = query.machineId ? `-${query.machineId.replace(/[^A-Za-z0-9._-]+/g, "-")}` : "";
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("content-disposition", `attachment; filename="polyptic-logs${who}-${stamp}.txt"`)
      .send(
        `${renderLogText(result.lines)}\n` +
          (result.truncated
            ? `\n— truncated at ${result.lines.length} lines; narrow the range or the filters for the rest —\n`
            : ""),
      );
  });

  // ── Retention (the "two numbers in Settings" the pitch allows, and nothing more) ────────────

  fastify.get("/api/v1/settings/logs", async () => logs.info());

  fastify.put("/api/v1/settings/logs", async (request, reply) => {
    const body = UpdateLogRetentionBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const current = logs.currentRetention;
    await logs.setRetention({
      maxAgeHours: body.data.maxAgeHours ?? current.maxAgeHours,
      maxBytesPerMachine: body.data.maxBytesPerMachine ?? current.maxBytesPerMachine,
    });
    fastify.log.info(
      { event: "logs.retention.set", ...logs.currentRetention },
      "log retention updated (swept immediately)",
    );
    return reply.send(await logs.info());
  });
}
