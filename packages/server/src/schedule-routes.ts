/**
 * The scene scheduler's operator surface (POL-89 / D93), GATED under /api/v1 like every other
 * console route:
 *
 *   GET/POST         /api/v1/dayparts            the named windows of the day (the library)
 *   PATCH/DELETE     /api/v1/dayparts/:id        (DELETE refuses while schedules are bound to it)
 *   GET/POST         /api/v1/schedules           scene ⇄ daypart bindings (recurrence + priority)
 *   PATCH/DELETE     /api/v1/schedules/:id
 *   GET/PUT          /api/v1/settings/scheduler  master switch + timezone + default scene
 *
 * Every mutation KICKS the ticker, so a schedule the operator just saved takes the wall now rather
 * than on the next tick — and then broadcasts `admin/state`, which carries the whole schedule set, so
 * the console's week strip re-resolves from the same data the server will.
 */
import { z } from "zod";

import {
  CreateDaypartBody,
  CreateScheduleBody,
  UpdateDaypartBody,
  UpdateScheduleBody,
  UpdateSchedulerSettingsBody,
} from "@polyptic/protocol";

import type { FastifyInstance } from "fastify";

import type { AdminBroadcaster } from "./admin";
import type { SceneScheduler } from "./scheduler";
import type { ControlPlane } from "./state";

const IdParams = z.object({ id: z.string().min(1) });

export function registerScheduleRoutes(
  fastify: FastifyInstance,
  control: ControlPlane,
  scheduler: SceneScheduler,
  broadcaster: AdminBroadcaster,
): void {
  /** Every mutation ends the same way: re-resolve immediately, then tell the console. */
  const settled = (): void => {
    scheduler.kick();
    broadcaster.broadcast();
  };

  // ── Dayparts ───────────────────────────────────────────────────────────────

  fastify.get("/api/v1/dayparts", async () => control.getDayparts());

  fastify.post("/api/v1/dayparts", async (request, reply) => {
    const body = CreateDaypartBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const daypart = await control.createDaypart(body.data);
    fastify.log.info({ event: "daypart.create", daypartId: daypart.id, name: daypart.name }, "daypart created");
    settled();
    return reply.code(201).send({ ok: true, daypart });
  });

  fastify.patch("/api/v1/dayparts/:id", async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    const body = UpdateDaypartBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body", issues: body.error.issues });

    const daypart = await control.updateDaypart(params.data.id, body.data);
    if (!daypart) return reply.code(404).send({ error: `unknown daypart: ${params.data.id}` });
    fastify.log.info({ event: "daypart.update", daypartId: daypart.id }, "daypart updated");
    settled();
    return reply.send({ ok: true, daypart });
  });

  fastify.delete("/api/v1/dayparts/:id", async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid params", issues: params.error.issues });

    const result = await control.deleteDaypart(params.data.id);
    if (!result.ok && result.error === "unknown") {
      return reply.code(404).send({ error: `unknown daypart: ${params.data.id}` });
    }
    if (!result.ok) {
      // 409: tidying the library must never silently unschedule a wall.
      return reply.code(409).send({
        error: `daypart still used by ${result.schedules} schedule${result.schedules === 1 ? "" : "s"}`,
        schedules: result.schedules,
      });
    }
    fastify.log.info({ event: "daypart.delete", daypartId: params.data.id }, "daypart deleted");
    settled();
    return { ok: true, daypartId: params.data.id };
  });

  // ── Schedules ──────────────────────────────────────────────────────────────

  fastify.get("/api/v1/schedules", async () => control.getSchedules());

  fastify.post("/api/v1/schedules", async (request, reply) => {
    const body = CreateScheduleBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const result = await control.createSchedule(body.data);
    if (!result.ok) {
      return reply.code(404).send({
        error: result.error === "unknown-scene"
          ? `unknown scene: ${body.data.sceneId}`
          : `unknown daypart: ${body.data.daypartId}`,
      });
    }
    fastify.log.info(
      {
        event: "schedule.create",
        scheduleId: result.schedule.id,
        sceneId: result.schedule.sceneId,
        daypartId: result.schedule.daypartId,
        priority: result.schedule.priority,
      },
      "schedule created",
    );
    settled();
    return reply.code(201).send({ ok: true, schedule: result.schedule });
  });

  fastify.patch("/api/v1/schedules/:id", async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    const body = UpdateScheduleBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid body", issues: body.error.issues });

    const result = await control.updateSchedule(params.data.id, body.data);
    if (!result.ok) {
      const message =
        result.error === "unknown"
          ? `unknown schedule: ${params.data.id}`
          : result.error === "unknown-scene"
            ? `unknown scene: ${body.data.sceneId}`
            : `unknown daypart: ${body.data.daypartId}`;
      return reply.code(404).send({ error: message });
    }
    fastify.log.info({ event: "schedule.update", scheduleId: result.schedule.id }, "schedule updated");
    settled();
    return reply.send({ ok: true, schedule: result.schedule });
  });

  fastify.delete("/api/v1/schedules/:id", async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid params", issues: params.error.issues });

    const ok = await control.deleteSchedule(params.data.id);
    if (!ok) return reply.code(404).send({ error: `unknown schedule: ${params.data.id}` });
    fastify.log.info({ event: "schedule.delete", scheduleId: params.data.id }, "schedule deleted");
    settled();
    return { ok: true, scheduleId: params.data.id };
  });

  // ── Settings (master switch + THE timezone + the default scene) ─────────────

  fastify.get("/api/v1/settings/scheduler", async () => control.getSchedulerSettings());

  fastify.put("/api/v1/settings/scheduler", async (request, reply) => {
    const body = UpdateSchedulerSettingsBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const result = await control.updateSchedulerSettings(body.data);
    if (!result.ok) {
      // A bad zone is a 400, not a coercion: a typo must not quietly move every window an hour.
      return reply.code(result.error === "unknown-timezone" ? 400 : 404).send({
        error:
          result.error === "unknown-timezone"
            ? `unknown timezone: ${body.data.timezone}`
            : `unknown scene: ${body.data.defaultSceneId}`,
      });
    }
    fastify.log.info(
      { event: "scheduler.settings", ...result.settings },
      "scene scheduler settings updated",
    );
    settled();
    return reply.send({ ok: true, scheduler: result.settings });
  });
}
