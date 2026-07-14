/**
 * POL-91 — the minimal SMTP client, driven against a FAKE RELAY that speaks the real protocol on a
 * real socket (node:net). This is the case for not pulling in a mail library: the whole conversation
 * is testable end to end, in-process, in milliseconds.
 *
 * Covered: the happy dialogue (EHLO → AUTH PLAIN → MAIL FROM → RCPT TO → DATA → QUIT), the message
 * the recipient actually gets, multiple recipients, a relay that rejects a recipient, a relay that
 * rejects the credentials, and header-injection safety (an alert title is DATA, never a header).
 */
import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";

import { SmtpClient, smtpConfigFromEnv } from "../src/smtp";
import type { SmtpConfig } from "../src/smtp";

/** What the fake relay saw, once the client has hung up. */
interface Capture {
  commands: string[];
  message: string;
}

/** Rejections the relay can be told to perform, keyed by the command they answer. */
interface Reject {
  onAuth?: string;
  onRcpt?: string;
}

let servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

/** A plain-mode SMTP relay: enough of RFC 5321 to answer our client, and to record what it was told. */
async function fakeRelay(reject: Reject = {}): Promise<{ port: number; captured: Promise<Capture> }> {
  const commands: string[] = [];
  const dataLines: string[] = [];
  let resolveCapture: (c: Capture) => void;
  const captured = new Promise<Capture>((resolve) => {
    resolveCapture = resolve;
  });

  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.write("220 fake.relay ESMTP\r\n");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 2.0.0 Ok: queued\r\n");
          } else {
            dataLines.push(line);
          }
          continue;
        }

        commands.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") socket.write("250-fake.relay\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (verb === "AUTH") socket.write(reject.onAuth ?? "235 2.7.0 Authentication successful\r\n");
        else if (verb === "MAIL") socket.write("250 2.1.0 Ok\r\n");
        else if (verb === "RCPT") socket.write(reject.onRcpt ?? "250 2.1.5 Ok\r\n");
        else if (verb === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else socket.write("502 5.5.2 Not implemented\r\n");
      }
    });

    socket.on("close", () => resolveCapture({ commands, message: dataLines.join("\n") }));
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  return { port: address.port, captured };
}

function config(port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: "127.0.0.1",
    port,
    tls: "none", // the relay above is plain; TLS negotiation is the transport's job, not the dialogue's
    from: "Polyptic <polyptic@example.com>",
    timeoutMs: 4000,
    ...overrides,
  };
}

describe("the SMTP client", () => {
  test("walks the whole dialogue and hands the relay the message", async () => {
    const relay = await fakeRelay();
    const client = new SmtpClient(config(relay.port, { user: "polyptic", pass: "hunter2" }));

    await client.send({
      to: ["ops@example.com", "av@example.com"],
      subject: "[Polyptic] ALERT: Atrium box is offline",
      text: "Atrium box is offline\n\nKind:    machine-offline",
    });

    const { commands, message } = await relay.captured;
    const verbs = commands.map((c) => c.split(" ")[0]!.toUpperCase());
    expect(verbs).toEqual(["EHLO", "AUTH", "MAIL", "RCPT", "RCPT", "DATA", "QUIT"]);

    // AUTH PLAIN is the NUL-separated triple, base64'd — decode it back.
    const authArg = commands[1]!.split(" ")[2]!;
    expect(Buffer.from(authArg, "base64").toString("utf8")).toBe("\0polyptic\0hunter2");

    // The envelope carries bare addresses, even though From is "Name <addr>".
    expect(commands[2]).toBe("MAIL FROM:<polyptic@example.com>");
    expect(commands[3]).toBe("RCPT TO:<ops@example.com>");
    expect(commands[4]).toBe("RCPT TO:<av@example.com>");

    // And the message is a well-formed mail with both recipients and our body.
    expect(message).toContain("From: Polyptic <polyptic@example.com>");
    expect(message).toContain("To: ops@example.com, av@example.com");
    expect(message).toContain("Subject: [Polyptic] ALERT: Atrium box is offline");
    expect(message).toContain("Content-Type: text/plain; charset=\"utf-8\"");
    expect(message).toContain("Atrium box is offline");
    expect(message).toContain("Kind:    machine-offline");
  });

  test("with no credentials it skips AUTH entirely (an in-cluster relay usually wants none)", async () => {
    const relay = await fakeRelay();
    await new SmtpClient(config(relay.port)).send({
      to: ["ops@example.com"],
      subject: "hi",
      text: "body",
    });
    const { commands } = await relay.captured;
    expect(commands.map((c) => c.split(" ")[0]!.toUpperCase())).not.toContain("AUTH");
  });

  test("a rejected recipient throws the relay's own words, not ours", async () => {
    const relay = await fakeRelay({ onRcpt: "550 5.1.1 <nobody@example.com>: Recipient unknown\r\n" });
    const client = new SmtpClient(config(relay.port));
    await expect(
      client.send({ to: ["nobody@example.com"], subject: "hi", text: "body" }),
    ).rejects.toThrow(/550 5.1.1 .*Recipient unknown/);
  });

  test("bad credentials fail loudly (an operator can act on '535')", async () => {
    const relay = await fakeRelay({ onAuth: "535 5.7.8 Authentication credentials invalid\r\n" });
    const client = new SmtpClient(config(relay.port, { user: "u", pass: "wrong" }));
    await expect(client.send({ to: ["ops@example.com"], subject: "hi", text: "body" })).rejects.toThrow(
      /535/,
    );
  });

  test("a newline in the subject cannot forge a header — an alert title is data", async () => {
    const relay = await fakeRelay();
    await new SmtpClient(config(relay.port)).send({
      to: ["ops@example.com"],
      subject: "Atrium is down\r\nBcc: attacker@evil.example",
      text: "body",
    });
    const { message } = await relay.captured;
    // The CRLF is folded to a space, so the smuggled text stays INSIDE the Subject value — no line of
    // the message ever begins a Bcc header, which is the only thing that would have made it one.
    expect(message.split("\n").some((line) => /^bcc:/i.test(line))).toBe(false);
    expect(message).toContain("Subject: Atrium is down Bcc: attacker@evil.example");
  });

  test("a body line that starts with a dot is stuffed, so it cannot end DATA early", async () => {
    const relay = await fakeRelay();
    await new SmtpClient(config(relay.port)).send({
      to: ["ops@example.com"],
      subject: "hi",
      text: ".\nstill in the body",
    });
    const { message } = await relay.captured;
    expect(message).toContain("still in the body");
  });

  test("no recipients is refused before a socket is opened", async () => {
    await expect(
      new SmtpClient(config(1)).send({ to: [], subject: "hi", text: "body" }),
    ).rejects.toThrow(/no recipients/);
  });
});

describe("smtpConfigFromEnv", () => {
  test("no SMTP_HOST = no relay (smtp rules then say so rather than silently doing nothing)", () => {
    expect(smtpConfigFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  test("defaults to STARTTLS on 587, and each mode picks its own conventional port", () => {
    const starttls = smtpConfigFromEnv({ SMTP_HOST: "relay.example" } as NodeJS.ProcessEnv)!;
    expect(starttls).toMatchObject({ host: "relay.example", port: 587, tls: "starttls" });
    expect(starttls.from).toBe("polyptic@relay.example");

    const implicit = smtpConfigFromEnv({ SMTP_HOST: "relay.example", SMTP_TLS: "tls" } as NodeJS.ProcessEnv)!;
    expect(implicit).toMatchObject({ port: 465, tls: "tls" });

    const plain = smtpConfigFromEnv({ SMTP_HOST: "relay.example", SMTP_TLS: "none" } as NodeJS.ProcessEnv)!;
    expect(plain).toMatchObject({ port: 25, tls: "none" });

    const explicit = smtpConfigFromEnv({
      SMTP_HOST: "relay.example",
      SMTP_PORT: "2525",
      SMTP_TLS: "none",
      SMTP_USER: "u",
      SMTP_PASS: "p",
      SMTP_FROM: "walls@example.com",
    } as NodeJS.ProcessEnv)!;
    expect(explicit).toMatchObject({ port: 2525, user: "u", pass: "p", from: "walls@example.com" });
  });
});
