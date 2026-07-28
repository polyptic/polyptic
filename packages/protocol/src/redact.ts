/**
 * POL-187 — redaction, promoted to the protocol so ONE implementation serves every emitter.
 *
 * Content URLs carry auth tokens the server stamps into them at SEND time (POL-24). The player has
 * always been disciplined about this (`diag.ts`: "log them through `redactUrl()` only, never raw");
 * the agent never got the same discipline — `sway.ts` logged `spawned … → ${target.url}` with the
 * query intact. That was contained on the box while the only reader was `journalctl`. The moment
 * logs ship to a server with a Download button, it is a live credential in a ticket attachment.
 *
 * So redaction moved INTO the shared logger, and lives here: the player, the agent and the server
 * all redact the same way, and de-fanging the agent's existing raw-URL lines is part of the
 * refactor rather than a follow-up nobody does.
 */

/**
 * A content URL safe to put in a log line: origin + path only. The query is where a send-time auth
 * token lives, so it is NEVER logged — only whether one was present (`?…`).
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return (url.split("?")[0] ?? url).slice(0, 80);
  }
}

/** Matches an absolute http(s) URL inside free text — the shape a log message embeds one in. */
const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * Redact every URL found inside a free-text log message.
 *
 * This is the belt to `redactUrl`'s braces: a caller who interpolates a URL into a sentence (which
 * is how every existing agent line is written) gets the same protection as one who redacts by hand,
 * without every call site having to remember. Text with no URL in it is returned untouched.
 */
export function redactMessage(msg: string): string {
  if (!msg.includes("://")) return msg; // the overwhelmingly common case — no scan, no allocation
  return msg.replace(URL_IN_TEXT, (found) => {
    // A trailing sentence character is part of the prose, not the URL — put it back.
    const trailing = /[.,;:!?]+$/.exec(found);
    const bare = trailing ? found.slice(0, -trailing[0].length) : found;
    return redactUrl(bare) + (trailing ? trailing[0] : "");
  });
}
