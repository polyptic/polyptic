/**
 * POL-107 — the ROLE POLICY, and the guards that keep a deployment administrable.
 *
 * Two things are pinned here, and the negative half is the point:
 *
 *   1. `requiredRoleFor` — the per-route table. Every route the console can reach is asserted, in
 *      both directions: a viewer may read + apply a scene and NOTHING else; an operator may author
 *      content + layout but may not touch a machine, a setting or another account; and — the rule
 *      that makes the whole thing safe — a route NOBODY listed requires `admin` (deny by default),
 *      so tomorrow's new endpoint is closed until someone deliberately opens it.
 *   2. The last-admin guards on `AuthService` — a deployment that can demote or delete its final
 *      admin is a deployment nobody can administer again.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { AuthService, authConfigFromEnv } from "../src/auth-local";
import { requiredRoleFor, roleAllows } from "../src/roles";
import { MemoryStore } from "../src/store/memory";

describe("roleAllows — the ranking", () => {
  test("each role contains the one below it", () => {
    expect(roleAllows("admin", "viewer")).toBe(true);
    expect(roleAllows("admin", "operator")).toBe(true);
    expect(roleAllows("admin", "admin")).toBe(true);
    expect(roleAllows("operator", "viewer")).toBe(true);
    expect(roleAllows("operator", "operator")).toBe(true);
    expect(roleAllows("viewer", "viewer")).toBe(true);
  });

  test("and NOT the one above it", () => {
    expect(roleAllows("operator", "admin")).toBe(false);
    expect(roleAllows("viewer", "operator")).toBe(false);
    expect(roleAllows("viewer", "admin")).toBe(false);
  });
});

describe("requiredRoleFor — what a VIEWER may reach", () => {
  test("the registry reads", () => {
    expect(requiredRoleFor("GET", "/api/v1/state")).toBe("viewer");
    expect(requiredRoleFor("GET", "/api/v1/machines")).toBe("viewer");
    expect(requiredRoleFor("GET", "/api/v1/screens")).toBe("viewer");
    expect(requiredRoleFor("GET", "/api/v1/murals")).toBe("viewer");
    expect(requiredRoleFor("GET", "/api/v1/walls")).toBe("viewer");
    expect(requiredRoleFor("GET", "/api/v1/scenes")).toBe("viewer");
    expect(requiredRoleFor("GET", "/api/v1/content-sources")).toBe("viewer");
    expect(requiredRoleFor("GET", "/api/v1/screens/scr_1/thumbnail")).toBe("viewer");
  });

  test("applying a saved scene — the 'staff invoke' verb", () => {
    expect(requiredRoleFor("POST", "/api/v1/scenes/scene_1/apply")).toBe("viewer");
  });

  test("rotating its OWN password", () => {
    expect(requiredRoleFor("POST", "/api/v1/auth/change-password")).toBe("viewer");
  });
});

describe("requiredRoleFor — what a viewer may NOT reach (the negative matrix)", () => {
  test("a viewer cannot reboot, approve, reject or remove a box", () => {
    expect(requiredRoleFor("POST", "/api/v1/machines/m1/reboot")).toBe("admin");
    expect(requiredRoleFor("POST", "/api/v1/machines/m1/approve")).toBe("admin");
    expect(requiredRoleFor("POST", "/api/v1/machines/m1/reject")).toBe("admin");
    expect(requiredRoleFor("DELETE", "/api/v1/machines/m1")).toBe("admin");
  });

  test("a viewer cannot author content or layout (those are operator+)", () => {
    expect(requiredRoleFor("POST", "/api/v1/content-sources")).toBe("operator");
    expect(requiredRoleFor("PUT", "/api/v1/screens/scr_1/content")).toBe("operator");
    expect(requiredRoleFor("PUT", "/api/v1/walls/w1/content")).toBe("operator");
    expect(requiredRoleFor("POST", "/api/v1/scenes")).toBe("operator");
    expect(requiredRoleFor("DELETE", "/api/v1/scenes/s1")).toBe("operator");
    expect(requiredRoleFor("POST", "/api/v1/media")).toBe("operator");
  });
});

describe("requiredRoleFor — what an OPERATOR may NOT reach", () => {
  test("settings — every one of them is admin", () => {
    expect(requiredRoleFor("GET", "/api/v1/settings/enrollment")).toBe("admin");
    expect(requiredRoleFor("POST", "/api/v1/settings/enrollment/regenerate")).toBe("admin");
    expect(requiredRoleFor("GET", "/api/v1/settings/display")).toBe("admin");
    expect(requiredRoleFor("PUT", "/api/v1/settings/display")).toBe("admin");
    expect(requiredRoleFor("GET", "/api/v1/settings/image")).toBe("admin");
    expect(requiredRoleFor("PUT", "/api/v1/settings/image")).toBe("admin");
    expect(requiredRoleFor("POST", "/api/v1/settings/image/rebuild")).toBe("admin");
    expect(requiredRoleFor("POST", "/api/v1/settings/image/activate")).toBe("admin");
    expect(requiredRoleFor("GET", "/api/v1/settings/netboot")).toBe("admin");
    expect(requiredRoleFor("GET", "/api/v1/settings/https")).toBe("admin");
  });

  test("the shell, the DevTools tunnel and the inspector", () => {
    expect(requiredRoleFor("POST", "/api/v1/machines/m1/shell")).toBe("admin");
    expect(requiredRoleFor("GET", "/api/v1/screens/scr_1/devtools")).toBe("admin");
    expect(requiredRoleFor("GET", "/api/v1/screens/scr_1/devtools/json/list")).toBe("admin");
    expect(requiredRoleFor("POST", "/api/v1/screens/scr_1/inspect")).toBe("admin");
  });

  test("credential-profile MUTATIONS (they hold content secrets) — the redacted list is not", () => {
    expect(requiredRoleFor("GET", "/api/v1/credential-profiles")).toBe("viewer");
    expect(requiredRoleFor("POST", "/api/v1/credential-profiles")).toBe("admin");
    expect(requiredRoleFor("PATCH", "/api/v1/credential-profiles/p1")).toBe("admin");
    expect(requiredRoleFor("DELETE", "/api/v1/credential-profiles/p1")).toBe("admin");
    expect(requiredRoleFor("POST", "/api/v1/credential-profiles/p1/test")).toBe("admin");
  });

  test("operator management itself", () => {
    expect(requiredRoleFor("GET", "/api/v1/operators")).toBe("admin");
    expect(requiredRoleFor("POST", "/api/v1/operators")).toBe("admin");
    expect(requiredRoleFor("PATCH", "/api/v1/operators/user_1")).toBe("admin");
    expect(requiredRoleFor("DELETE", "/api/v1/operators/user_1")).toBe("admin");
  });
});

describe("requiredRoleFor — deny by default", () => {
  test("a route nobody listed is ADMIN, not open", () => {
    expect(requiredRoleFor("POST", "/api/v1/some/route/invented/tomorrow")).toBe("admin");
    expect(requiredRoleFor("DELETE", "/api/v1/state")).toBe("admin");
    // Same path, different method: the method is part of the key, so a listed GET does not open a PUT.
    expect(requiredRoleFor("PUT", "/api/v1/state")).toBe("admin");
    expect(requiredRoleFor("POST", "/api/v1/machines")).toBe("admin");
  });

  test("an id segment never swallows a slash (so /scenes/x/apply cannot be forged)", () => {
    // A single SEG is [^/]+ — `/scenes/a/b/apply` must NOT match the apply rule.
    expect(requiredRoleFor("POST", "/api/v1/scenes/a/b/apply")).toBe("admin");
  });

  test("paths outside /api/v1 are not this policy's business (null → the gate skips them)", () => {
    expect(requiredRoleFor("GET", "/healthz")).toBeNull();
    expect(requiredRoleFor("GET", "/metrics")).toBeNull();
    expect(requiredRoleFor("GET", "/media/abc")).toBeNull();
    expect(requiredRoleFor("GET", "/boot/grub.cfg")).toBeNull();
    expect(requiredRoleFor("GET", "/dist/image/amd64/manifest.json")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The guards that keep a deployment administrable.
// ─────────────────────────────────────────────────────────────────────────────

function serviceOn(store: MemoryStore): AuthService {
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as FastifyBaseLogger;
  return new AuthService({
    store,
    fastify: {} as unknown as FastifyInstance, // only the cookie helpers use it; unused here
    config: authConfigFromEnv({ AUTH_ENABLED: "true" }),
    log,
  });
}

describe("AuthService — operator management", () => {
  let store: MemoryStore;
  let auth: AuthService;

  beforeEach(async () => {
    store = new MemoryStore();
    auth = serviceOn(store);
    // The UPGRADE PATH in miniature: a deployment whose only account is the configured admin.
    await auth.seedAdmin({
      POLYPTIC_ADMIN_EMAIL: "admin@polyptic.test",
      POLYPTIC_ADMIN_PASSWORD: "seeded-admin-password",
    });
  });

  test("the seeded single account IS an admin (an upgrade is never a lockout)", async () => {
    const operators = await auth.listOperators();
    expect(operators).toHaveLength(1);
    expect(operators[0]?.email).toBe("admin@polyptic.test");
    expect(operators[0]?.role).toBe("admin");
  });

  test("seedAdmin never runs twice — an existing account is left exactly as it is", async () => {
    await auth.updateOperator((await auth.listOperators())[0]!.id, { role: "admin" });
    await auth.seedAdmin({ POLYPTIC_ADMIN_EMAIL: "other@polyptic.test", POLYPTIC_ADMIN_PASSWORD: "x" });
    const operators = await auth.listOperators();
    expect(operators).toHaveLength(1);
    expect(operators[0]?.email).toBe("admin@polyptic.test");
  });

  test("the LAST admin cannot be demoted", async () => {
    const admin = (await auth.listOperators())[0]!;
    expect(await auth.updateOperator(admin.id, { role: "viewer" })).toBe("last-admin");
    expect((await auth.listOperators())[0]?.role).toBe("admin"); // untouched
  });

  test("the LAST admin cannot be deleted", async () => {
    const admin = (await auth.listOperators())[0]!;
    expect(await auth.deleteOperator(admin.id)).toBe("last-admin");
    expect(await auth.listOperators()).toHaveLength(1);
  });

  test("with a SECOND admin, the first may be demoted — and then IT is the last one", async () => {
    const first = (await auth.listOperators())[0]!;
    const second = await auth.createOperator("second@polyptic.test", "second-admin-pw", "admin");
    expect(second).not.toBe("duplicate");

    expect(await auth.updateOperator(first.id, { role: "viewer" })).not.toBe("last-admin");
    // Only `second` is an admin now, so the guard closes behind it.
    expect(await auth.deleteOperator((second as { id: string }).id)).toBe("last-admin");
  });

  test("a duplicate email is refused rather than silently overwriting an account", async () => {
    expect(await auth.createOperator("dup@polyptic.test", "password-one", "viewer")).not.toBe("duplicate");
    expect(await auth.createOperator("DUP@polyptic.test", "password-two", "admin")).toBe("duplicate");
  });

  test("a created operator carries its role, and no hash ever leaves the service", async () => {
    const created = await auth.createOperator("viewer@polyptic.test", "viewer-password", "viewer");
    expect(created).not.toBe("duplicate");
    const view = created as Record<string, unknown>;
    expect(view.role).toBe("viewer");
    expect(view.passwordHash).toBeUndefined();
    expect(Object.keys(view).sort()).toEqual(["createdAt", "email", "id", "role"]);
  });

  test("an admin password RESET revokes that operator's live sessions", async () => {
    const target = await auth.createOperator("op@polyptic.test", "operator-password", "operator");
    const id = (target as { id: string }).id;
    const token = await auth.issueSession(id);
    expect(await auth.verifySessionToken(token)).not.toBeNull();

    await auth.updateOperator(id, { password: "a-brand-new-password" });
    // The old cookie is dead — a reset that leaves the session alive has reset nothing.
    expect(await auth.verifySessionToken(token)).toBeNull();
  });

  test("deleting an operator kills its sessions too", async () => {
    const target = await auth.createOperator("gone@polyptic.test", "operator-password", "operator");
    const id = (target as { id: string }).id;
    const token = await auth.issueSession(id);
    expect(await auth.verifySessionToken(token)).not.toBeNull();

    expect(await auth.deleteOperator(id)).toBe("ok");
    expect(await auth.verifySessionToken(token)).toBeNull();
  });

  test("a role change takes effect on the NEXT request — no re-login needed", async () => {
    const target = await auth.createOperator("demote@polyptic.test", "operator-password", "operator");
    const id = (target as { id: string }).id;
    const token = await auth.issueSession(id);
    expect((await auth.verifySessionToken(token))?.role).toBe("operator");

    await auth.updateOperator(id, { role: "viewer" });
    // Same cookie, less power: the role is read from the account, never baked into the session.
    expect((await auth.verifySessionToken(token))?.role).toBe("viewer");
  });
});
