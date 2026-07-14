/**
 * POL-91 — the alert engine: rule evaluation, per-rule debounce, quiet hours, and the fire → resolve
 * lifecycle, driven against a fake clock and a stub notifier transport. Nothing here sleeps.
 *
 * The engine is fed a hand-written probe (the real probes are covered by the e2e suite, which drives
 * a live agent socket): what matters here is everything TEMPORAL, which is the part a live test cannot
 * pin down deterministically.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { FastifyBaseLogger } from "fastify";

import { AlertEngine, type Problem } from "../src/alerts";
import { NotificationService } from "../src/notify";
import { MemoryStore } from "../src/store/memory";
import type { AlertEvent } from "@polyptic/protocol";

const noopLog = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

const OFFLINE: Problem = {
  kind: "machine-offline",
  key: "box-1",
  title: "Atrium box is offline",
  subject: { machineId: "box-1", machineLabel: "Atrium box" },
};

/** A webhook sink that records every delivery, and can be told to fail. */
class Sink {
  readonly deliveries: { url: string; event: AlertEvent }[] = [];
  fail = false;

  readonly fetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (this.fail) return new Response("nope", { status: 500 });
    this.deliveries.push({
      url: String(input),
      event: JSON.parse(String(init?.body)) as AlertEvent,
    });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  states(): string[] {
    return this.deliveries.map((d) => d.event.state);
  }
}

let store: MemoryStore;
let sink: Sink;
let now: number;
let problems: Problem[];
let notifications: NotificationService;
let engine: AlertEngine;

/** Build the pair under test. The probe simply returns whatever `problems` currently holds. */
async function setup(): Promise<void> {
  store = new MemoryStore();
  sink = new Sink();
  now = Date.parse("2026-07-14T12:00:00Z"); // midday, well outside any quiet window we set
  problems = [];
  notifications = new NotificationService({
    store,
    log: noopLog,
    now: () => now,
    fetchImpl: sink.fetch,
  });
  await notifications.init();
  engine = new AlertEngine({
    notifications,
    log: noopLog,
    now: () => now,
    probes: [() => problems],
    defaultDebounceMs: 60_000,
  });
}

async function webhookRule(overrides: Record<string, unknown> = {}): Promise<string> {
  const rule = await notifications.create({
    name: "On-call",
    enabled: true,
    kinds: ["machine-offline"],
    notifier: "webhook",
    webhookUrl: "https://sink.example/hook",
    debounceSeconds: 180,
    ...overrides,
  } as Parameters<NotificationService["create"]>[0]);
  return rule.id;
}

beforeEach(setup);

describe("debounce", () => {
  test("a problem shorter than the rule's debounce never delivers", async () => {
    await webhookRule({ debounceSeconds: 180 });
    problems = [OFFLINE];
    await engine.tick();

    now += 170_000; // 2m50s of downtime — under the 3-minute rule
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0);

    problems = []; // the box came back — a flap, not an incident
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0);
    expect(engine.active()).toHaveLength(0);
  });

  test("a problem that outlives the debounce delivers EXACTLY ONE firing", async () => {
    await webhookRule({ debounceSeconds: 180 });
    problems = [OFFLINE];
    await engine.tick();
    now += 180_000;
    await engine.tick();

    expect(sink.deliveries).toHaveLength(1);
    expect(sink.deliveries[0]!.event.state).toBe("firing");
    expect(sink.deliveries[0]!.event.alert.title).toBe("Atrium box is offline");

    // Still broken on the next five ticks — and still exactly one delivery.
    for (let i = 0; i < 5; i += 1) {
      now += 15_000;
      await engine.tick();
    }
    expect(sink.deliveries).toHaveLength(1);
  });

  test("the debounce clock RESTARTS when a problem clears and comes back", async () => {
    await webhookRule({ debounceSeconds: 180 });
    problems = [OFFLINE];
    await engine.tick();
    now += 170_000;
    problems = [];
    await engine.tick(); // cleared before firing

    problems = [OFFLINE]; // and immediately breaks again
    await engine.tick();
    now += 170_000;
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0); // 170s the second time, not 340s cumulative

    now += 10_000;
    await engine.tick();
    expect(sink.deliveries).toHaveLength(1);
  });

  test("debounce is PER RULE — a fast rule fires while a slow one is still waiting", async () => {
    await webhookRule({ name: "fast", debounceSeconds: 30 });
    await webhookRule({ name: "slow", debounceSeconds: 600 });
    problems = [OFFLINE];
    await engine.tick();

    now += 30_000;
    await engine.tick();
    expect(sink.deliveries).toHaveLength(1);

    now += 570_000;
    await engine.tick();
    expect(sink.deliveries).toHaveLength(2);
  });

  test("debounce 0 delivers on the first observation", async () => {
    await webhookRule({ debounceSeconds: 0 });
    problems = [OFFLINE];
    await engine.tick();
    expect(sink.deliveries).toHaveLength(1);
  });
});

describe("the alert lifecycle", () => {
  test("firing → resolved: recovery sends an all-clear that CORRELATES with the firing", async () => {
    await webhookRule({ debounceSeconds: 60 });
    problems = [OFFLINE];
    await engine.tick();
    now += 60_000;
    await engine.tick();

    expect(engine.active()).toHaveLength(1);
    expect(engine.active()[0]!.id).toBe("machine-offline:box-1");

    problems = []; // the box is back
    await engine.tick();

    expect(sink.states()).toEqual(["firing", "resolved"]);
    // Same alert id on both — a receiver correlates them without guessing.
    expect(sink.deliveries[1]!.event.alert.id).toBe(sink.deliveries[0]!.event.alert.id);
    // …with a DIFFERENT delivery id, so a dedupe key never swallows the all-clear.
    expect(sink.deliveries[1]!.event.id).not.toBe(sink.deliveries[0]!.event.id);
    expect(engine.active()).toHaveLength(0);
  });

  test("a problem that clears BEFORE it fires resolves nothing — you can't un-tell what was never told", async () => {
    await webhookRule({ debounceSeconds: 300 });
    problems = [OFFLINE];
    await engine.tick();
    now += 60_000;
    problems = [];
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0);
  });

  test("the console sees the alert once the SHORTEST enabled rule's debounce elapses", async () => {
    await webhookRule({ name: "slow", debounceSeconds: 600 });
    await webhookRule({ name: "fast", debounceSeconds: 45 });
    problems = [OFFLINE];
    await engine.tick();
    expect(engine.active()).toHaveLength(0);

    now += 45_000;
    await engine.tick();
    expect(engine.active()).toHaveLength(1);
    expect(engine.active()[0]!.firedAt).toBeString();
  });

  test("with NO rule at all, the console still gets the alert on the default debounce", async () => {
    problems = [OFFLINE];
    await engine.tick();
    expect(engine.active()).toHaveLength(0);

    now += 60_000;
    await engine.tick();
    expect(engine.active()).toHaveLength(1);
    expect(sink.deliveries).toHaveLength(0); // nowhere to send it — but it is not invisible
  });

  test("a disabled rule delivers nothing", async () => {
    await webhookRule({ enabled: false, debounceSeconds: 0 });
    problems = [OFFLINE];
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0);
  });

  test("a rule only delivers the kinds it subscribes to", async () => {
    await webhookRule({ kinds: ["image-build-failed"], debounceSeconds: 0 });
    problems = [OFFLINE];
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0);
  });

  test("a failed delivery is RETRIED on the next tick", async () => {
    await webhookRule({ debounceSeconds: 0 });
    sink.fail = true;
    problems = [OFFLINE];
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0);

    sink.fail = false; // the sink comes back
    now += 15_000;
    await engine.tick();
    expect(sink.deliveries).toHaveLength(1);
    expect(sink.deliveries[0]!.event.state).toBe("firing");
  });

  test("a hopeless sink is abandoned rather than retried forever", async () => {
    await webhookRule({ debounceSeconds: 0 });
    sink.fail = true;
    problems = [OFFLINE];
    for (let i = 0; i < 12; i += 1) {
      now += 15_000;
      await engine.tick();
    }
    sink.fail = false;
    now += 15_000;
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0); // gave up after MAX_ATTEMPTS

    // The rule's health tells the operator why, in the transport's own words.
    const view = notifications.views()[0]!;
    expect(view.lastDeliveryOk).toBe(false);
    expect(view.lastError).toContain("500");
  });
});

describe("quiet hours", () => {
  /** 22:00 → 07:00 local, the classic overnight window (server-local time, as documented). */
  const overnight = { start: "22:00", end: "07:00" };
  /** Set the fake clock to a LOCAL wall-clock hour (quiet hours are local by contract). `day` walks
   *  forward, because a 22:00→07:00 window is only meaningful if the clock crosses midnight. */
  function atLocalHour(hour: number, day = 0): number {
    const d = new Date(now);
    d.setDate(d.getDate() + day);
    d.setHours(hour, 30, 0, 0);
    return d.getTime();
  }

  test("a firing inside the window is HELD, and goes out when the window ends", async () => {
    await webhookRule({ debounceSeconds: 0, quietHours: overnight });
    now = atLocalHour(23); // 23:30 — inside quiet hours
    problems = [OFFLINE];
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0);

    now = atLocalHour(3, 1); // 03:30 the next morning — still quiet, still broken
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0);

    now = atLocalHour(8, 1); // 08:30 — the window is over and the box is STILL down
    await engine.tick();
    expect(sink.deliveries).toHaveLength(1);
    expect(sink.deliveries[0]!.event.state).toBe("firing");
  });

  test("a problem that clears inside the window is never sent AT ALL — that is the point", async () => {
    await webhookRule({ debounceSeconds: 0, quietHours: overnight });
    now = atLocalHour(23);
    problems = [OFFLINE];
    await engine.tick();

    now = atLocalHour(2, 1);
    problems = []; // it healed itself at 2am, as things do
    await engine.tick();

    now = atLocalHour(9, 1);
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0);
  });

  test("a RESOLVE for an already-delivered alert is not held — it can only ever silence a page", async () => {
    await webhookRule({ debounceSeconds: 0, quietHours: overnight });
    now = atLocalHour(20); // 20:30 — before the window
    problems = [OFFLINE];
    await engine.tick();
    expect(sink.deliveries).toHaveLength(1);

    now = atLocalHour(23); // the box recovers inside quiet hours
    problems = [];
    await engine.tick();
    expect(sink.states()).toEqual(["firing", "resolved"]);
  });

  test("outside the window a rule is perfectly normal", async () => {
    await webhookRule({ debounceSeconds: 0, quietHours: overnight });
    now = atLocalHour(12);
    problems = [OFFLINE];
    await engine.tick();
    expect(sink.deliveries).toHaveLength(1);
  });

  test("a non-wrapping window (a lunchtime hush) is honoured too", async () => {
    await webhookRule({ debounceSeconds: 0, quietHours: { start: "12:00", end: "13:00" } });
    now = atLocalHour(12);
    problems = [OFFLINE];
    await engine.tick();
    expect(sink.deliveries).toHaveLength(0);

    now = atLocalHour(14);
    await engine.tick();
    expect(sink.deliveries).toHaveLength(1);
  });
});
