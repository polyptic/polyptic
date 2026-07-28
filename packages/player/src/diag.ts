/**
 * Player diagnostics (POL-86, priority A) — when a wall breaks, we must be able to read EXACTLY what
 * its player saw, without SSH, without DevTools, and without racing whoever refreshes the page.
 *
 * The failed boot that motivated this left NO evidence anywhere: the player's WS was live but the
 * content never loaded, nothing wrote a line, and the manual refresh that fixed the wall also wiped
 * the console. So every line written through `diag()` goes to THREE places:
 *
 *   1. `console.info` — for anyone who does have DevTools open.
 *   2. A localStorage ring buffer — so the story of a page-life SURVIVES the refresh that ends it.
 *      On boot, the tail of the previous life is replayed to the server tagged `[previous page-life]`.
 *   3. The player WS — landing in the fleet log sink, where a failed boot is diagnosable from the
 *      console alone. Lines queue while the socket is down and flush when it opens; sends are
 *      rate-capped so a pathological loop can never flood the control plane.
 *
 * POL-187 re-homed (3) onto the shared `LogEvent` envelope (`player/log`, replacing `player/diag`),
 * so the glass writes into the SAME merged timeline as the agent under it and the control plane
 * above it — one place to read "what happened to that screen last night" instead of three. The
 * mechanism here was already store-and-forward, which is why it needed no redesign: the localStorage
 * ring survives the refresh that ends a page-life, the queue survives a dropped socket, and the rate
 * cap was the model the agent's spool copied.
 *
 * Content URLs may carry auth tokens the server stamped at send time (POL-24) — log them through
 * `redactUrl()` only, never raw. (`redactUrl` now lives in `@polyptic/protocol` so ONE
 * implementation serves the player, the agent and the server; it is re-exported here so this
 * module's existing callers are unchanged.)
 */
import type { LogLevel } from "@polyptic/protocol";
import { redactUrl } from "@polyptic/protocol";

export { redactUrl };

export type DiagLine = { at: string; msg: string; level?: LogLevel };

/** Sends one line over the player WS. Returns false when the socket is down (the line stays queued). */
export type DiagSender = (line: DiagLine) => boolean;

/** Ring-buffer caps: enough to tell a whole boot's story, small enough to never matter. */
const STORE_KEY = "polyptic:diag";
const STORE_CAP = 200;
const QUEUE_CAP = 150;
/** Replay at most this many lines from a previous page-life. */
const REPLAY_CAP = 80;
/** Ceiling on `player/diag` frames per minute — a broken probe loop must not DDoS the server. */
const SEND_CAP_PER_MIN = 120;
/** Individual lines are truncated to fit the protocol's `msg` bound with headroom for tags. */
const LINE_CAP = 460;

let sender: DiagSender | null = null;
let queue: DiagLine[] = [];
let sessionLines: DiagLine[] = [];
let sentThisMinute = 0;
let minuteStart = 0;

function writeStore(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sessionLines));
  } catch {
    /* storage full or unavailable — the console + WS copies still exist */
  }
}

function enqueue(line: DiagLine): void {
  if (queue.length >= QUEUE_CAP) queue.shift(); // oldest first out; recent lines matter most
  queue.push(line);
  drain();
}

function allowSend(): boolean {
  const now = Date.now();
  if (now - minuteStart >= 60_000) {
    minuteStart = now;
    sentThisMinute = 0;
  }
  if (sentThisMinute >= SEND_CAP_PER_MIN) return false; // stays queued; next minute drains it
  sentThisMinute += 1;
  return true;
}

function drain(): void {
  if (!sender) return;
  let head: DiagLine | undefined;
  while ((head = queue[0]) !== undefined) {
    if (!allowSend()) return;
    if (!sender(head)) {
      sentThisMinute -= 1; // the socket was down, not a real send — give the budget back
      return;
    }
    queue.shift();
  }
}

/**
 * Start a new page-life. Replays the tail of the previous life's ring buffer (a refreshed-away
 * failure) into the send queue, then claims the store for this life. Call once, before any `diag()`.
 */
export function initDiag(): void {
  let previous: DiagLine[] = [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) previous = JSON.parse(raw) as DiagLine[];
  } catch {
    /* corrupt or unavailable — nothing to replay */
  }
  if (Array.isArray(previous) && previous.length > 0) {
    for (const line of previous.slice(-REPLAY_CAP)) {
      if (typeof line?.at === "string" && typeof line?.msg === "string") {
        enqueue({ at: line.at.slice(0, 40), msg: `[previous page-life] ${line.msg}`.slice(0, LINE_CAP + 25) });
      }
    }
  }
  sessionLines = [];
  writeStore();
}

/** Write one diagnostic line: console + localStorage ring + (when the WS is up) the server log. */
export function diag(msg: string, level: LogLevel = "info"): void {
  const line: DiagLine = { at: new Date().toISOString(), msg: msg.slice(0, LINE_CAP), level };
  console.info(`[player] ${line.msg}`);
  sessionLines.push(line);
  if (sessionLines.length > STORE_CAP) sessionLines.splice(0, sessionLines.length - STORE_CAP);
  writeStore();
  enqueue(line);
}

/** Wire the WS sender (call when the player socket exists) and flush anything queued. */
export function bindDiagSender(s: DiagSender): void {
  sender = s;
  drain();
}

/** Re-attempt queued sends — call whenever the socket (re)opens. */
export function flushDiag(): void {
  drain();
}

