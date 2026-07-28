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

/**
 * Strip control characters from text destined for a log line.
 *
 * Not paranoia — this was found in the wild the moment POL-189 started ingesting the host's own
 * journal: a Bun error message arrived carrying `\t\x00\x00\x00\n\x00\x00\x00` in the middle
 * of a sentence, which rendered in the console as `— le not found in $PATH` (the NULs having eaten
 * the preceding word). Once the logger's input includes journald, Chrome's stderr and OS error
 * strings, "the message is clean UTF-8 text" stops being an assumption anyone gets to make.
 *
 * NUL in particular is the dangerous one: it survives JSON round-trips intact and then truncates at
 * whatever C-string boundary it eventually meets. Newlines and tabs go too — a log LINE is one
 * line, and an embedded newline in a rendered view or a `grep` of the NDJSON reads as two records.
 *
 * Kept separate from `redactUrl`/`redactMessage` because the concerns are different: redaction is
 * about secrets and MUST happen at the emitter; this is about well-formedness and is applied both
 * there and at the sink, so nothing binary can reach a partition whatever wrote it.
 */
export function sanitizeLogText(text: string): string {
  // C0 controls, DEL, and the C1 range. Replaced with a space rather than removed, so a mangled
  // word stays visibly mangled instead of silently closing up into a plausible different word.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/ {3,}/g, "  ");
}
