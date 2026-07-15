/**
 * @polyptic/e2e — MULTI-OPERATOR ROLES (POL-107) against the live control plane.
 *
 * The claim under test: enforcement is SERVER-SIDE. A console that merely hides buttons is not a
 * permission system, so this suite never touches the console — it signs in as each role over real
 * HTTP with a real session cookie and calls the routes directly.
 *
 * The negative half is the whole value:
 *   - a VIEWER cannot reboot a box, cannot assign content, cannot mint an operator, cannot read the
 *     enrolment secret — and cannot open a remote shell on a wall over the /admin WebSocket.
 *   - an OPERATOR cannot change settings, cannot approve/reboot/remove a machine, cannot list or
 *     create accounts, and cannot open the DevTools tunnel.
 *   - what each role CAN do is checked too, because a gate that refuses everything also "passes"
 *     every negative test.
 *
 * THE UPGRADE PATH is asserted first: the deployment boots with only the classic
 * POLYPTIC_ADMIN_EMAIL/PASSWORD credential (the helm `secrets.adminEmail` seam), and that account
 * must come back as a full ADMIN — an upgrade must never lock an operator out of their own wall.
 *
 * Discipline, as in the D29 suite: we assert on STATUS CODES and public shapes. Never on a password
 * or a hash.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthUser, Operator } from "@polyptic/protocol";

const PORT = 8104;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 20_000;

// The pre-existing single account: exactly what an already-deployed stack has configured today.
const ADMIN_EMAIL = "admin@polyptic.test";
const ADMIN_PASSWORD = "e2e-existing-admin-credential";

const OPERATOR_EMAIL = "operator@polyptic.test";
const OPERATOR_PASSWORD = "e2e-operator-credential";
const VIEWER_EMAIL = "viewer@polyptic.test";
const VIEWER_PASSWORD = "e2e-viewer-credential";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── A cookie jar (one per signed-in role) ────────────────────────────────────

function rawSetCookies(res: Response): string[] {
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

class CookieJar {
  private readonly jar = new Map<string, string>();

  ingest(res: Response): void {
    for (const sc of rawSetCookies(res)) {
      const firstPair = sc.split(";")[0] ?? "";
      const eq = firstPair.indexOf("=");
      if (eq < 0) continue;
      const name = firstPair.slice(0, eq).trim();
      const value = firstPair.slice(eq + 1).trim();
      if (value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  }
}

async function req(
  method: string,
  path: string,
  opts: { jar?: CookieJar; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const cookie = opts.jar?.header() ?? "";
  if (cookie) headers["cookie"] = cookie;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  opts.jar?.ingest(res);
  await res.body?.cancel().catch(() => {});
  return res;
}

/** Same, but keeps the body (for the few places we read a payload). */
async function reqJson<T>(
  method: string,
  path: string,
  opts: { jar?: CookieJar; body?: unknown } = {},
): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = {};
  const cookie = opts.jar?.header() ?? "";
  if (cookie) headers["cookie"] = cookie;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  opts.jar?.ingest(res);
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

async function signIn(email: string, password: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const res = await req("POST", "/api/v1/auth/login", { jar, body: { email, password } });
  if (res.status < 200 || res.status >= 300) throw new Error(`login failed for ${email}: ${res.status}`);
  return jar;
}

/** The role the SERVER reports for a jar's session — the console reads exactly this. */
async function roleOf(jar: CookieJar): Promise<string> {
  const { json } = await reqJson<{ user: unknown }>("GET", "/api/v1/auth/me", { jar });
  return AuthUser.parse(json.user).role;
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/auth/me`);
      await res.body?.cancel().catch(() => {});
      if (res.status > 0) return;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}: ${lastErr}`);
}

const admin = { jar: null as CookieJar | null };
const operator = { jar: null as CookieJar | null, id: "" };
const viewer = { jar: null as CookieJar | null, id: "" };

beforeAll(async () => {
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      // AUTH_ENABLED unset → secure by default. The ONLY account configured is the classic single
      // admin credential — i.e. exactly the state of a deployment upgrading INTO this feature.
      COOKIE_SECRET: "e2e-roles-cookie-secret-please-rotate-0123456789",
      POLYPTIC_ADMIN_EMAIL: ADMIN_EMAIL,
      POLYPTIC_ADMIN_PASSWORD: ADMIN_PASSWORD,
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
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

// ─────────────────────────────────────────────────────────────────────────────

describe("POL-107 — the upgrade path", () => {
  test(
    "the deployment's EXISTING single admin credential still signs in, and it is an ADMIN",
    async () => {
      admin.jar = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(await roleOf(admin.jar)).toBe("admin");

      // And it is the deployment's ONLY account — nothing was silently seeded alongside it.
      const { status, json } = await reqJson<{ operators: unknown[] }>("GET", "/api/v1/operators", {
        jar: admin.jar,
      });
      expect(status).toBe(200);
      const operators = json.operators.map((o) => Operator.parse(o));
      expect(operators).toHaveLength(1);
      expect(operators[0]?.email).toBe(ADMIN_EMAIL);
      expect(operators[0]?.role).toBe("admin");
      // No secret may ride the listing.
      expect(JSON.stringify(operators)).not.toContain(ADMIN_PASSWORD);
      expect(JSON.stringify(operators)).not.toContain("$argon2");
    },
    TEST_TIMEOUT,
  );

  test(
    "the admin invites an operator and a viewer",
    async () => {
      const op = await reqJson<{ operator: unknown }>("POST", "/api/v1/operators", {
        jar: admin.jar!,
        body: { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD, role: "operator" },
      });
      expect(op.status).toBe(201);
      operator.id = Operator.parse(op.json.operator).id;

      const vw = await reqJson<{ operator: unknown }>("POST", "/api/v1/operators", {
        jar: admin.jar!,
        body: { email: VIEWER_EMAIL, password: VIEWER_PASSWORD, role: "viewer" },
      });
      expect(vw.status).toBe(201);
      viewer.id = Operator.parse(vw.json.operator).id;

      operator.jar = await signIn(OPERATOR_EMAIL, OPERATOR_PASSWORD);
      viewer.jar = await signIn(VIEWER_EMAIL, VIEWER_PASSWORD);
      expect(await roleOf(operator.jar)).toBe("operator");
      expect(await roleOf(viewer.jar)).toBe("viewer");
    },
    TEST_TIMEOUT,
  );

  test(
    "a duplicate email is refused (409), not silently overwritten",
    async () => {
      const dup = await req("POST", "/api/v1/operators", {
        jar: admin.jar!,
        body: { email: VIEWER_EMAIL, password: "another-password", role: "admin" },
      });
      expect(dup.status).toBe(409);
    },
    TEST_TIMEOUT,
  );
});

describe("POL-107 — a VIEWER", () => {
  test(
    "CAN read the registry",
    async () => {
      for (const path of ["/api/v1/state", "/api/v1/machines", "/api/v1/scenes", "/api/v1/content-sources"]) {
        const res = await req("GET", path, { jar: viewer.jar! });
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "CANNOT reboot a box (403) — the marketing-can-reboot-boxes bug, closed",
    async () => {
      const res = await req("POST", "/api/v1/machines/machine-1/reboot", { jar: viewer.jar! });
      // 403, NOT 404: the gate refuses it before the handler ever looks the machine up. (A 404 here
      // would mean the request reached the handler, i.e. an existing machine WOULD have rebooted.)
      expect(res.status).toBe(403);
    },
    TEST_TIMEOUT,
  );

  test(
    "CANNOT approve, reject or remove a machine (403)",
    async () => {
      expect((await req("POST", "/api/v1/machines/machine-1/approve", { jar: viewer.jar! })).status).toBe(403);
      expect((await req("POST", "/api/v1/machines/machine-1/reject", { jar: viewer.jar! })).status).toBe(403);
      expect((await req("DELETE", "/api/v1/machines/machine-1", { jar: viewer.jar! })).status).toBe(403);
    },
    TEST_TIMEOUT,
  );

  test(
    "CANNOT change content, delete content, or delete a scene (403)",
    async () => {
      expect(
        (
          await req("PUT", "/api/v1/screens/scr-1/content", {
            jar: viewer.jar!,
            body: { sourceId: "src-1" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await req("POST", "/api/v1/content-sources", {
            jar: viewer.jar!,
            body: { name: "nope", kind: "web", url: "https://example.org" },
          })
        ).status,
      ).toBe(403);
      expect((await req("DELETE", "/api/v1/scenes/scene-1", { jar: viewer.jar! })).status).toBe(403);
    },
    TEST_TIMEOUT,
  );

  test(
    "CANNOT read the enrolment secret or touch settings (403)",
    async () => {
      expect((await req("GET", "/api/v1/settings/enrollment", { jar: viewer.jar! })).status).toBe(403);
      expect((await req("POST", "/api/v1/settings/enrollment/regenerate", { jar: viewer.jar! })).status).toBe(403);
      expect((await req("GET", "/api/v1/settings/image", { jar: viewer.jar! })).status).toBe(403);
    },
    TEST_TIMEOUT,
  );

  test(
    "CANNOT list or mint accounts — no privilege self-escalation (403)",
    async () => {
      expect((await req("GET", "/api/v1/operators", { jar: viewer.jar! })).status).toBe(403);
      expect(
        (
          await req("POST", "/api/v1/operators", {
            jar: viewer.jar!,
            body: { email: "escalate@polyptic.test", password: "escalate-me-please", role: "admin" },
          })
        ).status,
      ).toBe(403);
      // …and it cannot promote ITSELF by patching its own account.
      expect(
        (await req("PATCH", `/api/v1/operators/${viewer.id}`, { jar: viewer.jar!, body: { role: "admin" } }))
          .status,
      ).toBe(403);
      expect(await roleOf(viewer.jar!)).toBe("viewer");
    },
    TEST_TIMEOUT,
  );

  test(
    "CAN apply a saved scene — the one mutation it holds (reaches the handler: 404, not 403)",
    async () => {
      const res = await req("POST", "/api/v1/scenes/no-such-scene/apply", { jar: viewer.jar! });
      // The scene id is deliberately unknown, so the HANDLER answers 404. What matters is that the
      // gate let it through: a 403 here would mean a viewer can never invoke anything.
      expect(res.status).toBe(404);
    },
    TEST_TIMEOUT,
  );

  test(
    "CAN change its own password (reaches the handler: 401 on a wrong current, never 403)",
    async () => {
      const res = await req("POST", "/api/v1/auth/change-password", {
        jar: viewer.jar!,
        body: { currentPassword: "definitely-not-it", newPassword: "a-brand-new-password" },
      });
      expect(res.status).toBe(401); // wrong current password — but the ROLE was allowed through
    },
    TEST_TIMEOUT,
  );

  test(
    "CANNOT open a remote shell on a box over the /admin WebSocket (the sharpest verb of all)",
    async () => {
      const ws = new WebSocket(`${WS}/admin`, { headers: { cookie: viewer.jar!.header() } } as never);
      const frames: Record<string, unknown>[] = [];
      const opened = new Promise<void>((res, rej) => {
        ws.addEventListener("open", () => res());
        ws.addEventListener("error", () => rej(new Error("viewer could not open /admin")));
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        try {
          frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
        } catch {
          /* not JSON — ignore */
        }
      });
      await opened;

      // The upgrade itself SUCCEEDS — that is how a viewer receives state at all (read access).
      ws.send(JSON.stringify({ t: "admin/shell-open", machineId: "machine-1", cols: 80, rows: 24 }));
      await sleep(600);
      ws.close();

      const opens = frames.filter((f) => f.t === "server/shell-opened");
      // The server must REFUSE it explicitly (not merely stay silent — that would also satisfy an
      // `every()` over an empty list, which is how this assertion could lie).
      expect(opens.length).toBeGreaterThan(0);
      expect(opens.every((f) => f.ok === false)).toBe(true);
      expect(frames.some((f) => f.t === "server/shell-data")).toBe(false);
      // …and it DID get state on that socket (the read half is intact).
      expect(frames.some((f) => f.t === "admin/state")).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe("POL-107 — an OPERATOR", () => {
  test(
    "CAN author the content library (201) — the whole point of the role",
    async () => {
      const res = await reqJson<{ id?: string }>("POST", "/api/v1/content-sources", {
        jar: operator.jar!,
        body: { name: "operator's dashboard", kind: "web", url: "https://example.org/dash" },
      });
      expect([200, 201]).toContain(res.status);
    },
    TEST_TIMEOUT,
  );

  test(
    "CANNOT change settings (403) — display, enrolment, image builds",
    async () => {
      expect(
        (await req("PUT", "/api/v1/settings/display", { jar: operator.jar!, body: { showBadges: true } })).status,
      ).toBe(403);
      expect((await req("GET", "/api/v1/settings/enrollment", { jar: operator.jar! })).status).toBe(403);
      expect((await req("POST", "/api/v1/settings/enrollment/regenerate", { jar: operator.jar! })).status).toBe(403);
      expect((await req("POST", "/api/v1/settings/image/rebuild", { jar: operator.jar!, body: { kind: "refresh" } })).status).toBe(403);
      expect((await req("GET", "/api/v1/settings/https", { jar: operator.jar! })).status).toBe(403);
    },
    TEST_TIMEOUT,
  );

  test(
    "CANNOT reboot, approve or remove a machine, nor arm its shell (403)",
    async () => {
      expect((await req("POST", "/api/v1/machines/machine-1/reboot", { jar: operator.jar! })).status).toBe(403);
      expect((await req("POST", "/api/v1/machines/machine-1/approve", { jar: operator.jar! })).status).toBe(403);
      expect((await req("DELETE", "/api/v1/machines/machine-1", { jar: operator.jar! })).status).toBe(403);
      expect(
        (await req("POST", "/api/v1/machines/machine-1/shell", { jar: operator.jar!, body: { enabled: true } })).status,
      ).toBe(403);
    },
    TEST_TIMEOUT,
  );

  test(
    "CANNOT open the DevTools tunnel into a wall's browser (403)",
    async () => {
      expect((await req("GET", "/api/v1/screens/scr-1/devtools", { jar: operator.jar! })).status).toBe(403);
      expect((await req("POST", "/api/v1/screens/scr-1/inspect", { jar: operator.jar! })).status).toBe(403);
    },
    TEST_TIMEOUT,
  );

  test(
    "CANNOT manage accounts, and CANNOT promote itself (403)",
    async () => {
      expect((await req("GET", "/api/v1/operators", { jar: operator.jar! })).status).toBe(403);
      expect(
        (await req("PATCH", `/api/v1/operators/${operator.id}`, { jar: operator.jar!, body: { role: "admin" } }))
          .status,
      ).toBe(403);
      expect(await roleOf(operator.jar!)).toBe("operator");
    },
    TEST_TIMEOUT,
  );

  test(
    "CANNOT create, edit or delete a credential profile — those hold content secrets (403)",
    async () => {
      expect(
        (
          await req("POST", "/api/v1/credential-profiles", {
            jar: operator.jar!,
            body: {
              name: "nope",
              strategy: "client_credentials",
              tokenEndpoint: "https://idp.example.org/token",
              clientId: "id",
              clientSecret: "secret",
            },
          })
        ).status,
      ).toBe(403);
      expect((await req("DELETE", "/api/v1/credential-profiles/p-1", { jar: operator.jar! })).status).toBe(403);
      // The redacted LIST stays readable — it is in admin/state anyway.
      expect((await req("GET", "/api/v1/credential-profiles", { jar: operator.jar! })).status).toBe(200);
    },
    TEST_TIMEOUT,
  );
});

describe("POL-107 — an ADMIN, and the guards that keep one", () => {
  test(
    "CAN reach the fleet + settings surface a viewer and an operator could not",
    async () => {
      expect((await req("GET", "/api/v1/settings/enrollment", { jar: admin.jar! })).status).toBe(200);
      expect((await req("GET", "/api/v1/settings/image", { jar: admin.jar! })).status).toBe(200);
      expect((await req("GET", "/api/v1/operators", { jar: admin.jar! })).status).toBe(200);
      expect(
        (await req("PUT", "/api/v1/settings/display", { jar: admin.jar!, body: { showBadges: true } })).status,
      ).toBe(200);
    },
    TEST_TIMEOUT,
  );

  test(
    "a demotion takes effect on the demoted operator's EXISTING session — no re-login needed",
    async () => {
      // The operator could author a moment ago (tested above). Demote it to viewer…
      const patch = await req("PATCH", `/api/v1/operators/${operator.id}`, {
        jar: admin.jar!,
        body: { role: "viewer" },
      });
      expect(patch.status).toBe(200);

      // …and its live cookie now buys strictly less: authoring is refused, reading still works.
      expect(await roleOf(operator.jar!)).toBe("viewer");
      expect(
        (
          await req("POST", "/api/v1/content-sources", {
            jar: operator.jar!,
            body: { name: "after the demotion", kind: "web", url: "https://example.org" },
          })
        ).status,
      ).toBe(403);
      expect((await req("GET", "/api/v1/state", { jar: operator.jar! })).status).toBe(200);

      // Restore it for the remaining tests.
      await req("PATCH", `/api/v1/operators/${operator.id}`, { jar: admin.jar!, body: { role: "operator" } });
    },
    TEST_TIMEOUT,
  );

  test(
    "a password RESET by an admin kills that operator's live session (401 afterwards)",
    async () => {
      const doomed = await reqJson<{ operator: unknown }>("POST", "/api/v1/operators", {
        jar: admin.jar!,
        body: { email: "reset-me@polyptic.test", password: "the-old-password", role: "viewer" },
      });
      expect(doomed.status).toBe(201);
      const id = Operator.parse(doomed.json.operator).id;

      const jar = await signIn("reset-me@polyptic.test", "the-old-password");
      expect((await req("GET", "/api/v1/state", { jar })).status).toBe(200);

      const patch = await req("PATCH", `/api/v1/operators/${id}`, {
        jar: admin.jar!,
        body: { password: "the-brand-new-password" },
      });
      expect(patch.status).toBe(200);

      // The old cookie is dead. A reset that leaves the session alive has reset nothing.
      expect((await req("GET", "/api/v1/state", { jar })).status).toBe(401);
    },
    TEST_TIMEOUT,
  );

  test(
    "an admin cannot demote or delete ITSELF — the console must never lock its own operator out",
    async () => {
      const me = AuthUser.parse(
        (await reqJson<{ user: unknown }>("GET", "/api/v1/auth/me", { jar: admin.jar! })).json.user,
      );
      expect(
        (await req("PATCH", `/api/v1/operators/${me.id}`, { jar: admin.jar!, body: { role: "viewer" } })).status,
      ).toBe(409);
      expect((await req("DELETE", `/api/v1/operators/${me.id}`, { jar: admin.jar! })).status).toBe(409);
      expect(await roleOf(admin.jar!)).toBe("admin");
    },
    TEST_TIMEOUT,
  );

  test(
    "deleting an operator revokes its sessions immediately",
    async () => {
      const jar = await signIn(VIEWER_EMAIL, VIEWER_PASSWORD);
      expect((await req("GET", "/api/v1/state", { jar })).status).toBe(200);

      const del = await req("DELETE", `/api/v1/operators/${viewer.id}`, { jar: admin.jar! });
      expect(del.status).toBe(200);

      expect((await req("GET", "/api/v1/state", { jar })).status).toBe(401);
      // And the account is really gone — the same credentials no longer sign in.
      const relogin = await req("POST", "/api/v1/auth/login", {
        body: { email: VIEWER_EMAIL, password: VIEWER_PASSWORD },
      });
      expect(relogin.status).toBe(401);
    },
    TEST_TIMEOUT,
  );
});
