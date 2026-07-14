/**
 * POL-91 — the notifier ADAPTERS and the rules that drive them.
 *
 *  - the webhook adapter against a REAL HTTP sink (Bun.serve on an ephemeral port): the payload's
 *    shape, and the HMAC signature scheme, verified the way a receiver would;
 *  - the SMTP adapter against a stub transport: the recipients, the subject, and the body an operator
 *    reads. (The SMTP *protocol* client is tested for real in smtp.test.ts.)
 *  - the rule store: secret minting, write-only secrets, the coherence guard, and CRUD.
 */
import { describe, expect, test } from "bun:test";
import type { FastifyBaseLogger } from "fastify";

import { NotificationService, signWebhook, verifyWebhook } from "../src/notify";
import { MemoryStore } from "../src/store/memory";
import type { Mail, SmtpTransport } from "../src/smtp";
import type { AlertEvent } from "@polyptic/protocol";

const noopLog = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

const EVENT: AlertEvent = {
  version: 1,
  id: "delivery-1",
  at: "2026-07-14T12:00:00.000Z",
  state: "firing",
  deployment: "https://polyptic.example",
  alert: {
    id: "machine-offline:box-1",
    kind: "machine-offline",
    state: "firing",
    title: "Atrium box is offline",
    detail: "The control plane last heard from it at 2026-07-14T11:56:00.000Z.",
    subject: { machineId: "box-1", machineLabel: "Atrium box", screenName: "Atrium left" },
    since: "2026-07-14T11:56:00.000Z",
    firedAt: "2026-07-14T11:59:00.000Z",
  },
};

class StubSmtp implements SmtpTransport {
  readonly sent: Mail[] = [];
  fail: string | null = null;
  async send(mail: Mail): Promise<void> {
    if (this.fail) throw new Error(this.fail);
    this.sent.push(mail);
  }
}

function service(smtp?: SmtpTransport): NotificationService {
  return new NotificationService({
    store: new MemoryStore(),
    log: noopLog,
    smtp,
    deployment: "https://polyptic.example",
  });
}

/** A real HTTP receiver, so the webhook goes over a real socket and we inspect real headers. */
async function withSink(
  handler: (req: Request, body: string) => Response,
  run: (url: string) => Promise<void>,
): Promise<void> {
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text();
        return handler(req, body);
      },
    });
    await run(`http://127.0.0.1:${server.port}/hook`);
  } finally {
    server?.stop(true);
  }
}

describe("the webhook adapter", () => {
  test("POSTs the event and signs it — a receiver can verify the payload with the shared secret", async () => {
    const svc = service();
    let seen: { body: string; headers: Headers } | null = null;

    await withSink(
      (req, body) => {
        seen = { body, headers: req.headers };
        return new Response("ok");
      },
      async (url) => {
        const rule = await svc.create({
          name: "On-call",
          enabled: true,
          kinds: ["machine-offline"],
          notifier: "webhook",
          webhookUrl: url,
          webhookSecret: "shhh-this-is-the-secret",
          debounceSeconds: 0,
        });
        await svc.deliver(rule, EVENT);
      },
    );

    expect(seen).not.toBeNull();
    const { body, headers } = seen!;

    // The body is the contract's AlertEvent, verbatim.
    const payload = JSON.parse(body) as AlertEvent;
    expect(payload.version).toBe(1);
    expect(payload.state).toBe("firing");
    expect(payload.alert.id).toBe("machine-offline:box-1");
    expect(payload.alert.subject.machineId).toBe("box-1");
    expect(payload.deployment).toBe("https://polyptic.example");

    // The signature scheme, verified exactly as ARCHITECTURE.md tells a receiver to.
    expect(headers.get("X-Polyptic-Event")).toBe("alert.firing");
    expect(headers.get("X-Polyptic-Delivery")).toBe("delivery-1");
    const timestamp = headers.get("X-Polyptic-Timestamp")!;
    const signature = headers.get("X-Polyptic-Signature")!;
    expect(timestamp).toMatch(/^\d+$/);
    expect(signature).toStartWith("v1=");
    expect(verifyWebhook("shhh-this-is-the-secret", timestamp, body, signature)).toBe(true);

    // …and it is a real MAC: the wrong secret, a tampered body, and a moved timestamp all fail.
    expect(verifyWebhook("wrong-secret", timestamp, body, signature)).toBe(false);
    expect(verifyWebhook("shhh-this-is-the-secret", timestamp, `${body} `, signature)).toBe(false);
    expect(verifyWebhook("shhh-this-is-the-secret", "1", body, signature)).toBe(false);
  });

  test("the timestamp is INSIDE the signed string, so an old payload can't be replayed verbatim", () => {
    const body = JSON.stringify(EVENT);
    const a = signWebhook("s3cret-value", "1000", body);
    const b = signWebhook("s3cret-value", "2000", body);
    expect(a).not.toBe(b);
  });

  test("a resolve carries the resolved header + state", async () => {
    const svc = service();
    let event: string | null = null;
    await withSink(
      (req) => {
        event = req.headers.get("X-Polyptic-Event");
        return new Response("ok");
      },
      async (url) => {
        const rule = await svc.create({
          name: "On-call",
          enabled: true,
          kinds: ["machine-offline"],
          notifier: "webhook",
          webhookUrl: url,
          debounceSeconds: 0,
        });
        await svc.deliver(rule, { ...EVENT, state: "resolved", alert: { ...EVENT.alert, state: "resolved" } });
      },
    );
    expect(event).toBe("alert.resolved");
  });

  test("a sink that refuses REJECTS with its own status, and the rule's health records it", async () => {
    const svc = service();
    await withSink(
      () => new Response("no such hook", { status: 404 }),
      async (url) => {
        const rule = await svc.create({
          name: "Broken",
          enabled: true,
          kinds: ["machine-offline"],
          notifier: "webhook",
          webhookUrl: url,
          debounceSeconds: 0,
        });
        await expect(svc.deliver(rule, EVENT)).rejects.toThrow(/404/);
        const view = svc.view(rule.id)!;
        expect(view.lastDeliveryOk).toBe(false);
        expect(view.lastError).toContain("404");
      },
    );
  });

  test("the test-fire is a REAL signed delivery, flagged so a receiver can filter it", async () => {
    const svc = service();
    let payload: AlertEvent | null = null;
    await withSink(
      (_req, body) => {
        payload = JSON.parse(body) as AlertEvent;
        return new Response("ok");
      },
      async (url) => {
        const rule = await svc.create({
          name: "On-call",
          enabled: true,
          kinds: ["machine-offline"],
          notifier: "webhook",
          webhookUrl: url,
          debounceSeconds: 0,
        });
        const result = await svc.test(rule.id);
        expect(result.ok).toBe(true);
      },
    );
    expect(payload!.test).toBe(true);
    expect(payload!.alert.title).toContain("Test alert");
  });

  test("a test against an unreachable sink reports the failure rather than a cheerful lie", async () => {
    const svc = service();
    const rule = await svc.create({
      name: "Nowhere",
      enabled: true,
      kinds: ["machine-offline"],
      notifier: "webhook",
      // A port nothing is listening on — the fetch fails at the transport, not with a status.
      webhookUrl: "http://127.0.0.1:1/hook",
      debounceSeconds: 0,
    });
    const result = await svc.test(rule.id);
    expect(result.ok).toBe(false);
    expect(result.error).toBeString();
  });
});

describe("the smtp adapter", () => {
  test("hands the relay one mail per event, addressed to every recipient", async () => {
    const smtp = new StubSmtp();
    const svc = service(smtp);
    const rule = await svc.create({
      name: "AV team",
      enabled: true,
      kinds: ["machine-offline"],
      notifier: "smtp",
      emailTo: ["ops@example.com", "av@example.com"],
      debounceSeconds: 0,
    });

    await svc.deliver(rule, EVENT);
    expect(smtp.sent).toHaveLength(1);
    const mail = smtp.sent[0]!;
    expect(mail.to).toEqual(["ops@example.com", "av@example.com"]);
    expect(mail.subject).toBe("[Polyptic] ALERT: Atrium box is offline");
    expect(mail.text).toContain("Atrium box is offline");
    expect(mail.text).toContain("Machine: Atrium box");
    expect(mail.text).toContain("https://polyptic.example");

    await svc.deliver(rule, { ...EVENT, state: "resolved", alert: { ...EVENT.alert, state: "resolved" } });
    expect(smtp.sent[1]!.subject).toBe("[Polyptic] RESOLVED: Atrium box is offline");
    expect(smtp.sent[1]!.text).toStartWith("RESOLVED —");
  });

  test("with no relay configured an smtp rule refuses in plain words", async () => {
    const svc = service(); // no SMTP
    const rule = await svc.create({
      name: "AV team",
      enabled: true,
      kinds: ["machine-offline"],
      notifier: "smtp",
      emailTo: ["ops@example.com"],
      debounceSeconds: 0,
    });
    const result = await svc.test(rule.id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SMTP_HOST");
  });
});

describe("the rules themselves", () => {
  test("a webhook rule ALWAYS ends up with a signing secret, even if the operator gives none", async () => {
    const svc = service();
    const rule = await svc.create({
      name: "On-call",
      enabled: true,
      kinds: ["machine-offline"],
      notifier: "webhook",
      webhookUrl: "https://sink.example/hook",
      debounceSeconds: 0,
    });
    expect(rule.webhookSecret).toBeString();
    expect(rule.webhookSecret!.length).toBeGreaterThanOrEqual(16);
    // …and it is WRITE-ONLY: the view says one exists, never what it is.
    const view = svc.view(rule.id)!;
    expect(view.hasSecret).toBe(true);
    expect(JSON.stringify(view)).not.toContain(rule.webhookSecret!);
  });

  test("an update that omits the secret KEEPS the stored one", async () => {
    const svc = service();
    const rule = await svc.create({
      name: "On-call",
      enabled: true,
      kinds: ["machine-offline"],
      notifier: "webhook",
      webhookUrl: "https://sink.example/hook",
      webhookSecret: "original-secret-value",
      debounceSeconds: 0,
    });
    const updated = await svc.update(rule.id, { name: "Renamed" });
    expect(updated).not.toBe("unknown");
    expect(updated).not.toBe("incoherent");
    expect((updated as typeof rule).name).toBe("Renamed");
    expect((updated as typeof rule).webhookSecret).toBe("original-secret-value");
  });

  test("a merged rule that could never deliver is refused", async () => {
    const svc = service();
    const rule = await svc.create({
      name: "On-call",
      enabled: true,
      kinds: ["machine-offline"],
      notifier: "webhook",
      webhookUrl: "https://sink.example/hook",
      debounceSeconds: 0,
    });
    // Switching to smtp without recipients would leave a rule that silently does nothing.
    expect(await svc.update(rule.id, { notifier: "smtp" })).toBe("incoherent");
    expect(await svc.update("no-such-rule", { name: "x" })).toBe("unknown");
    // With recipients it is coherent, and the webhook fields simply stop mattering.
    const ok = await svc.update(rule.id, { notifier: "smtp", emailTo: ["ops@example.com"] });
    expect(ok).not.toBe("incoherent");
  });

  test("rulesFor only returns ENABLED rules that subscribe to the kind", async () => {
    const svc = service();
    await svc.create({
      name: "offline-only",
      enabled: true,
      kinds: ["machine-offline"],
      notifier: "webhook",
      webhookUrl: "https://sink.example/a",
      debounceSeconds: 0,
    });
    await svc.create({
      name: "paused",
      enabled: false,
      kinds: ["machine-offline"],
      notifier: "webhook",
      webhookUrl: "https://sink.example/b",
      debounceSeconds: 0,
    });
    await svc.create({
      name: "builds",
      enabled: true,
      kinds: ["image-build-failed"],
      notifier: "webhook",
      webhookUrl: "https://sink.example/c",
      debounceSeconds: 0,
    });

    expect(svc.rulesFor("machine-offline").map((r) => r.name)).toEqual(["offline-only"]);
    expect(svc.rulesFor("image-build-failed").map((r) => r.name)).toEqual(["builds"]);
    expect(svc.rulesFor("screen-dark")).toHaveLength(0);
  });

  test("rules survive a restart (they are persisted; alerts deliberately are not)", async () => {
    const store = new MemoryStore();
    const first = new NotificationService({ store, log: noopLog });
    await first.create({
      name: "On-call",
      enabled: true,
      kinds: ["machine-offline"],
      notifier: "webhook",
      webhookUrl: "https://sink.example/hook",
      debounceSeconds: 120,
    });

    const second = new NotificationService({ store, log: noopLog });
    await second.init();
    const views = second.views();
    expect(views).toHaveLength(1);
    expect(views[0]!.name).toBe("On-call");
    expect(views[0]!.debounceSeconds).toBe(120);
    expect(views[0]!.hasSecret).toBe(true);
  });

  test("deleting a rule removes it, and says so when it never existed", async () => {
    const svc = service();
    const rule = await svc.create({
      name: "On-call",
      enabled: true,
      kinds: ["machine-offline"],
      notifier: "webhook",
      webhookUrl: "https://sink.example/hook",
      debounceSeconds: 0,
    });
    expect(await svc.remove(rule.id)).toBe(true);
    expect(svc.views()).toHaveLength(0);
    expect(await svc.remove(rule.id)).toBe(false);
  });
});
