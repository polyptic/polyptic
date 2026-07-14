/**
 * Scoped API tokens (POL-102/D97) — the credential unit suite.
 *
 * The token IS the API's key, so these tests hold it to the same standard as the session and the 2b
 * machine credential: the store must never hold anything usable, the allow-list must be closed by
 * default, expiry/revocation must be enforced on every call, and a brute-force must run into the
 * same lockout that guards login. Nothing here ever asserts on a secret's value beyond proving it is
 * NOT what the store keeps.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { ApiTokenService, hashSecret, requiredScope, TOKEN_PREFIX } from "../src/api-tokens";
import { MemoryStore } from "../src/store/memory";

const IP = "10.0.0.1";

function service(): { svc: ApiTokenService; store: MemoryStore } {
  const store = new MemoryStore();
  return { svc: new ApiTokenService({ store }), store };
}

describe("POL-102 — minting", () => {
  test("a minted token is prefixed, high-entropy, and stored ONLY as its sha256", async () => {
    const { svc, store } = service();
    const { token, secret } = await svc.mint("CI", ["read"], "user_1");

    expect(secret.startsWith(TOKEN_PREFIX)).toBe(true);
    // 32 random bytes as hex.
    expect(secret.length).toBe(TOKEN_PREFIX.length + 64);

    const rows = await store.listApiTokens();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    // The plaintext appears NOWHERE in the persisted row — only its digest.
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.secretHash).toBe(createHash("sha256").update(secret, "utf8").digest("hex"));
    expect(row.secretHash).toBe(hashSecret(secret));
    // The display prefix is a leading, non-secret fragment — an identifier, not a key.
    expect(secret.startsWith(row.prefix)).toBe(true);
    expect(row.prefix.length).toBeLessThan(secret.length);

    // The safe view never carries a secret field.
    expect(Object.keys(token)).not.toContain("secret");
    expect(token.lastUsedAt).toBeNull();
    expect(token.expiresAt).toBeNull();
  });

  test("scopes are de-duplicated and an expiry is stamped when asked for", async () => {
    const { svc } = service();
    const { token } = await svc.mint("dupes", ["read", "read", "scenes:apply"], "user_1", 30);
    expect(token.scopes.sort()).toEqual(["read", "scenes:apply"]);
    expect(token.expiresAt).not.toBeNull();
    expect(Date.parse(token.expiresAt as string)).toBeGreaterThan(Date.now());
  });
});

describe("POL-102 — the route allow-list", () => {
  test("the documented verbs map to exactly one scope each", () => {
    expect(requiredScope("GET", "/machines")).toBe("read");
    expect(requiredScope("GET", "/scenes")).toBe("read");
    expect(requiredScope("POST", "/scenes/scene_1/apply")).toBe("scenes:apply");
    expect(requiredScope("PUT", "/screens/screen_1/content")).toBe("content:write");
    expect(requiredScope("PUT", "/walls/wall_1/content")).toBe("content:write");
    expect(requiredScope("POST", "/machines/box_1/reboot")).toBe("machines:operate");
    expect(requiredScope("POST", "/screens/screen_1/ident")).toBe("machines:operate");
  });

  test("everything else is closed to tokens — no scope names it, so no scope grants it", () => {
    // Auth + token management (a token must never mint a token or touch a session).
    expect(requiredScope("POST", "/auth/change-password")).toBeNull();
    expect(requiredScope("GET", "/settings/api-tokens")).toBeNull();
    expect(requiredScope("POST", "/settings/api-tokens")).toBeNull();
    // The fleet's bootstrap secret + the remote-debugger tunnel.
    expect(requiredScope("GET", "/settings/enrollment")).toBeNull();
    expect(requiredScope("GET", "/screens/screen_1/devtools")).toBeNull();
    // Destructive registry verbs stay operator-only.
    expect(requiredScope("DELETE", "/machines/box_1")).toBeNull();
    expect(requiredScope("POST", "/machines/box_1/approve")).toBeNull();
    expect(requiredScope("DELETE", "/scenes/scene_1")).toBeNull();
    expect(requiredScope("POST", "/settings/image/rebuild")).toBeNull();
  });
});

describe("POL-102 — verifying a token on a request", () => {
  test("the right secret with the right scope is admitted, and lastUsedAt is stamped", async () => {
    const { svc } = service();
    const { token, secret } = await svc.mint("CI", ["read"], "user_1");

    const verdict = await svc.authorize(secret, "GET", "/machines", IP);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.token.id).toBe(token.id);
      expect(verdict.token.name).toBe("CI");
      expect(verdict.token.scopes).toEqual(["read"]);
    }

    const [row] = await svc.list();
    expect(row?.lastUsedAt).not.toBeNull();
  });

  test("a wrong secret is refused with 401", async () => {
    const { svc } = service();
    await svc.mint("CI", ["read"], "user_1");
    const verdict = await svc.authorize(`${TOKEN_PREFIX}${"0".repeat(64)}`, "GET", "/machines", IP);
    expect(verdict).toMatchObject({ ok: false, status: 401 });
  });

  test("an expired token is refused with 401, even inside its scope", async () => {
    const { svc } = service();
    const { secret } = await svc.mint("stale", ["read"], "user_1", 1);
    const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const verdict = await svc.authorize(secret, "GET", "/machines", IP, later);
    expect(verdict).toMatchObject({ ok: false, status: 401 });
    if (!verdict.ok) expect(verdict.error).toContain("expired");
  });

  test("a REVOKED token is refused with 401 — the row is gone", async () => {
    const { svc } = service();
    const { token, secret } = await svc.mint("CI", ["read"], "user_1");
    expect(await svc.authorize(secret, "GET", "/machines", IP)).toMatchObject({ ok: true });

    expect(await svc.revoke(token.id)).toBe(true);
    expect(await svc.revoke(token.id)).toBe(false); // already gone → REST can 404 honestly
    expect((await svc.list()).length).toBe(0);

    expect(await svc.authorize(secret, "GET", "/machines", IP)).toMatchObject({ ok: false, status: 401 });
  });

  test("a valid token OUTSIDE its scope is refused with 403 and told which scope it lacks", async () => {
    const { svc } = service();
    const { secret } = await svc.mint("reader", ["read"], "user_1");
    const verdict = await svc.authorize(secret, "POST", "/scenes/scene_1/apply", IP);
    expect(verdict).toMatchObject({ ok: false, status: 403 });
    if (!verdict.ok) expect(verdict.error).toContain("scenes:apply");
  });

  test("no scope — not even admin — reaches a route off the allow-list", async () => {
    const { svc } = service();
    const { secret } = await svc.mint("root", ["admin"], "user_1");
    for (const [method, path] of [
      ["POST", "/settings/api-tokens"],
      ["GET", "/settings/enrollment"],
      ["POST", "/auth/change-password"],
      ["DELETE", "/machines/box_1"],
      ["GET", "/screens/screen_1/devtools"],
    ] as const) {
      expect(await svc.authorize(secret, method, path, IP)).toMatchObject({ ok: false, status: 403 });
    }
  });

  test("admin unlocks every documented verb; a narrow token unlocks only its own", async () => {
    const { svc } = service();
    const { secret: admin } = await svc.mint("root", ["admin"], "user_1");
    const { secret: applier } = await svc.mint("alertmanager", ["scenes:apply"], "user_1");

    expect(await svc.authorize(admin, "POST", "/scenes/s/apply", IP)).toMatchObject({ ok: true });
    expect(await svc.authorize(admin, "PUT", "/screens/x/content", IP)).toMatchObject({ ok: true });
    expect(await svc.authorize(admin, "POST", "/machines/m/reboot", IP)).toMatchObject({ ok: true });

    expect(await svc.authorize(applier, "POST", "/scenes/s/apply", IP)).toMatchObject({ ok: true });
    expect(await svc.authorize(applier, "PUT", "/screens/x/content", IP)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await svc.authorize(applier, "GET", "/machines", IP)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("POL-102 — the brute-force limiter (login's posture, on the bearer path)", () => {
  test("5 rejected tokens from one IP trip a 429 lockout; another IP is untouched", async () => {
    const { svc } = service();
    const { secret } = await svc.mint("CI", ["read"], "user_1");
    const attacker = "203.0.113.9";

    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const verdict = await svc.authorize(
        `${TOKEN_PREFIX}${i.toString().repeat(64).slice(0, 64)}`,
        "GET",
        "/machines",
        attacker,
      );
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) statuses.push(verdict.status);
    }
    expect(statuses).toContain(429);
    expect(statuses[statuses.length - 1]).toBe(429);

    // Even the GENUINE token is locked out from that IP while the cooldown holds…
    expect(await svc.authorize(secret, "GET", "/machines", attacker)).toMatchObject({
      ok: false,
      status: 429,
    });
    // …but the lockout is per-IP: an honest caller elsewhere is unaffected.
    expect(await svc.authorize(secret, "GET", "/machines", "198.51.100.4")).toMatchObject({ ok: true });
  });

  test("a 403 (wrong scope) is NOT a credential failure and never trips the limiter", async () => {
    const { svc } = service();
    const { secret } = await svc.mint("reader", ["read"], "user_1");
    const ip = "203.0.113.20";
    for (let i = 0; i < 7; i++) {
      expect(await svc.authorize(secret, "POST", "/scenes/s/apply", ip)).toMatchObject({
        ok: false,
        status: 403,
      });
    }
    // The token is genuine — it must still work on a route it DOES hold.
    expect(await svc.authorize(secret, "GET", "/machines", ip)).toMatchObject({ ok: true });
  });
});
