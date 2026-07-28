/**
 * POL-187 — the agent's shared logger and its on-box spool.
 *
 * The properties worth pinning are the ones that make this store-and-FORWARD rather than
 * fire-and-forget:
 *
 *   - a line is dropped from the spool ONLY on an accepted ack. Everything else — a refusal, a dead
 *     socket, a batch that never came back — leaves it there. Get this wrong and the failure mode is
 *     silent: the box ships into a socket that dies and throws away the only copy of the evidence;
 *   - the spool SURVIVES a restart, with the sequence continuing where it left off (a restarted
 *     process must not re-use a seq the server already stored against a different line);
 *   - it is BOUNDED, drop-oldest — a box that cannot reach its server for a week must not fill its
 *     own RAM overlay;
 *   - REDACTION happens at the emitter. `sway.ts` logged content URLs raw, and POL-24 stamps auth
 *     tokens into those URLs at send time. Contained on the box while `journalctl` was the only
 *     reader; a live credential in a ticket attachment the moment shipping exists.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLogger } from "../src/logger";
import type { LogEvent } from "@polyptic/protocol";

let dir: string;
let spoolPath: string;

/** A shipper that records what it was handed and can be told to refuse (a dead socket). */
function recordingShipper() {
  const batches: { batchId: string; events: LogEvent[] }[] = [];
  let open = true;
  return {
    batches,
    close: () => {
      open = false;
    },
    fn: (batchId: string, events: LogEvent[]): boolean => {
      if (!open) return false;
      batches.push({ batchId, events });
      return true;
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "polyptic-spool-"));
  spoolPath = join(dir, "log-spool-box-a");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writing", () => {
  test("writes stdout AND spools, and stamps a per-machine monotonic seq", () => {
    const logger = new AgentLogger({ machineId: "box-a", spoolPath });
    logger.info("power", "panel slept on HDMI-1");
    logger.warn("sway", "browser would not start");

    const shipper = recordingShipper();
    logger.setShipper(shipper.fn);

    expect(shipper.batches).toHaveLength(1);
    const events = shipper.batches[0]!.events;
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.subsystem)).toEqual(["power", "sway"]);
    expect(events.every((e) => e.source === "agent" && e.machineId === "box-a")).toBe(true);
    logger.stop();
  });

  test("does NOT ship below the ship level, so the browser firehose stays on the box", () => {
    const logger = new AgentLogger({ machineId: "box-a", spoolPath, shipMinLevel: "info" });
    logger.debug("sway", "[chrome:HDMI-1:err] a font warning nobody will ever read");
    logger.info("sway", "kiosk browser: chrome");

    const shipper = recordingShipper();
    logger.setShipper(shipper.fn);
    expect(shipper.batches[0]!.events.map((e) => e.msg)).toEqual(["kiosk browser: chrome"]);
    logger.stop();
  });

  test("REDACTS a content URL's query — where POL-24 stamps the auth token", () => {
    const logger = new AgentLogger({ machineId: "box-a", spoolPath });
    // This is `sway.ts`'s long-standing line, verbatim in shape.
    logger.info("sway", "spawned chrome pid=123 → https://dash.example.com/d/abc?token=SECRET&kiosk");
    logger.info("sway", "probing", { url: "https://dash.example.com/d/abc?token=SECRET" });

    const shipper = recordingShipper();
    logger.setShipper(shipper.fn);
    const [spawned, probing] = shipper.batches[0]!.events;

    expect(spawned!.msg).toContain("https://dash.example.com/d/abc?…");
    expect(spawned!.msg).not.toContain("SECRET");
    expect(String(probing!.fields?.url)).not.toContain("SECRET");
    logger.stop();
  });
});

describe("the ack is what drops a line", () => {
  test("an ACCEPTED ack drops exactly that batch's lines", async () => {
    const logger = new AgentLogger({ machineId: "box-a", spoolPath });
    logger.info("power", "one");
    logger.info("power", "two");
    const shipper = recordingShipper();
    logger.setShipper(shipper.fn);

    expect(logger.pending()).toBe(2);
    logger.onAck(shipper.batches[0]!.batchId, true);
    expect(logger.pending()).toBe(0);
    logger.stop();
  });

  test("a REFUSED ack leaves them spooled — the server told us it did not take them", () => {
    const logger = new AgentLogger({ machineId: "box-a", spoolPath });
    logger.info("power", "one");
    const shipper = recordingShipper();
    logger.setShipper(shipper.fn);

    logger.onAck(shipper.batches[0]!.batchId, false);
    expect(logger.pending()).toBe(1);
    logger.stop();
  });

  test("a socket that dies before the ack re-sends — nothing is lost", () => {
    const logger = new AgentLogger({ machineId: "box-a", spoolPath });
    logger.info("power", "the line that explains the dark panel");
    const first = recordingShipper();
    logger.setShipper(first.fn);
    expect(first.batches).toHaveLength(1);

    // The socket drops before the ack lands.
    logger.setShipper(null);
    expect(logger.pending()).toBe(1);

    // On reconnect the same line goes again, under a FRESH batch id. The server's (machineId, seq)
    // dedupe is what makes the re-send a no-op if the first copy did in fact land.
    const second = recordingShipper();
    logger.setShipper(second.fn);
    expect(second.batches).toHaveLength(1);
    expect(second.batches[0]!.events[0]!.msg).toContain("dark panel");
    expect(second.batches[0]!.batchId).not.toBe(first.batches[0]!.batchId);
    logger.stop();
  });

  test("a shipper that refuses the send (socket down) keeps everything spooled", () => {
    const logger = new AgentLogger({ machineId: "box-a", spoolPath });
    logger.info("power", "one");
    const shipper = recordingShipper();
    shipper.close();
    logger.setShipper(shipper.fn);

    expect(shipper.batches).toHaveLength(0);
    expect(logger.pending()).toBe(1);
    logger.stop();
  });
});

describe("the spool file", () => {
  test("survives a restart, and the sequence continues where it left off", async () => {
    const first = new AgentLogger({ machineId: "box-a", spoolPath });
    first.info("power", "before the crash");
    first.stop(); // flushes

    const second = new AgentLogger({ machineId: "box-a", spoolPath });
    expect(second.pending()).toBe(1);
    second.info("power", "after the restart");

    const shipper = recordingShipper();
    second.setShipper(shipper.fn);
    // Continuing the sequence matters: re-using seq 1 for a DIFFERENT line would make the server's
    // dedupe silently drop it as a duplicate of the pre-restart one.
    expect(shipper.batches[0]!.events.map((e) => e.seq)).toEqual([1, 2]);
    second.stop();
  });

  test("is written 0600, beside the durable credential", async () => {
    const logger = new AgentLogger({ machineId: "box-a", spoolPath });
    logger.info("power", "anything");
    logger.stop();

    const s = await stat(spoolPath);
    expect(s.mode & 0o777).toBe(0o600);
  });

  test("is bounded and drops the OLDEST — the recent lines are the ones you are reading", async () => {
    // Far more than the cap: a box that cannot reach its server for a week must not fill its own
    // RAM overlay, and when it does have to discard, the lines it discards are the stale ones.
    const logger = new AgentLogger({ machineId: "box-a", spoolPath });
    for (let i = 0; i < 5000; i += 1) logger.info("power", `line ${i}`);
    logger.stop();

    const raw = await readFile(spoolPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(2000);
    expect(raw).toContain("line 4999");
    expect(raw).not.toContain('"msg":"line 0"');
  });

  test("a corrupt spool does not stop the agent from starting", async () => {
    await Bun.write(spoolPath, "{not json at all\n");
    const logger = new AgentLogger({ machineId: "box-a", spoolPath });
    expect(logger.pending()).toBe(0);
    logger.info("power", "still narrating");
    expect(logger.pending()).toBe(1);
    logger.stop();
  });
});

describe("refusal", () => {
  test("announces once, not once per batch", () => {
    const logger = new AgentLogger({ machineId: "box-a", spoolPath });
    logger.announceRefusal("the agent channel is not encrypted");
    logger.announceRefusal("the agent channel is not encrypted");

    const shipper = recordingShipper();
    logger.setShipper(shipper.fn);
    const refusals = shipper.batches[0]!.events.filter((e) => e.msg.includes("not shipping logs"));
    expect(refusals).toHaveLength(1);
    logger.stop();
  });
});
