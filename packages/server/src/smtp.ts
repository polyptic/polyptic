/**
 * A minimal SMTP client (POL-91) — enough to hand one short plain-text message to a relay, and not
 * one line more.
 *
 * WHY NOT A LIBRARY. The candidates (nodemailer et al.) are large, carry OAuth/attachment/DKIM/pool
 * machinery we will never use, and drag a Node-API surface into a Bun process for what is, on the
 * wire, a dozen lines of a 1982 protocol: EHLO → (STARTTLS) → AUTH → MAIL FROM → RCPT TO → DATA. The
 * whole client is below and every branch of it is exercised by `smtp.test.ts` against a fake relay.
 * We use `node:net`/`node:tls` (both native in Bun) rather than `Bun.connect` precisely because
 * STARTTLS needs to upgrade an ALREADY-OPEN socket, which `tls.connect({ socket })` does in one call.
 *
 * Three transports, chosen by config (`SMTP_TLS`):
 *   - `starttls` (default, port 587): plain connect, then upgrade in-band. The modern default.
 *   - `tls`      (implicit, port 465): TLS from the first byte.
 *   - `none`     (port 25/1025): plain — for a local relay / MailHog / an in-cluster smarthost.
 *
 * Failures throw with the relay's own reply text: that sentence is what an operator can act on, and
 * it is what the console's rule card shows verbatim.
 */
import net from "node:net";
import tls from "node:tls";

import type { Socket } from "node:net";

/** How the deployment reaches its relay. Wired from env in index.ts; absent = SMTP rules can't send. */
export interface SmtpConfig {
  host: string;
  port: number;
  /** `starttls` upgrades in-band, `tls` is implicit TLS, `none` is a plain hop to a trusted relay. */
  tls: "starttls" | "tls" | "none";
  user?: string;
  pass?: string;
  /** Envelope + header From. */
  from: string;
  /** Don't verify the relay's certificate (a self-signed in-cluster smarthost). Off by default. */
  insecure?: boolean;
  /** Whole-conversation timeout. */
  timeoutMs?: number;
}

export interface Mail {
  to: string[];
  subject: string;
  text: string;
}

/** The seam the notifier depends on — the real relay in production, a stub in the rule tests. */
export interface SmtpTransport {
  send(mail: Mail): Promise<void>;
}

/** Read the relay config out of the environment. Returns undefined when SMTP_HOST is unset — SMTP
 *  rules then refuse with a plain sentence rather than silently doing nothing. */
export function smtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | undefined {
  const host = env.SMTP_HOST?.trim();
  if (!host) return undefined;
  const mode = (env.SMTP_TLS?.trim().toLowerCase() ?? "starttls") as SmtpConfig["tls"];
  const port = Number(env.SMTP_PORT ?? (mode === "tls" ? 465 : mode === "none" ? 25 : 587));
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    tls: mode === "tls" || mode === "none" ? mode : "starttls",
    user: env.SMTP_USER?.trim() || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.SMTP_FROM?.trim() || `polyptic@${host}`,
    insecure: /^(1|true|yes)$/i.test(env.SMTP_INSECURE?.trim() ?? ""),
    timeoutMs: Number(env.SMTP_TIMEOUT_MS ?? 15_000),
  };
}

/** The real transport: one connection per message (a wall alerts rarely; a pool would be ceremony). */
export class SmtpClient implements SmtpTransport {
  constructor(private readonly config: SmtpConfig) {}

  async send(mail: Mail): Promise<void> {
    if (mail.to.length === 0) throw new Error("no recipients");
    const c = this.config;
    const timeoutMs = c.timeoutMs && c.timeoutMs > 0 ? c.timeoutMs : 15_000;

    let socket: Socket = await connect(c, timeoutMs);
    const session = new Session(socket, timeoutMs);
    try {
      await session.expect(220);
      let greeting = await session.command(`EHLO ${hostnameForEhlo()}`, 250);

      if (c.tls === "starttls") {
        if (!/\bSTARTTLS\b/i.test(greeting)) {
          throw new Error("the relay does not offer STARTTLS (set SMTP_TLS=none to send in the clear)");
        }
        await session.command("STARTTLS", 220);
        socket = await upgrade(socket, c, timeoutMs);
        session.rebind(socket);
        // The extension list is only trustworthy after the upgrade — re-EHLO, as RFC 3207 requires.
        greeting = await session.command(`EHLO ${hostnameForEhlo()}`, 250);
      }

      if (c.user !== undefined && c.pass !== undefined) {
        // AUTH PLAIN is the one every relay implements; a NUL-separated triple, base64'd.
        const auth = Buffer.from(`\0${c.user}\0${c.pass}`, "utf8").toString("base64");
        await session.command(`AUTH PLAIN ${auth}`, 235);
      }

      await session.command(`MAIL FROM:<${addressOf(c.from)}>`, 250);
      for (const rcpt of mail.to) await session.command(`RCPT TO:<${addressOf(rcpt)}>`, 250);
      await session.command("DATA", 354);
      await session.command(renderMessage(c.from, mail), 250);
      await session.command("QUIT", 221).catch(() => {
        /* a relay is allowed to hang up on QUIT — the message is already accepted */
      });
    } finally {
      session.close();
    }
  }
}

/** RFC 5322 message body. Dot-stuffed and CRLF-terminated, because DATA ends at a lone ".". */
function renderMessage(from: string, mail: Mail): string {
  const headers = [
    `From: ${from}`,
    `To: ${mail.to.join(", ")}`,
    `Subject: ${sanitizeHeader(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@polyptic>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
  ].join("\r\n");
  const body = mail.text
    .split(/\r?\n/)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
  return `${headers}\r\n\r\n${body}\r\n.`;
}

/** A header value can never carry a newline — that is header injection, and an alert title is data. */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}

/** Accept both "Name <a@b>" and a bare address wherever an envelope address is needed. */
function addressOf(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim();
}

function hostnameForEhlo(): string {
  return process.env.SMTP_EHLO_NAME?.trim() || "polyptic";
}

function connect(config: SmtpConfig, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      config.tls === "tls"
        ? tls.connect({
            host: config.host,
            port: config.port,
            servername: config.host,
            rejectUnauthorized: !config.insecure,
          })
        : net.connect({ host: config.host, port: config.port });
    const onError = (err: Error) => reject(err);
    socket.setTimeout(timeoutMs, () => reject(new Error(`timed out connecting to ${config.host}:${config.port}`)));
    socket.once("error", onError);
    socket.once(config.tls === "tls" ? "secureConnect" : "connect", () => {
      socket.removeListener("error", onError);
      resolve(socket as Socket);
    });
  });
}

function upgrade(socket: Socket, config: SmtpConfig, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername: config.host,
      rejectUnauthorized: !config.insecure,
    });
    const onError = (err: Error) => reject(err);
    secure.setTimeout(timeoutMs, () => reject(new Error("timed out negotiating STARTTLS")));
    secure.once("error", onError);
    secure.once("secureConnect", () => {
      secure.removeListener("error", onError);
      resolve(secure as unknown as Socket);
    });
  });
}

/**
 * The line-oriented half of the conversation: buffers inbound bytes, splits complete SMTP replies
 * (the last line of a reply has a SPACE after its code, continuations have a hyphen), and hands each
 * one to whoever is waiting. Anything the relay says that isn't the expected code is thrown VERBATIM.
 */
class Session {
  private buffer = "";
  private waiting: { code: number; resolve: (reply: string) => void; reject: (err: Error) => void } | null = null;
  private failure: Error | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private socket: Socket,
    private readonly timeoutMs: number,
  ) {
    this.bind();
  }

  /** Point at the TLS socket after a STARTTLS upgrade (the plain one is now the transport beneath). */
  rebind(socket: Socket): void {
    this.socket = socket;
    this.buffer = "";
    this.bind();
  }

  private bind(): void {
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("error", (err: Error) => this.fail(err));
    this.socket.on("close", () => this.fail(new Error("the relay closed the connection")));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // A reply is complete when a line reads "<code><space>…" — continuation lines use "<code>-…".
    const match = /^(?:\d{3}-.*\r?\n)*(\d{3}) [^\n]*\r?\n/.exec(this.buffer);
    if (!match) return;
    const reply = this.buffer.slice(0, match[0].length);
    this.buffer = this.buffer.slice(match[0].length);
    const code = Number(match[1]);
    const waiter = this.waiting;
    if (!waiter) return;
    this.waiting = null;
    this.clearTimer();
    if (code !== waiter.code) {
      waiter.reject(new Error(reply.trim()));
      return;
    }
    waiter.resolve(reply);
  }

  private fail(err: Error): void {
    this.failure = err;
    const waiter = this.waiting;
    this.waiting = null;
    this.clearTimer();
    waiter?.reject(err);
  }

  expect(code: number): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { code, resolve, reject };
      this.timer = setTimeout(() => this.fail(new Error(`timed out waiting for SMTP ${code}`)), this.timeoutMs);
    });
  }

  async command(line: string, expect: number): Promise<string> {
    if (this.failure) throw this.failure;
    const pending = this.expect(expect);
    this.socket.write(`${line}\r\n`);
    return pending;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  close(): void {
    this.clearTimer();
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
  }
}
