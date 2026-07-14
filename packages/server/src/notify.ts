/**
 * NotificationService (POL-91) — the notifier adapters and the rules that route alerts into them.
 *
 * A rule maps alert KINDS onto ONE notifier. There are exactly two, and neither knows the name of a
 * single vendor (non-negotiable #5):
 *
 *   webhook — POST the `AlertEvent` as JSON to any URL. Slack, Teams, PagerDuty, ntfy, Alertmanager
 *             and a bash script behind nginx are all "any URL"; the product ships no vendor branch.
 *   smtp    — hand the same event to a relay as a short plain-text mail (see smtp.ts).
 *
 * SIGNING (documented in ARCHITECTURE.md — a receiver has to implement the other half):
 *   X-Polyptic-Timestamp: <unix seconds>
 *   X-Polyptic-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
 *   X-Polyptic-Delivery:  <uuid>          (stable per delivery — dedupe retries on it)
 *   X-Polyptic-Event:     alert.firing | alert.resolved
 * The timestamp is INSIDE the signed string, so a captured payload can't be replayed later against a
 * receiver that checks its freshness. The secret is per-rule and write-only: the server mints one when
 * the operator doesn't supply one, because an unsigned payload is not a thing we offer.
 *
 * Delivery is one attempt per call; the ALERT ENGINE owns the retry cadence (it simply re-asks on the
 * next tick until a delivery succeeds — see alerts.ts), which keeps all the timing policy in one place.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { AlertEvent, NotificationRuleView } from "@polyptic/protocol";
import type {
  AlertEvent as AlertEventType,
  AlertKind,
  CreateNotificationRuleBody,
  NotificationRuleView as NotificationRuleViewType,
  UpdateNotificationRuleBody,
} from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";

import type { PersistedNotificationRule, Store } from "./store";
import type { SmtpTransport } from "./smtp";

/** Live delivery health for one rule (never persisted — it is a property of THIS process's attempts). */
interface DeliveryHealth {
  lastDeliveryAt?: string;
  lastDeliveryOk?: boolean;
  lastError?: string;
}

export interface NotificationDeps {
  store: Store;
  log: FastifyBaseLogger;
  /** The relay, when one is configured. Absent → smtp rules refuse with a plain sentence. */
  smtp?: SmtpTransport;
  /** This deployment's public base URL, stamped into every event so one sink can serve many walls. */
  deployment?: string;
  /** Injected clock (ms). Tests drive quiet hours and debounce without sleeping. */
  now?: () => number;
  /** Fired whenever a rule or its delivery health changes, so the console's snapshot refreshes. */
  onChange?: () => void;
  /** Overridable for tests: the webhook transport. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class NotificationService {
  private readonly rules = new Map<string, PersistedNotificationRule>();
  private readonly health = new Map<string, DeliveryHealth>();

  constructor(private readonly deps: NotificationDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Load the persisted rules on boot. */
  async init(): Promise<void> {
    for (const rule of await this.deps.store.listNotificationRules()) {
      this.rules.set(rule.id, rule);
    }
  }

  /** Every rule, as the console sees it — config + live delivery health, NEVER the signing secret. */
  views(): NotificationRuleViewType[] {
    return [...this.rules.values()].map((rule) => this.viewOf(rule));
  }

  view(id: string): NotificationRuleViewType | undefined {
    const rule = this.rules.get(id);
    return rule ? this.viewOf(rule) : undefined;
  }

  private viewOf(rule: PersistedNotificationRule): NotificationRuleViewType {
    const health = this.health.get(rule.id) ?? {};
    return NotificationRuleView.parse({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      kinds: rule.kinds,
      notifier: rule.notifier,
      ...(rule.webhookUrl ? { webhookUrl: rule.webhookUrl } : {}),
      ...(rule.emailTo ? { emailTo: rule.emailTo } : {}),
      debounceSeconds: rule.debounceSeconds,
      quietHours:
        rule.quietStart && rule.quietEnd ? { start: rule.quietStart, end: rule.quietEnd } : null,
      hasSecret: Boolean(rule.webhookSecret),
      ...health,
    });
  }

  /** The enabled rules that deliver a given kind — what the engine asks for on every evaluation. */
  rulesFor(kind: AlertKind): PersistedNotificationRule[] {
    return [...this.rules.values()].filter((r) => r.enabled && r.kinds.includes(kind));
  }

  /** Every enabled rule, whatever its kinds (used to decide whether alerting is wired up at all). */
  enabledRules(): PersistedNotificationRule[] {
    return [...this.rules.values()].filter((r) => r.enabled);
  }

  async create(body: CreateNotificationRuleBody): Promise<PersistedNotificationRule> {
    const rule: PersistedNotificationRule = {
      id: `rule-${randomUUID().slice(0, 8)}`,
      name: body.name,
      enabled: body.enabled,
      kinds: [...body.kinds],
      notifier: body.notifier,
      webhookUrl: body.webhookUrl ?? null,
      // A webhook rule ALWAYS has a secret: if the operator gave none, mint one. There is no path to
      // an unsigned payload — a receiver that can't authenticate the sender can't trust the alert.
      webhookSecret:
        body.notifier === "webhook" ? (body.webhookSecret ?? randomUUID().replace(/-/g, "")) : null,
      emailTo: body.emailTo ? [...body.emailTo] : null,
      debounceSeconds: body.debounceSeconds,
      quietStart: body.quietHours?.start ?? null,
      quietEnd: body.quietHours?.end ?? null,
    };
    this.rules.set(rule.id, rule);
    await this.deps.store.upsertNotificationRule(rule);
    this.deps.onChange?.();
    return rule;
  }

  /**
   * Partial update. An omitted `webhookSecret` leaves the stored one alone (so an operator can rename
   * a rule without re-typing a secret they may not have kept). `quietHours: null` clears the window.
   * Returns the reason a merged rule is incoherent (webhook with no url, smtp with no recipient) so
   * REST can 400 rather than persist a rule that could never deliver.
   */
  async update(
    id: string,
    body: UpdateNotificationRuleBody,
  ): Promise<PersistedNotificationRule | "unknown" | "incoherent"> {
    const existing = this.rules.get(id);
    if (!existing) return "unknown";

    const merged: PersistedNotificationRule = {
      ...existing,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.kinds !== undefined ? { kinds: [...body.kinds] } : {}),
      ...(body.notifier !== undefined ? { notifier: body.notifier } : {}),
      ...(body.webhookUrl !== undefined ? { webhookUrl: body.webhookUrl } : {}),
      ...(body.webhookSecret !== undefined ? { webhookSecret: body.webhookSecret } : {}),
      ...(body.emailTo !== undefined ? { emailTo: [...body.emailTo] } : {}),
      ...(body.debounceSeconds !== undefined ? { debounceSeconds: body.debounceSeconds } : {}),
      ...(body.quietHours !== undefined
        ? { quietStart: body.quietHours?.start ?? null, quietEnd: body.quietHours?.end ?? null }
        : {}),
    };

    if (merged.notifier === "webhook") {
      if (!merged.webhookUrl) return "incoherent";
      if (!merged.webhookSecret) merged.webhookSecret = randomUUID().replace(/-/g, "");
    }
    if (merged.notifier === "smtp" && (!merged.emailTo || merged.emailTo.length === 0)) {
      return "incoherent";
    }

    this.rules.set(id, merged);
    await this.deps.store.upsertNotificationRule(merged);
    this.deps.onChange?.();
    return merged;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.rules.has(id)) return false;
    this.rules.delete(id);
    this.health.delete(id);
    await this.deps.store.deleteNotificationRule(id);
    this.deps.onChange?.();
    return true;
  }

  /**
   * Whether a rule is inside its quiet window RIGHT NOW (server-local time; a window may wrap
   * midnight). Quiet hours gate a FIRING delivery, never a resolve — a resolve can only silence an
   * alarm the operator has already been handed, so holding it back would be the noisy choice.
   */
  isQuiet(rule: PersistedNotificationRule, at = new Date(this.now())): boolean {
    if (!rule.quietStart || !rule.quietEnd) return false;
    const minutes = at.getHours() * 60 + at.getMinutes();
    const start = toMinutes(rule.quietStart);
    const end = toMinutes(rule.quietEnd);
    if (start === end) return false; // a zero-width window is no window
    return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  }

  /** Deliver one event through one rule. Resolves on success; REJECTS with the transport's own words. */
  async deliver(rule: PersistedNotificationRule, event: AlertEventType): Promise<void> {
    try {
      if (rule.notifier === "webhook") await this.deliverWebhook(rule, event);
      else if (rule.notifier === "smtp") await this.deliverEmail(rule, event);
      else throw new Error(`unknown notifier: ${rule.notifier}`);
      this.health.set(rule.id, {
        lastDeliveryAt: new Date(this.now()).toISOString(),
        lastDeliveryOk: true,
      });
      this.deps.log.info(
        { event: "alert.delivered", ruleId: rule.id, notifier: rule.notifier, alert: event.alert.id, state: event.state },
        `alert ${event.state} delivered via ${rule.notifier} (${rule.name})`,
      );
      this.deps.onChange?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.health.set(rule.id, {
        lastDeliveryAt: new Date(this.now()).toISOString(),
        lastDeliveryOk: false,
        lastError: message.slice(0, 300),
      });
      this.deps.log.warn(
        { event: "alert.delivery.failed", ruleId: rule.id, notifier: rule.notifier, err: message },
        `alert delivery failed via ${rule.notifier} (${rule.name})`,
      );
      this.deps.onChange?.();
      throw err;
    }
  }

  /** The console's test-fire: a REAL delivery, through the real signing path, over a fabricated alert
   *  flagged `test: true` so a receiver can keep it out of an incident queue. */
  async test(id: string): Promise<{ ok: boolean; error?: string }> {
    const rule = this.rules.get(id);
    if (!rule) return { ok: false, error: "unknown rule" };
    const at = new Date(this.now()).toISOString();
    const event = AlertEvent.parse({
      version: 1,
      id: randomUUID(),
      at,
      state: "firing",
      test: true,
      ...(this.deps.deployment ? { deployment: this.deps.deployment } : {}),
      alert: {
        id: "test:notification-rule",
        kind: "machine-offline",
        state: "firing",
        title: "Test alert from Polyptic",
        detail: `This is the test-fire for the "${rule.name}" rule. No screen or machine is affected.`,
        subject: {},
        since: at,
        firedAt: at,
      },
    });
    try {
      await this.deliver(rule, event);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async deliverWebhook(rule: PersistedNotificationRule, event: AlertEventType): Promise<void> {
    if (!rule.webhookUrl) throw new Error("this rule has no webhook URL");
    const body = JSON.stringify(event);
    const timestamp = Math.floor(this.now() / 1000).toString();
    const doFetch = this.deps.fetchImpl ?? fetch;
    const response = await doFetch(rule.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "polyptic",
        "X-Polyptic-Event": event.state === "firing" ? "alert.firing" : "alert.resolved",
        "X-Polyptic-Delivery": event.id,
        "X-Polyptic-Timestamp": timestamp,
        "X-Polyptic-Signature": signWebhook(rule.webhookSecret ?? "", timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
    }
  }

  private async deliverEmail(rule: PersistedNotificationRule, event: AlertEventType): Promise<void> {
    const smtp = this.deps.smtp;
    if (!smtp) throw new Error("no SMTP relay is configured (set SMTP_HOST)");
    const to = rule.emailTo ?? [];
    if (to.length === 0) throw new Error("this rule has no recipients");
    await smtp.send({ to, subject: emailSubject(event), text: emailBody(event, this.deps.deployment) });
  }
}

/** `v1=<hex>` over `"<timestamp>.<body>"`. Versioned so the scheme can change without a flag day. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `v1=${mac}`;
}

/** The other half of the scheme, for our own tests — and the reference a receiver copies. */
export function verifyWebhook(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function emailSubject(event: AlertEventType): string {
  const prefix = event.state === "firing" ? "[Polyptic] ALERT" : "[Polyptic] RESOLVED";
  return `${prefix}: ${event.alert.title}`;
}

function emailBody(event: AlertEventType, deployment?: string): string {
  const a = event.alert;
  const lines = [
    event.state === "firing" ? a.title : `RESOLVED — ${a.title}`,
    "",
    ...(a.detail ? [a.detail, ""] : []),
    `Kind:    ${a.kind}`,
    ...(a.subject.machineLabel ? [`Machine: ${a.subject.machineLabel}`] : []),
    ...(a.subject.screenName ? [`Screen:  ${a.subject.screenName}`] : []),
    `Since:   ${a.since}`,
    `At:      ${event.at}`,
    ...(deployment ? ["", `Console: ${deployment}`] : []),
  ];
  return lines.join("\n");
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}
