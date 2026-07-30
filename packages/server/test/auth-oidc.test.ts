/**
 * POL-191 — BROKERED SIGN-IN: the parts that decide who gets in and as what.
 *
 * The interesting assertions are the refusals:
 *
 *   - A brokered account has NO password, and no string offered to the local login page can ever
 *     authenticate one. That is the property that makes coexisting local + OIDC accounts safe.
 *   - An account is keyed on (issuer, subject), never on email — an IdP that recycles an address must
 *     not hand a new person somebody else's account.
 *   - The return path is same-origin only, or the sign-in endpoint is an open redirect.
 *   - The group→role mapping resolves most-powerful-first and is re-derived on EVERY sign-in, so the
 *     directory stays the authority.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { AuthService, authConfigFromEnv } from "../src/auth-local";
import { OidcService, oidcConfigFromEnv, safeReturnPath } from "../src/auth-oidc";
import { MemoryStore } from "../src/store/memory";

/** A logger that says nothing — these tests assert behaviour, not log lines. */
const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return silentLog;
  },
} as unknown as FastifyBaseLogger;

/** Just enough Fastify for the cookie signing the transaction relies on. */
const fakeFastify = {
  unsignCookie: (value: string) => ({ valid: true, renew: false, value }),
  parseCookie: (header: string) => Object.fromEntries(new URLSearchParams(header.replace(/; /g, "&"))),
  log: silentLog,
} as unknown as FastifyInstance;

function serviceWith(env: NodeJS.ProcessEnv): OidcService {
  const config = oidcConfigFromEnv(env, silentLog);
  if (!config) throw new Error("expected a usable OIDC config");
  return new OidcService({ config, fastify: fakeFastify, log: silentLog });
}

const BASE_ENV: NodeJS.ProcessEnv = {
  OIDC_ISSUER: "https://dex.example.org/dex",
  OIDC_CLIENT_ID: "polyptic",
  OIDC_CLIENT_SECRET: "shhh",
  PUBLIC_BASE_URL: "https://polyptic.example.org",
};

describe("oidcConfigFromEnv — configured, half-configured, or simply off", () => {
  test("nothing set is OFF, and that is the normal self-hosted case (not an error)", () => {
    expect(oidcConfigFromEnv({}, silentLog)).toBeNull();
  });

  test("an issuer with no client id is HALF-configured, and stays off rather than half-on", () => {
    expect(oidcConfigFromEnv({ OIDC_ISSUER: "https://dex.example.org" }, silentLog)).toBeNull();
    expect(oidcConfigFromEnv({ OIDC_CLIENT_ID: "polyptic" }, silentLog)).toBeNull();
  });

  test("with no PUBLIC_BASE_URL and no explicit redirect there is nowhere to come back to", () => {
    expect(
      oidcConfigFromEnv({ OIDC_ISSUER: "https://dex.example.org", OIDC_CLIENT_ID: "p" }, silentLog),
    ).toBeNull();
  });

  test("the redirect URI is derived from PUBLIC_BASE_URL, and a trailing slash does not double up", () => {
    const config = oidcConfigFromEnv(
      { ...BASE_ENV, PUBLIC_BASE_URL: "https://polyptic.example.org/" },
      silentLog,
    );
    expect(config?.redirectUri).toBe("https://polyptic.example.org/api/v1/auth/oidc/callback");
  });

  test("an explicit OIDC_REDIRECT_URI wins over the derived one", () => {
    const config = oidcConfigFromEnv(
      { ...BASE_ENV, OIDC_REDIRECT_URI: "https://elsewhere.example.org/cb" },
      silentLog,
    );
    expect(config?.redirectUri).toBe("https://elsewhere.example.org/cb");
  });

  test("the default role is `viewer` — a brokered account reads the fleet and is GRANTED anything more", () => {
    expect(oidcConfigFromEnv(BASE_ENV, silentLog)?.defaultRole).toBe("viewer");
  });

  test("a nonsense OIDC_DEFAULT_ROLE falls back to viewer rather than to something powerful", () => {
    expect(
      oidcConfigFromEnv({ ...BASE_ENV, OIDC_DEFAULT_ROLE: "superuser" }, silentLog)?.defaultRole,
    ).toBe("viewer");
  });

  test("group lists take commas or whitespace, and are folded to lower case for matching", () => {
    const config = oidcConfigFromEnv(
      { ...BASE_ENV, OIDC_ADMIN_GROUPS: "Wall-Admins, IT-Ops   Estates" },
      silentLog,
    );
    expect(config?.adminGroups).toEqual(["wall-admins", "it-ops", "estates"]);
  });

  test("the default scopes ask for groups — the mapping is useless without the claim", () => {
    expect(oidcConfigFromEnv(BASE_ENV, silentLog)?.scopes).toContain("groups");
  });
});

describe("roleFor — the directory decides the GLOBAL role", () => {
  test("most powerful wins: in both an admin and a viewer group, you are an admin", () => {
    const oidc = serviceWith({
      ...BASE_ENV,
      OIDC_ADMIN_GROUPS: "wall-admins",
      OIDC_VIEWER_GROUPS: "everyone",
    });
    expect(oidc.roleFor(["everyone", "wall-admins"])).toBe("admin");
  });

  test("the mapping is case-insensitive on both sides", () => {
    const oidc = serviceWith({ ...BASE_ENV, OIDC_OPERATOR_GROUPS: "Wall-Team" });
    expect(oidc.roleFor(["WALL-TEAM"])).toBe("operator");
  });

  test("in none of the mapped groups, you land on the default", () => {
    const oidc = serviceWith({ ...BASE_ENV, OIDC_ADMIN_GROUPS: "wall-admins" });
    expect(oidc.roleFor(["some-other-group"])).toBe("viewer");
    expect(oidc.roleFor([])).toBe("viewer");
  });

  test("with NO mapping configured at all, everyone is a viewer and grants do the rest", () => {
    const oidc = serviceWith(BASE_ENV);
    expect(oidc.roleFor(["wall-admins", "it-ops"])).toBe("viewer");
  });
});

describe("safeReturnPath — the sign-in endpoint is not an open redirect", () => {
  test("a same-origin path is honoured", () => {
    expect(safeReturnPath("/murals/atrium")).toBe("/murals/atrium");
  });

  test("an absolute URL to another host is refused", () => {
    expect(safeReturnPath("https://evil.example.org/phish")).toBe("/");
  });

  test("a PROTOCOL-RELATIVE url is refused — `//evil.example.org` is another host, not a path", () => {
    expect(safeReturnPath("//evil.example.org/phish")).toBe("/");
  });

  test("anything that is not a string, or is empty, lands on the console root", () => {
    expect(safeReturnPath(undefined)).toBe("/");
    expect(safeReturnPath("")).toBe("/");
    expect(safeReturnPath(42)).toBe("/");
    expect(safeReturnPath("murals/atrium")).toBe("/");
  });
});

describe("resolveOidcUser — provisioning, re-stamping, and the account it will NOT take over", () => {
  let store: MemoryStore;
  let auth: AuthService;

  const IDENTITY = {
    issuer: "https://dex.example.org/dex",
    subject: "CgVhbGV4EgRsZGFw",
    email: "alex@example.org",
    displayName: "Alex Godbehere",
    groups: ["wall-team"],
  };

  beforeEach(() => {
    store = new MemoryStore();
    auth = new AuthService({
      store,
      fastify: fakeFastify,
      config: authConfigFromEnv({ AUTH_ENABLED: "true", COOKIE_SECRET: "x".repeat(40) }),
      log: silentLog,
    });
  });

  test("first sign-in PROVISIONS the account, with the role the directory implied", async () => {
    const user = await auth.resolveOidcUser(IDENTITY, "operator");
    expect(user).not.toBe("email-taken");
    const view = user as { id: string; email: string; role: string; provider: string; groups: string[] };
    expect(view.email).toBe("alex@example.org");
    expect(view.role).toBe("operator");
    expect(view.provider).toBe("oidc");
    expect(view.groups).toEqual(["wall-team"]);
  });

  test("a provisioned account holds NO password hash — nothing on the login page can authenticate it", async () => {
    await auth.resolveOidcUser(IDENTITY, "operator");
    const row = await store.getUserByEmail("alex@example.org");
    expect(row?.passwordHash).toBeNull();

    // Every one of these is the generic refusal, not a session.
    for (const attempt of ["", "password", "alex@example.org", "null", "undefined"]) {
      const result = await auth.login("alex@example.org", attempt, "10.0.0.1");
      expect(result.ok).toBe(false);
    }
  });

  test("a brokered account cannot set a local password through change-password either", async () => {
    const user = (await auth.resolveOidcUser(IDENTITY, "operator")) as { id: string };
    expect(await auth.changePassword(user.id, "anything", "a-new-password")).toBe(false);
  });

  test("the SECOND sign-in re-uses the same account — it does not provision another", async () => {
    const first = (await auth.resolveOidcUser(IDENTITY, "operator")) as { id: string };
    const second = (await auth.resolveOidcUser(IDENTITY, "operator")) as { id: string };
    expect(second.id).toBe(first.id);
    expect(await store.countUsers()).toBe(1);
  });

  test("every sign-in RE-STAMPS role + groups — removing someone from an LDAP group demotes them", async () => {
    await auth.resolveOidcUser(IDENTITY, "admin");
    const demoted = (await auth.resolveOidcUser(
      { ...IDENTITY, groups: [] },
      "viewer",
    )) as { role: string; groups: string[] };
    expect(demoted.role).toBe("viewer");
    expect(demoted.groups).toEqual([]);
  });

  test("the account is keyed on (issuer, subject) — a CHANGED EMAIL follows the same person", async () => {
    const first = (await auth.resolveOidcUser(IDENTITY, "operator")) as { id: string };
    const renamed = (await auth.resolveOidcUser(
      { ...IDENTITY, email: "alex.godbehere@example.org" },
      "operator",
    )) as { id: string; email: string };
    expect(renamed.id).toBe(first.id);
    expect(renamed.email).toBe("alex.godbehere@example.org");
    expect(await store.countUsers()).toBe(1);
  });

  test("a DIFFERENT subject at the same email is a different person — and is refused, not merged", async () => {
    await auth.resolveOidcUser(IDENTITY, "operator");
    expect(await auth.resolveOidcUser({ ...IDENTITY, subject: "someone-else" }, "admin")).toBe(
      "email-taken",
    );
  });

  test("THE TAKEOVER GUARD: a brokered sign-in never absorbs an existing LOCAL account", async () => {
    const local = await auth.createOperator("alex@example.org", "a-local-password", "admin");
    expect(local).not.toBe("duplicate");
    expect(await auth.resolveOidcUser(IDENTITY, "viewer")).toBe("email-taken");

    // The local admin is untouched: same role, and its password still works.
    const result = await auth.login("alex@example.org", "a-local-password", "10.0.0.1");
    expect(result.ok).toBe(true);
  });

  test("an admin cannot reset a brokered account's password or role from Settings", async () => {
    const user = (await auth.resolveOidcUser(IDENTITY, "viewer")) as { id: string };
    expect(await auth.updateOperator(user.id, { password: "a-back-door" })).toBe("brokered");
    expect(await auth.updateOperator(user.id, { role: "admin" })).toBe("brokered");
  });

  test("emails are normalized, so the IdP's casing cannot create a second account", async () => {
    const user = (await auth.resolveOidcUser(
      { ...IDENTITY, email: "Alex@Example.ORG" },
      "viewer",
    )) as { email: string };
    expect(user.email).toBe("alex@example.org");
  });
});
