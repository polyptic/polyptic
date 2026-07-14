/**
 * The alerting operator surface (POL-91), GATED under /api/v1 like every other settings route.
 *
 *   GET    /api/v1/alerts                       -> the firing alerts (also carried in admin/state)
 *   GET    /api/v1/notification-rules           -> NotificationRuleView[] (never the signing secret)
 *   POST   /api/v1/notification-rules           -> create (201)
 *   PATCH  /api/v1/notification-rules/:id       -> partial update (secret omitted = unchanged)
 *   DELETE /api/v1/notification-rules/:id
 *   POST   /api/v1/notification-rules/:id/test  -> FIRE a real, signed test delivery; the notifier's
 *                                                  own verdict comes back, never a fake success.
 */
import { z } from "zod";

import { CreateNotificationRuleBody, UpdateNotificationRuleBody } from "@polyptic/protocol";
import type { FastifyInstance } from "fastify";

import type { ActivityLog } from "./activity";
import type { AdminBroadcaster } from "./admin";
import type { AlertEngine } from "./alerts";
import type { NotificationService } from "./notify";

const RuleParams = z.object({ id: z.string().min(1) });

export function registerAlertRoutes(
  fastify: FastifyInstance,
  notifications: NotificationService,
  engine: AlertEngine,
  broadcaster: AdminBroadcaster,
  activity: ActivityLog,
): void {
  fastify.get("/api/v1/alerts", async () => ({ alerts: engine.active() }));

  fastify.get("/api/v1/notification-rules", async () => notifications.views());

  fastify.post("/api/v1/notification-rules", async (request, reply) => {
    const body = CreateNotificationRuleBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const rule = await notifications.create(body.data);
    fastify.log.info(
      { event: "notification-rule.create", ruleId: rule.id, notifier: rule.notifier, kinds: rule.kinds },
      "notification rule created",
    );
    activity.push("info", `Notification rule "${rule.name}" created`);
    broadcaster.broadcast();
    // A rule with a 0s debounce should not wait for the next tick to notice what is already broken.
    void engine.tick();
    return reply.code(201).send({ ok: true, rule: notifications.view(rule.id) });
  });

  fastify.patch("/api/v1/notification-rules/:id", async (request, reply) => {
    const params = RuleParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = UpdateNotificationRuleBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const result = await notifications.update(params.data.id, body.data);
    if (result === "unknown") {
      return reply.code(404).send({ error: `unknown notification rule: ${params.data.id}` });
    }
    if (result === "incoherent") {
      return reply.code(400).send({
        error: "a webhook rule needs a webhookUrl; an smtp rule needs at least one emailTo address",
      });
    }
    fastify.log.info(
      { event: "notification-rule.update", ruleId: result.id },
      "notification rule updated",
    );
    broadcaster.broadcast();
    void engine.tick();
    return { ok: true, rule: notifications.view(result.id) };
  });

  fastify.delete("/api/v1/notification-rules/:id", async (request, reply) => {
    const params = RuleParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const removed = await notifications.remove(params.data.id);
    if (!removed) {
      return reply.code(404).send({ error: `unknown notification rule: ${params.data.id}` });
    }
    fastify.log.info({ event: "notification-rule.delete", ruleId: params.data.id }, "notification rule deleted");
    broadcaster.broadcast();
    return { ok: true, ruleId: params.data.id };
  });

  fastify.post("/api/v1/notification-rules/:id/test", async (request, reply) => {
    const params = RuleParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    if (!notifications.view(params.data.id)) {
      return reply.code(404).send({ error: `unknown notification rule: ${params.data.id}` });
    }
    const result = await notifications.test(params.data.id);
    fastify.log.info(
      { event: "notification-rule.test", ruleId: params.data.id, ok: result.ok },
      "notification rule test-fired",
    );
    activity.push(
      result.ok ? "good" : "bad",
      result.ok
        ? `Test alert delivered through "${notifications.view(params.data.id)?.name}"`
        : `Test alert FAILED through "${notifications.view(params.data.id)?.name}": ${result.error}`,
    );
    broadcaster.broadcast();
    return result;
  });
}
