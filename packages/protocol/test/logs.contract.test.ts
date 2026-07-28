/**
 * POL-187 — the fleet-logging contract.
 *
 * The bounds here are load-bearing, not decorative. This envelope is written by every box in the
 * fleet, batched 200 at a time, over the same socket that carries applies and the remote shell — so
 * an unbounded `fields` bag or an unbounded message is a way for one misbehaving box to cost the
 * control plane real money. And `fields` in particular is the thing that would quietly become a
 * schema by stealth if nothing stopped it.
 */
import { describe, expect, test } from "bun:test";

import {
  AgentLogs,
  AgentMessage,
  LOG_BATCH_MAX,
  LOG_FIELD_MAX_KEYS,
  LogEvent,
  LogQuery,
  PlayerMessage,
  ServerToAgentMessage,
  levelAtLeast,
  redactMessage,
  redactUrl,
} from "../src/index";

const line = {
  source: "agent",
  level: "info",
  subsystem: "power",
  at: "2026-07-28T03:00:00.000Z",
  machineId: "box-a",
  msg: "panel slept on HDMI-1",
} as const;

describe("the envelope", () => {
  test("accepts a minimal line and a fully-populated one", () => {
    expect(LogEvent.safeParse(line).success).toBe(true);
    expect(
      LogEvent.safeParse({
        ...line,
        screenId: "screen-1",
        seq: 42,
        fields: { connector: "HDMI-1", on: false, delivered: 1 },
      }).success,
    ).toBe(true);
  });

  test("bounds the message and the fields bag", () => {
    expect(LogEvent.safeParse({ ...line, msg: "x".repeat(1001) }).success).toBe(false);

    const tooMany = Object.fromEntries(
      Array.from({ length: LOG_FIELD_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i]),
    );
    expect(LogEvent.safeParse({ ...line, fields: tooMany }).success).toBe(false);
    expect(LogEvent.safeParse({ ...line, fields: { k: "x".repeat(301) } }).success).toBe(false);
    // A nested object would be a schema growing inside the bag. Strings, numbers, booleans only.
    expect(LogEvent.safeParse({ ...line, fields: { k: { nested: true } } }).success).toBe(false);
  });

  test("levels rank so that `minLevel: warn` means warnings AND errors", () => {
    expect(levelAtLeast("error", "warn")).toBe(true);
    expect(levelAtLeast("warn", "warn")).toBe(true);
    expect(levelAtLeast("info", "warn")).toBe(false);
    expect(levelAtLeast("debug", "info")).toBe(false);
  });
});

describe("the frames", () => {
  test("`agent/logs` is in the agent union and caps the batch", () => {
    const batch = { t: "agent/logs", machineId: "box-a", batchId: "b1", events: [line] };
    expect(AgentMessage.safeParse(batch).success).toBe(true);
    expect(
      AgentLogs.safeParse({ ...batch, events: Array.from({ length: LOG_BATCH_MAX + 1 }, () => line) })
        .success,
    ).toBe(false);
    // An empty batch is a frame with nothing to say — reject it rather than ack a no-op.
    expect(AgentLogs.safeParse({ ...batch, events: [] }).success).toBe(false);
  });

  test("`server/logs-ack` is in the server→agent union", () => {
    expect(
      ServerToAgentMessage.safeParse({ t: "server/logs-ack", batchId: "b1", status: "accepted", written: 1 })
        .success,
    ).toBe(true);
    expect(
      ServerToAgentMessage.safeParse({ t: "server/logs-ack", batchId: "b1", status: "maybe", written: 1 })
        .success,
    ).toBe(false);
  });

  test("`player/log` is in the player union — and POL-86's `player/diag` still parses", () => {
    expect(
      PlayerMessage.safeParse({ t: "player/log", screenId: "screen-1", event: { ...line, source: "player" } })
        .success,
    ).toBe(true);
    // A browser holding a bundle from before the re-home must not go silent mid-upgrade.
    expect(
      PlayerMessage.safeParse({ t: "player/diag", screenId: "screen-1", at: line.at, msg: "boot" }).success,
    ).toBe(true);
  });
});

describe("the query", () => {
  test("caps the limit, so no caller can ask for an unbounded scan", () => {
    expect(LogQuery.safeParse({ limit: 2000 }).success).toBe(true);
    expect(LogQuery.safeParse({ limit: 2001 }).success).toBe(false);
  });
});

describe("redaction", () => {
  test("keeps origin + path and drops the query, where POL-24 stamps the token", () => {
    expect(redactUrl("https://dash.example.com/d/abc?token=SECRET&kiosk")).toBe(
      "https://dash.example.com/d/abc?…",
    );
    expect(redactUrl("https://dash.example.com/d/abc")).toBe("https://dash.example.com/d/abc");
  });

  test("redacts a URL embedded in a sentence, and leaves the prose alone", () => {
    const out = redactMessage("spawned chrome pid=123 → https://dash.example.com/d/abc?token=SECRET.");
    expect(out).toBe("spawned chrome pid=123 → https://dash.example.com/d/abc?….");
    expect(out).not.toContain("SECRET");
  });

  test("a message with no URL is returned untouched", () => {
    expect(redactMessage("panel slept on HDMI-1 (dpms off)")).toBe("panel slept on HDMI-1 (dpms off)");
  });

  test("a non-URL string does not throw", () => {
    expect(redactUrl("not a url at all")).toBe("not a url at all");
  });
});
