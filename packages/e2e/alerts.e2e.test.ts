/**
 * @polyptic/e2e — POL-91 ALERTING against the REAL control plane.
 *
 * This is the ticket's definition of done, driven end to end on real sockets:
 *
 *   1. Unplugging a box (its agent socket drops) fires EXACTLY ONE debounced webhook AND one email.
 *   2. Recovery (the agent dials back in) fires a RESOLVE event on both channels.
 *   3. The alert is in `admin/state.alerts` — the data behind the console's topbar chip — and carries
 *      the machine/screen ids the chip's drawer navigates to.
 *   4. The webhook payload is HMAC-SHA256 signed, and we verify the signature the way a receiver must.
 *   5. REST CRUD over /api/v1/notification-rules, plus the test-fire button's route.
 *
 * The two receivers are REAL: a Bun.serve HTTP sink and a fake SMTP relay speaking the protocol over
 * a socket (node:net). The server is spawned with SMTP_* pointed at that relay, so the email path is
 * the production path, relay and all.
 *
 * Own port (8191), own memory store, like every other e2e suite.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8191;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 20_000;

const MACHINE_ID = "alerts-host-1";
const CONN = "HDMI-1";
const SECRET = "e2e-webhook-signing-secret";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Frame = any;

// ── The webhook receiver: a real HTTP sink that records body + headers. ───────
interface Delivery {
  body: string;
  event: Frame;
  signature: string;
  timestamp: string;
  eventHeader: string;
}
const webhookDeliveries: Delivery[] = [];
let sink: ReturnType<typeof Bun.serve> | undefined;

// ── The email receiver: a real (plain) SMTP relay. ────────────────────────────
const emails: { to: string[]; message: string }[] = [];
let relay: net.Server | undefined;
let relayPort = 0;

function startRelay(): Promise<void> {
  return new Promise((done) => {
    relay = net.createServer((socket) => {
      let inData = false;
      let buffer = "";
      const to: string[] = [];
      const lines: string[] = [];
      socket.setEncoding("utf8");
      socket.write("220 e2e.relay ESMTP\r\n");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              emails.push({ to: [...to], message: lines.join("\n") });
              lines.length = 0;
              socket.write("250 2.0.0 Ok: queued\r\n");
            } else lines.push(line);
            continue;
          }
          const verb = line.split(" ")[0]!.toUpperCase();
          if (verb === "EHLO") socket.write("250-e2e.relay\r\n250 AUTH PLAIN\r\n");
          else if (verb === "MAIL") socket.write("250 2.1.0 Ok\r\n");
          else if (verb === "RCPT") {
            to.push(line.replace(/^RCPT TO:<|>$/gi, ""));
            socket.write("250 2.1.5 Ok\r\n");
          } else if (verb === "DATA") {
            inData = true;
            socket.write("354 go ahead\r\n");
          } else if (verb === "QUIT") {
            socket.write("221 bye\r\n");
            socket.end();
          } else socket.write("250 Ok\r\n");
        }
      });
      socket.on("error", () => {
        /* the client hanging up is normal */
      });
    });
    relay.listen(0, "127.0.0.1", () => {
      relayPort = (relay!.address() as net.AddressInfo).port;
      done();
    });
  });
}

// ── A buffering WS client (the standard e2e harness). ─────────────────────────
class WsClient {
  readonly ws: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: { pred: (m: Frame) => boolean; resolve: (m: Frame) => void; timer: ReturnType<typeof setTimeout> }[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: { data: unknown }) => this.ingest(ev.data));
  }

  static connect(url: string, timeoutMs = 5_000): Promise<WsClient> {
    return new Promise((resolveConn, rejectConn) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => rejectConn(new Error(`ws open timeout: ${url}`)), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolveConn(new WsClient(ws));
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        rejectConn(new Error(`ws error before open: ${url}`));
      }, { once: true });
    });
  }

  private ingest(data: unknown): void {
    let msg: Frame;
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }
    const idx = this.waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  waitFor(pred: (m: Frame) => boolean, label = "frame", timeoutMs = 5_000): Promise<Frame> {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timed out waiting for ${label}`)), timeoutMs);
      this.waiters.push({ pred, resolve: res, timer });
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }
}

const openClients: WsClient[] = [];

function agentHello(): unknown {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId: MACHINE_ID,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [{ connector: CONN, width: 1920, height: 1080 }],
  };
}

async function connectAgent(): Promise<WsClient> {
  const agent = await WsClient.connect(`${WS}/agent`);
  openClients.push(agent);
  agent.send(agentHello());
  await agent.waitFor((m) => m.t === "server/apply" && m.machineId === MACHINE_ID, "server/apply");
  return agent;
}

/** A FRESH /admin snapshot always reflects current server state — never a stale broadcast. */
async function snapshot(): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  admin.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  const state = await admin.waitFor((m) => m.t === "admin/state", "admin/state");
  admin.close();
  return state;
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/** Poll until `check` passes, or give up. The engine ticks on a timer — this is how we meet it. */
async function eventually<T>(check: () => T | undefined | false, label: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(80);
  }
}

let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/state`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}`);
}

let screenId = "";
let webhookRuleId = "";
let emailRuleId = "";

beforeAll(async () => {
  sink = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      webhookDeliveries.push({
        body,
        event: JSON.parse(body),
        signature: req.headers.get("X-Polyptic-Signature") ?? "",
        timestamp: req.headers.get("X-Polyptic-Timestamp") ?? "",
        eventHeader: req.headers.get("X-Polyptic-Event") ?? "",
      });
      return new Response("ok");
    },
  });
  await startRelay();

  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      LOG_LEVEL: "error",
      AUTH_ENABLED: "false",
      PLAYER_BASE_URL: "http://localhost:5173",
      PUBLIC_BASE_URL: BASE,
      // A brisk tick, so the suite meets the engine rather than the other way round.
      ALERT_TICK_MS: "150",
      ALERT_DEBOUNCE_MS: "500",
      // The email path is the production path: a real relay on a real socket.
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(relayPort),
      SMTP_TLS: "none",
      SMTP_FROM: "polyptic@example.com",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();

  const agent = await connectAgent();
  const state = await snapshot();
  screenId = state.machines[0].screens[0].id;
  expect(screenId).toBeTruthy();
  agent.close();
  await sleep(150); // let the socket close land before the rules exist
}, TEST_TIMEOUT);

afterAll(async () => {
  for (const c of openClients) c.close();
  sink?.stop(true);
  relay?.close();
  proc?.kill();
  await sleep(150);
});

describe("REST CRUD over notification rules", () => {
  test("a webhook rule is created, listed, patched — and its secret never comes back", async () => {
    const created = await api("POST", "/api/v1/notification-rules", {
      name: "On-call",
      kinds: ["machine-offline"],
      notifier: "webhook",
      webhookUrl: `http://127.0.0.1:${sink!.port}/hook`,
      webhookSecret: SECRET,
      debounceSeconds: 1,
    });
    expect(created.status).toBe(201);
    webhookRuleId = created.json.rule.id;
    expect(created.json.rule.hasSecret).toBe(true);
    expect(JSON.stringify(created.json)).not.toContain(SECRET);

    const listed = await api("GET", "/api/v1/notification-rules");
    expect(listed.status).toBe(200);
    expect(listed.json).toHaveLength(1);
    expect(listed.json[0].name).toBe("On-call");

    const patched = await api("PATCH", `/api/v1/notification-rules/${webhookRuleId}`, { name: "On-call (primary)" });
    expect(patched.status).toBe(200);
    expect(patched.json.rule.name).toBe("On-call (primary)");
    // The secret was NOT re-sent, and it is still there — the rule can still sign.
    expect(patched.json.rule.hasSecret).toBe(true);
  });

  test("an smtp rule takes recipients; an incoherent rule is refused", async () => {
    const created = await api("POST", "/api/v1/notification-rules", {
      name: "AV team",
      kinds: ["machine-offline"],
      notifier: "smtp",
      emailTo: ["ops@example.com"],
      debounceSeconds: 1,
    });
    expect(created.status).toBe(201);
    emailRuleId = created.json.rule.id;

    // A webhook rule with no URL could never deliver — the contract refuses it at the edge.
    const bad = await api("POST", "/api/v1/notification-rules", {
      name: "Nowhere",
      kinds: ["machine-offline"],
      notifier: "webhook",
      debounceSeconds: 1,
    });
    expect(bad.status).toBe(400);

    expect((await api("PATCH", "/api/v1/notification-rules/nope", { name: "x" })).status).toBe(404);
    expect((await api("DELETE", "/api/v1/notification-rules/nope")).status).toBe(404);
  });

  test("the test-fire button delivers a REAL signed payload, flagged as a test", async () => {
    const before = webhookDeliveries.length;
    const result = await api("POST", `/api/v1/notification-rules/${webhookRuleId}/test`);
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);

    const delivery = await eventually(
      () => webhookDeliveries[before],
      "the test-fire webhook",
    );
    expect(delivery.event.test).toBe(true);
    expect(delivery.event.alert.title).toContain("Test alert");
    expect(delivery.event.deployment).toBe(BASE);

    // …and the same test-fire went to the email rule's relay.
    const testResult = await api("POST", `/api/v1/notification-rules/${emailRuleId}/test`);
    expect(testResult.json.ok).toBe(true);
    const mail = await eventually(() => emails.find((e) => e.message.includes("Test alert")), "the test-fire email");
    expect(mail.to).toEqual(["ops@example.com"]);
  }, TEST_TIMEOUT);
});

describe("a box goes dark", () => {
  test("unplugging it fires exactly ONE debounced webhook and ONE email", async () => {
    webhookDeliveries.length = 0;
    emails.length = 0;

    // The agent socket is already closed (beforeAll drops it once the screen exists), so the box is
    // "unplugged" the moment a rule exists to notice — which is what the debounce is for.
    const firing = await eventually(
      () => webhookDeliveries.find((d) => d.event.state === "firing" && !d.event.test),
      "the offline webhook",
    );

    expect(firing.event.alert.kind).toBe("machine-offline");
    expect(firing.event.alert.subject.machineId).toBe(MACHINE_ID);
    expect(firing.event.alert.title).toContain("offline");
    expect(firing.eventHeader).toBe("alert.firing");

    const mail = await eventually(
      () => emails.find((e) => e.message.includes("ALERT") && !e.message.includes("Test alert")),
      "the offline email",
    );
    expect(mail.to).toEqual(["ops@example.com"]);
    expect(mail.message).toContain("Subject: [Polyptic] ALERT");

    // Let several engine ticks go by: still exactly one of each. This is the debounce doing its job —
    // a firing alert must not re-page every tick.
    await sleep(1_000);
    expect(webhookDeliveries.filter((d) => d.event.state === "firing" && !d.event.test)).toHaveLength(1);
    expect(emails.filter((e) => e.message.includes("ALERT") && !e.message.includes("Test alert"))).toHaveLength(1);
  }, TEST_TIMEOUT);

  test("the webhook payload is HMAC-signed — a receiver verifies it exactly like this", async () => {
    const delivery = webhookDeliveries.find((d) => d.event.state === "firing" && !d.event.test)!;
    expect(delivery.signature).toStartWith("v1=");

    const expected = `v1=${createHmac("sha256", SECRET).update(`${delivery.timestamp}.${delivery.body}`).digest("hex")}`;
    expect(delivery.signature).toBe(expected);

    // The wrong secret does not verify — the signature is the whole point.
    const wrong = `v1=${createHmac("sha256", "not-the-secret").update(`${delivery.timestamp}.${delivery.body}`).digest("hex")}`;
    expect(delivery.signature).not.toBe(wrong);
  });

  test("the alert is in admin/state — the data behind the console's chip and its drawer", async () => {
    const snap = await snapshot();
    expect(Array.isArray(snap.alerts)).toBe(true);
    const alert = snap.alerts.find((a: Frame) => a.kind === "machine-offline");
    expect(alert).toBeDefined();
    expect(alert.state).toBe("firing");
    expect(alert.subject.machineId).toBe(MACHINE_ID); // what the drawer click navigates to
    expect(alert.firedAt).toBeTruthy();
    expect(alert.since).toBeTruthy();
  }, TEST_TIMEOUT);
});

describe("the box comes back", () => {
  test("recovery fires a RESOLVE on both channels, correlated to the firing", async () => {
    const firing = webhookDeliveries.find((d) => d.event.state === "firing" && !d.event.test)!;

    await connectAgent(); // the box dials back in

    const resolved = await eventually(
      () => webhookDeliveries.find((d) => d.event.state === "resolved"),
      "the recovery webhook",
    );
    expect(resolved.eventHeader).toBe("alert.resolved");
    // SAME alert id as the firing (correlation), DIFFERENT delivery id (dedupe safety).
    expect(resolved.event.alert.id).toBe(firing.event.alert.id);
    expect(resolved.event.id).not.toBe(firing.event.id);

    const mail = await eventually(
      () => emails.find((e) => e.message.includes("RESOLVED")),
      "the recovery email",
    );
    expect(mail.message).toContain("Subject: [Polyptic] RESOLVED");

    // …and the alert is gone from the console's list. An alert that never clears is noise.
    const snap = await snapshot();
    expect(snap.alerts.filter((a: Frame) => a.kind === "machine-offline")).toHaveLength(0);
  }, TEST_TIMEOUT);

  test("a deleted rule stops delivering", async () => {
    expect((await api("DELETE", `/api/v1/notification-rules/${webhookRuleId}`)).status).toBe(200);
    expect((await api("GET", "/api/v1/notification-rules")).json).toHaveLength(1);
  });
});
