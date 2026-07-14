/**
 * @polyptic/e2e — scoped API tokens (POL-102/D97) against the LIVE control plane.
 *
 * The point of the feature is that an external system — a CI job, an incident tool, a cron — can
 * drive the wall with a credential of its own, and that the credential is genuinely narrow. So this
 * suite spawns the REAL server (`packages/server/src/index.ts`, `Bun.spawn`, PORT 8203, STORE=memory,
 * AUTH_ENABLED left unset → secure by default) and proves the gate end to end, over the wire:
 *
 *   1. the session path is UNCHANGED — no cookie, no token → 401.
 *   2. an operator (cookie) mints a token; the secret comes back exactly ONCE, prefixed `plp_`, and
 *      the list endpoint afterwards carries no secret at all.
 *   3. a `read` token drives GET /machines with `Authorization: Bearer` — and is refused (403) on a
 *      write it has no scope for, on the enrolment secret, and on token management (no self-minting).
 *   4. a `scenes:apply` token reaches the scene-apply route (the gate lets it through to the handler,
 *      which 404s an unknown scene — proof the refusal is the ROUTER's, not the gate's) and is refused
 *      on GET /machines, which it has no `read` scope for.
 *   5. a garbage bearer is 401; a REVOKED token is 401.
 *   6. repeated garbage from one IP trips the same 429 lockout that guards login (run LAST — the
 *      lockout is per-IP and every test here shares 127.0.0.1).
 *   7. the session cookie still authorizes throughout — the token path never weakened it.
 *
 * SECURITY DISCIPLINE: the server's stdout+stderr is captured and asserted at the end to contain the
 * `api.token.use` audit event (attribution: which token did what) and to contain NO minted secret.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ApiToken, ApiTokenCreated } from "@polyptic/protocol";

const PORT = 8203;
const BASE = `http://localhost:${PORT}`;
const TEST_TIMEOUT = 15_000;

const ADMIN_EMAIL = "operator@polyptic.test";
const ADMIN_PASSWORD = "e2e-correct-horse-battery";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers — a session cookie jar and a bearer sender, deliberately separate
// ─────────────────────────────────────────────────────────────────────────────

function rawSetCookies(res: Response): string[] {
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

let cookie = "";

function ingest(res: Response): void {
  for (const sc of rawSetCookies(res)) {
    const pair = sc.split(";")[0] ?? "";
    if (pair.includes("=") && !pair.endsWith("=")) cookie = pair;
  }
}

async function asOperator(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  ingest(res);
  return res;
}

/** The whole point: a request with NO cookie, only `Authorization: Bearer <secret>`. */
function asToken(secret: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Server process lifecycle (stdout captured so we can audit the logs at the end)
// ─────────────────────────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;
let serverLog = "";

async function drainStream(stream: ReadableStream<Uint8Array> | undefined | null): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    serverLog += decoder.decode(chunk, { stream: true });
  }
}

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/auth/me`);
      await drain(res);
      if (res.status > 0) return;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}: ${lastErr}`);
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      // AUTH_ENABLED intentionally UNSET → secure-by-default (auth ON). This suite proves the gate.
      COOKIE_SECRET: "e2e-cookie-secret-please-rotate-in-prod-0123456789",
      POLYPTIC_ADMIN_EMAIL: ADMIN_EMAIL,
      POLYPTIC_ADMIN_PASSWORD: ADMIN_PASSWORD,
      PLAYER_BASE_URL: "http://localhost:5173",
      // `info` so the api.token.use audit line is emitted — and so we can prove no secret rides along.
      LOG_LEVEL: "info",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  void drainStream(proc.stdout as ReadableStream<Uint8Array>);
  void drainStream(proc.stderr as ReadableStream<Uint8Array>);
  await waitForServer();
}, 30_000);

afterAll(async () => {
  if (proc) {
    proc.kill();
    try {
      await proc.exited;
    } catch {
      /* already gone */
    }
  }
}, 10_000);

// Secrets minted during the run — kept only to prove they never reach a log.
let readSecret = "";
let applySecret = "";
let revokedSecret = "";

describe("POL-102 scoped API tokens (gate ON)", () => {
  test(
    "the session gate is unchanged: no cookie, no token → 401",
    async () => {
      const res = await fetch(`${BASE}/api/v1/machines`);
      expect(res.status).toBe(401);
      await drain(res);
    },
    TEST_TIMEOUT,
  );

  test(
    "an operator signs in and mints a read token — the secret is returned exactly once",
    async () => {
      const login = await asOperator("POST", "/api/v1/auth/login", {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      });
      expect(login.status).toBeLessThan(300);
      await drain(login);
      expect(cookie.length).toBeGreaterThan(0);

      const created = await asOperator("POST", "/api/v1/settings/api-tokens", {
        name: "CI — build status",
        scopes: ["read"],
      });
      expect(created.status).toBe(201);
      const payload = ApiTokenCreated.parse(await created.json());
      readSecret = payload.secret;

      expect(readSecret.startsWith("plp_")).toBe(true);
      expect(payload.token.scopes).toEqual(["read"]);
      expect(payload.token.name).toBe("CI — build status");
      expect(payload.token.lastUsedAt).toBeNull();

      // The LIST endpoint never carries the secret again — only the safe view.
      const listed = await asOperator("GET", "/api/v1/settings/api-tokens");
      expect(listed.status).toBe(200);
      const text = await listed.text();
      expect(text).not.toContain(readSecret);
      const tokens = (JSON.parse(text) as { tokens: unknown[] }).tokens.map((t) => ApiToken.parse(t));
      expect(tokens.length).toBe(1);
      expect(tokens[0]?.prefix.startsWith("plp_")).toBe(true);
      expect(readSecret.startsWith(tokens[0]?.prefix ?? "!")).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "the read token drives GET /machines with Authorization: Bearer — no cookie in sight",
    async () => {
      const res = await asToken(readSecret, "GET", "/api/v1/machines");
      expect(res.status).toBe(200);
      const machines = await res.json();
      expect(Array.isArray(machines)).toBe(true);

      // And the use is recorded: lastUsedAt is no longer null when the operator lists tokens.
      const listed = await asOperator("GET", "/api/v1/settings/api-tokens");
      const tokens = ((await listed.json()) as { tokens: unknown[] }).tokens.map((t) => ApiToken.parse(t));
      expect(tokens[0]?.lastUsedAt).not.toBeNull();
    },
    TEST_TIMEOUT,
  );

  test(
    "the read token is refused (403) outside its scope, on the enrolment secret, and on token management",
    async () => {
      // A write it holds no scope for — and the message names the scope it lacks.
      const apply = await asToken(readSecret, "POST", "/api/v1/scenes/scene_x/apply");
      expect(apply.status).toBe(403);
      const body = (await apply.json()) as { error?: string };
      expect(body.error ?? "").toContain("scenes:apply");

      // The fleet's bootstrap secret is not token-readable, `read` scope or not.
      const enrol = await asToken(readSecret, "GET", "/api/v1/settings/enrollment");
      expect(enrol.status).toBe(403);
      await drain(enrol);

      // NO SELF-MINTING: a token can never create another token…
      const mint = await asToken(readSecret, "POST", "/api/v1/settings/api-tokens", {
        name: "escalation",
        scopes: ["admin"],
      });
      expect(mint.status).toBe(403);
      await drain(mint);

      // …nor list or revoke them.
      const list = await asToken(readSecret, "GET", "/api/v1/settings/api-tokens");
      expect(list.status).toBe(403);
      await drain(list);
    },
    TEST_TIMEOUT,
  );

  test(
    "a scenes:apply token reaches the scene-apply HANDLER (404 unknown scene) and nothing else",
    async () => {
      const created = await asOperator("POST", "/api/v1/settings/api-tokens", {
        name: "Alertmanager",
        scopes: ["scenes:apply"],
      });
      expect(created.status).toBe(201);
      applySecret = ApiTokenCreated.parse(await created.json()).secret;

      // The gate ADMITS it: the 404 is the scene router's answer, not the gate's refusal.
      const apply = await asToken(applySecret, "POST", "/api/v1/scenes/no-such-scene/apply");
      expect(apply.status).toBe(404);
      await drain(apply);

      // It holds no `read` scope, so even a harmless GET is refused.
      const read = await asToken(applySecret, "GET", "/api/v1/machines");
      expect(read.status).toBe(403);
      await drain(read);
    },
    TEST_TIMEOUT,
  );

  test(
    "a garbage bearer is 401, and a REVOKED token stops working immediately",
    async () => {
      const junk = await asToken(`plp_${"f".repeat(64)}`, "GET", "/api/v1/machines");
      expect(junk.status).toBe(401);
      await drain(junk);

      // Mint one, prove it works, revoke it, prove it doesn't.
      const created = await asOperator("POST", "/api/v1/settings/api-tokens", {
        name: "throwaway",
        scopes: ["read"],
      });
      const payload = ApiTokenCreated.parse(await created.json());
      revokedSecret = payload.secret;

      const before = await asToken(revokedSecret, "GET", "/api/v1/machines");
      expect(before.status).toBe(200);
      await drain(before);

      const revoked = await asOperator("DELETE", `/api/v1/settings/api-tokens/${payload.token.id}`);
      expect(revoked.status).toBe(200);
      await drain(revoked);

      const after = await asToken(revokedSecret, "GET", "/api/v1/machines");
      expect(after.status).toBe(401);
      await drain(after);

      // Revoking an unknown id is an honest 404.
      const again = await asOperator("DELETE", `/api/v1/settings/api-tokens/${payload.token.id}`);
      expect(again.status).toBe(404);
      await drain(again);
    },
    TEST_TIMEOUT,
  );

  test(
    "the operator's session still authorizes everything — the token path never weakened it",
    async () => {
      const machines = await asOperator("GET", "/api/v1/machines");
      expect(machines.status).toBe(200);
      await drain(machines);

      const enrol = await asOperator("GET", "/api/v1/settings/enrollment");
      expect(enrol.status).toBe(200);
      await drain(enrol);
    },
    TEST_TIMEOUT,
  );

  // LAST: the lockout is per-IP and every request in this file comes from 127.0.0.1.
  test(
    "repeated garbage bearers trip the login-style 429 lockout",
    async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await asToken(`plp_${String(i).repeat(64).slice(0, 64)}`, "GET", "/api/v1/machines");
        statuses.push(res.status);
        await drain(res);
      }
      expect(statuses).toContain(429);
      expect(statuses[statuses.length - 1]).toBe(429);
      for (const s of statuses) expect(s === 401 || s === 429).toBe(true);

      // Even a GENUINE token is held off while the cooldown runs (the limiter guards the IP)…
      const locked = await asToken(readSecret, "GET", "/api/v1/machines");
      expect(locked.status).toBe(429);
      expect(locked.headers.get("retry-after")).toBeTruthy();
      await drain(locked);

      // …but the operator's SESSION is untouched: the cookie is checked before the bearer path.
      const session = await asOperator("GET", "/api/v1/machines");
      expect(session.status).toBe(200);
      await drain(session);
    },
    TEST_TIMEOUT,
  );

  test(
    "the audit trail names the token and NEVER the secret",
    async () => {
      // Give the log a moment to flush the last lines.
      await sleep(300);
      // Attribution: a token-driven call is logged with its event, name and public prefix.
      expect(serverLog).toContain("api.token.use");
      expect(serverLog).toContain("CI — build status");
      // And no minted secret ever appears in the server's output.
      for (const secret of [readSecret, applySecret, revokedSecret]) {
        expect(secret.length).toBeGreaterThan(10);
        expect(serverLog).not.toContain(secret);
      }
    },
    TEST_TIMEOUT,
  );
});
