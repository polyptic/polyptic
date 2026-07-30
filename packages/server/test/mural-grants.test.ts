/**
 * POL-191 — MURAL GRANTS: the access-control model.
 *
 * Two axes that compose: the FLEET role (`operator`/`admin`) says whether you have deployment-wide
 * access; GRANTS say which individual murals you have access to, and how deeply. There is no mode and
 * no switch — access is what decides sight, always.
 *
 * What this file pins, and most of it is the negatives:
 *
 *   1. A `viewer` has NOTHING it was not given. No implicit floor, on any mural, ever.
 *   2. A grant is confined to ITS mural. Holding operator on the Atrium gives you nothing on the Foyer.
 *   3. A FLEET role reaches every mural — sight and power both — because it is deployment-wide by
 *      construction, and hiding a wall from someone who can still reconfigure it is the worse lie.
 *   4. A grant never reaches the FLEET. No arrangement of grants makes a machine, a setting, a
 *      credential profile or another account reachable.
 *   5. Group grants resolve through the claim the IdP asserted, with no account to pre-create.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AuthService, authConfigFromEnv } from "../src/auth-local";
import { GrantService } from "../src/grants";
import type { GrantSubject } from "../src/grants";
import { requirementFor } from "../src/roles";
import { MemoryStore } from "../src/store/memory";

const ATRIUM = "mural_atrium";
const FOYER = "mural_foyer";

/** A signed-in identity as the gate sees it. */
function subject(role: GrantSubject["role"], groups: string[] = [], id = "user_alex"): GrantSubject {
  return { id, role, groups };
}

describe("effectiveRole — you hold what you were given, and only on the mural it names", () => {
  let store: MemoryStore;
  let grants: GrantService;

  beforeEach(async () => {
    store = new MemoryStore();
    grants = new GrantService(store);
    await grants.load();
  });

  test("with NO grants a viewer holds NOTHING — the fleet roles still hold everything", async () => {
    expect(grants.effectiveRole(subject("viewer"), ATRIUM)).toBeNull();
    expect(grants.effectiveRole(subject("operator"), ATRIUM)).toBe("operator");
    expect(grants.effectiveRole(subject("admin"), ATRIUM)).toBe("admin");
  });

  test("a viewer granted operator on the Atrium can drive the Atrium — and nothing on the Foyer", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "operator");
    expect(grants.effectiveRole(subject("viewer"), ATRIUM)).toBe("operator");
    expect(grants.effectiveRole(subject("viewer"), FOYER)).toBeNull();
  });

  test("a grant never LOWERS a fleet role: an admin with a viewer grant is still an admin there", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "viewer");
    expect(grants.effectiveRole(subject("admin"), ATRIUM)).toBe("admin");
  });

  test("the BEST of several matching grants wins — a user grant and a group grant compose upward", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "viewer");
    await grants.put(ATRIUM, "group", "wall-team", "admin");
    expect(grants.effectiveRole(subject("viewer", ["wall-team"]), ATRIUM)).toBe("admin");
  });

  test("a grant belongs to a SUBJECT, not to everyone who happens to be signed in", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "admin");
    expect(grants.effectiveRole(subject("viewer", [], "user_sam"), ATRIUM)).toBeNull();
  });

  test("re-levelling replaces, it does not accumulate — a demote actually demotes", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "admin");
    await grants.put(ATRIUM, "user", "user_alex", "viewer");
    expect(grants.listForMural(ATRIUM)).toHaveLength(1);
    expect(grants.effectiveRole(subject("viewer"), ATRIUM)).toBe("viewer");
  });

  test("a revoked grant stops applying immediately — no session or cache outlives it", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "operator");
    expect(grants.effectiveRole(subject("viewer"), ATRIUM)).toBe("operator");
    expect(await grants.remove(ATRIUM, "user", "user_alex")).toBe(true);
    expect(grants.effectiveRole(subject("viewer"), ATRIUM)).toBeNull();
  });

  test("deleting the mural takes its grants with it — a recycled id inherits nothing", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "admin");
    await grants.put(FOYER, "user", "user_alex", "admin");
    await grants.removeForMural(ATRIUM);
    expect(grants.effectiveRole(subject("viewer"), ATRIUM)).toBeNull();
    // …and only that mural's.
    expect(grants.effectiveRole(subject("viewer"), FOYER)).toBe("admin");
  });

  test("the index survives a restart — it is a cache over the store, not a second source of truth", async () => {
    await grants.put(ATRIUM, "group", "wall-team", "operator");
    const reloaded = new GrantService(store);
    await reloaded.load();
    expect(reloaded.effectiveRole(subject("viewer", ["wall-team"]), ATRIUM)).toBe("operator");
  });
});

describe("group grants — the seam between Polyptic and the directory", () => {
  let grants: GrantService;

  beforeEach(async () => {
    grants = new GrantService(new MemoryStore());
    await grants.load();
    await grants.put(ATRIUM, "group", "Wall-Team", "operator");
  });

  test("a group grant applies to whoever the IdP says is in it, with no account created here", () => {
    expect(grants.effectiveRole(subject("viewer", ["wall-team"], "user_never_seen"), ATRIUM)).toBe(
      "operator",
    );
  });

  test("group names match case-insensitively — a directory's casing must not decide permission", () => {
    expect(grants.effectiveRole(subject("viewer", ["WALL-TEAM"]), ATRIUM)).toBe("operator");
    expect(grants.effectiveRole(subject("viewer", ["Wall-Team"]), ATRIUM)).toBe("operator");
  });

  test("someone in no matching group gets nothing from it", () => {
    expect(grants.effectiveRole(subject("viewer", ["other-team"]), ATRIUM)).toBeNull();
    expect(grants.effectiveRole(subject("viewer", []), ATRIUM)).toBeNull();
  });

  test("a user grant is NOT matched by a group of the same name (the kinds are separate namespaces)", async () => {
    await grants.put(FOYER, "user", "wall-team", "admin");
    expect(grants.effectiveRole(subject("viewer", ["wall-team"], "user_alex"), FOYER)).toBeNull();
  });
});

describe("bestRoleAnywhere — the shared content library", () => {
  let grants: GrantService;

  beforeEach(async () => {
    grants = new GrantService(new MemoryStore());
    await grants.load();
  });

  test("a mural owner may add to the library — otherwise 'manage your mural' is not achievable", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "operator");
    expect(grants.bestRoleAnywhere(subject("viewer"))).toBe("operator");
  });

  test("…and someone who owns NO mural is still just their global role", () => {
    expect(grants.bestRoleAnywhere(subject("viewer"))).toBe("viewer");
  });

  test("a group grant counts for it too", async () => {
    await grants.put(ATRIUM, "group", "wall-team", "operator");
    expect(grants.bestRoleAnywhere(subject("viewer", ["wall-team"]))).toBe("operator");
  });
});

describe("the route table — what a mural grant can and cannot reach", () => {
  test("wall / screen / scene routes are measured on the mural they sit on", () => {
    expect(requirementFor("PUT", "/api/v1/screens/scr_1/content")).toMatchObject({
      role: "operator",
      scope: { kind: "mural", via: "screen" },
      id: "scr_1",
    });
    expect(requirementFor("PUT", "/api/v1/walls/wall_1/content")).toMatchObject({
      scope: { kind: "mural", via: "wall" },
      id: "wall_1",
    });
    expect(requirementFor("DELETE", "/api/v1/scenes/scene_1")).toMatchObject({
      scope: { kind: "mural", via: "scene" },
      id: "scene_1",
    });
  });

  test("the two routes that NAME a mural in their body are scoped by the body", () => {
    // Placing a screen is a move ONTO a mural — its current mural (often none) is the wrong question.
    expect(requirementFor("PUT", "/api/v1/screens/scr_1/placement")).toMatchObject({
      role: "operator",
      scope: { kind: "mural", via: "body" },
    });
    expect(requirementFor("POST", "/api/v1/scenes")).toMatchObject({
      scope: { kind: "mural", via: "body" },
    });
  });

  test("handing OUT permission on a mural takes admin ON that mural; reading the list takes operator", () => {
    expect(requirementFor("GET", "/api/v1/murals/m1/grants")).toMatchObject({
      role: "operator",
      scope: { kind: "mural", via: "mural" },
      id: "m1",
    });
    expect(requirementFor("PUT", "/api/v1/murals/m1/grants")).toMatchObject({ role: "admin", id: "m1" });
    expect(requirementFor("DELETE", "/api/v1/murals/m1/grants/user/user_alex")).toMatchObject({
      role: "admin",
      id: "m1",
    });
  });

  test("deleting a mural is the destructive one — admin ON it, not operator", () => {
    expect(requirementFor("DELETE", "/api/v1/murals/m1")).toMatchObject({
      role: "admin",
      scope: { kind: "mural", via: "mural" },
    });
  });

  test("THE FENCE: no mural grant reaches the fleet, the settings or another account", () => {
    // All measured GLOBALLY, all admin — a grant on a canvas is not a foothold in the deployment.
    for (const [method, path] of [
      ["POST", "/api/v1/machines/m1/approve"],
      ["POST", "/api/v1/machines/m1/reboot"],
      ["DELETE", "/api/v1/machines/m1"],
      ["POST", "/api/v1/machines/m1/shell/arm"],
      ["GET", "/api/v1/settings/enrollment"],
      ["POST", "/api/v1/settings/display"],
      ["POST", "/api/v1/credential-profiles"],
      ["GET", "/api/v1/operators"],
      ["POST", "/api/v1/operators"],
      ["PATCH", "/api/v1/operators/user_alex"],
      ["DELETE", "/api/v1/operators/user_alex"],
      ["POST", "/api/v1/screens/scr_1/inspect"],
    ] as const) {
      expect(requirementFor(method, path)).toMatchObject({ role: "admin", scope: { kind: "global" } });
    }
  });

  test("creating a mural stays a GLOBAL operator verb — there is no mural yet to hold a grant on", () => {
    expect(requirementFor("POST", "/api/v1/murals")).toMatchObject({
      role: "operator",
      scope: { kind: "global" },
    });
  });

  test("identifying a MACHINE stays global — a machine is plumbing, not a canvas", () => {
    expect(requirementFor("POST", "/api/v1/machines/m1/ident")).toMatchObject({
      scope: { kind: "global" },
    });
  });

  test("deny-by-default still holds: an unlisted route is admin, globally", () => {
    expect(requirementFor("POST", "/api/v1/something/nobody/listed")).toMatchObject({
      role: "admin",
      scope: { kind: "global" },
    });
  });
});

/**
 * THE GATE, end to end — the same `requireAuth` every `/api/v1/**` request goes through.
 *
 * The tests above pin the two halves separately (what the table asks for, what a subject holds). This
 * pins them TOGETHER, through the real code path, because the composition is where a permission
 * system actually fails: the right table and the right grants, wired up wrong, still 403s the person
 * who should get in — or worse, admits the one who should not.
 */
describe("requireAuth — a grant carries a request through, and only the right one", () => {
  const log = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return log;
    },
  } as unknown as FastifyBaseLogger;

  let store: MemoryStore;
  let auth: AuthService;
  let grants: GrantService;

  /** A screen on the Atrium, a wall on the Foyer, and one screen in the tray on no mural at all. */
  const MURAL_OF = new Map<string, string>([
    ["mural:mural_atrium", ATRIUM],
    ["screen:scr_atrium", ATRIUM],
    ["wall:wall_foyer", FOYER],
    ["mural:mural_foyer", FOYER],
  ]);

  beforeEach(async () => {
    store = new MemoryStore();
    auth = new AuthService({
      store,
      fastify: {} as unknown as FastifyInstance,
      config: authConfigFromEnv({ AUTH_ENABLED: "true" }),
      log,
    });
    grants = new GrantService(store);
    await grants.load();
    auth.useGrants(grants, (via, id) => MURAL_OF.get(`${via}:${id}`) ?? null);
  });

  /** Drive the gate with a signed-in identity and return the status it would have replied, or null
   *  when it let the request through to its handler. */
  async function attempt(
    user: { id: string; role: GrantSubject["role"]; groups?: string[] },
    method: string,
    path: string,
    body?: unknown,
  ): Promise<number | null> {
    let status: number | null = null;
    const request = {
      method,
      url: path,
      body,
      // The gate resolves the session itself; short-circuit that by handing it the identity.
      cookies: {},
    } as unknown as FastifyRequest;
    // `verifyRequest` is what reads the cookie — stub it so this test is about AUTHORIZATION only.
    (auth as unknown as { verifyRequest: () => Promise<unknown> }).verifyRequest = async () => ({
      id: user.id,
      email: `${user.id}@polyptic.test`,
      role: user.role,
      provider: "local" as const,
      displayName: null,
      groups: user.groups ?? [],
    });
    const reply = {
      code(value: number) {
        status = value;
        return this;
      },
      async send() {
        return undefined;
      },
    } as unknown as FastifyReply;

    await auth.requireAuth(request, reply, path);
    return status;
  }

  const ALEX = { id: "user_alex", role: "viewer" as const };

  test("a viewer is refused the content verb on a mural nobody gave them", async () => {
    expect(await attempt(ALEX, "PUT", "/api/v1/screens/scr_atrium/content")).toBe(403);
  });

  test("…and the SAME request goes through once they hold operator on that mural", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "operator");
    expect(await attempt(ALEX, "PUT", "/api/v1/screens/scr_atrium/content")).toBeNull();
  });

  test("the grant does not travel: the Foyer wall is still refused", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "operator");
    expect(await attempt(ALEX, "PUT", "/api/v1/walls/wall_foyer/content")).toBe(403);
  });

  test("a GROUP grant carries someone who has no grant of their own", async () => {
    await grants.put(ATRIUM, "group", "wall-team", "operator");
    expect(await attempt({ ...ALEX, groups: ["wall-team"] }, "PUT", "/api/v1/screens/scr_atrium/content")).toBeNull();
    // …and nobody else.
    expect(await attempt(ALEX, "PUT", "/api/v1/screens/scr_atrium/content")).toBe(403);
  });

  test("a BODY-scoped route reads the mural out of the request body", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "operator");
    expect(
      await attempt(ALEX, "PUT", "/api/v1/screens/scr_tray/placement", { muralId: ATRIUM, x: 0, y: 0 }),
    ).toBeNull();
    // Placing onto a mural they do NOT hold is refused, even though the screen is the same one.
    expect(
      await attempt(ALEX, "PUT", "/api/v1/screens/scr_tray/placement", { muralId: FOYER, x: 0, y: 0 }),
    ).toBe(403);
  });

  test("an unresolvable mural gives a non-fleet account NOTHING — the tray is fleet plumbing", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "admin");
    // A screen on no mural belongs to nobody's canvas, so an admin-on-one-mural still gets nothing…
    expect(await attempt(ALEX, "PUT", "/api/v1/screens/scr_tray/content")).toBe(403);
    // …and a body with no muralId at all cannot be used to reach a grant either.
    expect(await attempt(ALEX, "PUT", "/api/v1/screens/scr_tray/placement", {})).toBe(403);
  });

  test("THE FENCE, live: every grant in the deployment does not open one fleet route", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "admin");
    await grants.put(FOYER, "user", "user_alex", "admin");
    expect(await attempt(ALEX, "POST", "/api/v1/machines/box1/reboot")).toBe(403);
    expect(await attempt(ALEX, "GET", "/api/v1/settings/enrollment")).toBe(403);
    expect(await attempt(ALEX, "POST", "/api/v1/operators")).toBe(403);
    expect(await attempt(ALEX, "POST", "/api/v1/credential-profiles")).toBe(403);
  });

  test("handing out access needs ADMIN on that mural — operator there is not enough", async () => {
    await grants.put(ATRIUM, "user", "user_alex", "operator");
    expect(await attempt(ALEX, "GET", "/api/v1/murals/mural_atrium/grants")).toBeNull();
    expect(await attempt(ALEX, "PUT", "/api/v1/murals/mural_atrium/grants")).toBe(403);

    await grants.put(ATRIUM, "user", "user_alex", "admin");
    expect(await attempt(ALEX, "PUT", "/api/v1/murals/mural_atrium/grants")).toBeNull();
    // Still nothing on the mural next door.
    expect(await attempt(ALEX, "PUT", "/api/v1/murals/mural_foyer/grants")).toBe(403);
  });

  test("a mural owner may add to the SHARED content library (the any-mural seam)", async () => {
    expect(await attempt(ALEX, "POST", "/api/v1/content-sources")).toBe(403);
    await grants.put(ATRIUM, "user", "user_alex", "operator");
    expect(await attempt(ALEX, "POST", "/api/v1/content-sources")).toBeNull();
  });

  test("a global ADMIN is untouched by all of this — no grant, every door", async () => {
    const boss = { id: "user_boss", role: "admin" as const };
    expect(await attempt(boss, "PUT", "/api/v1/screens/scr_atrium/content")).toBeNull();
    expect(await attempt(boss, "POST", "/api/v1/machines/box1/reboot")).toBeNull();
    expect(await attempt(boss, "PUT", "/api/v1/murals/mural_foyer/grants")).toBeNull();
  });

  test("a fleet OPERATOR keeps exactly what POL-107 gave it, grants or no grants", async () => {
    const op = { id: "user_op", role: "operator" as const };
    expect(await attempt(op, "PUT", "/api/v1/screens/scr_atrium/content")).toBeNull();
    expect(await attempt(op, "PUT", "/api/v1/screens/scr_tray/content")).toBeNull();
    expect(await attempt(op, "POST", "/api/v1/machines/box1/reboot")).toBe(403);
  });
});

/**
 * POL-191/D175 — VISIBILITY follows ACCESS, and there is no mode to turn on.
 *
 * The one property that carries the whole feature: sight and power narrow TOGETHER. A viewer who
 * could still apply a scene, read a thumbnail, or reach a wall through a REST list would be
 * "access-controlled" in name only — so the floor that used to give every account `viewer`
 * everywhere is gone from the model itself, not merely filtered out of the broadcast.
 */
describe("visibility follows access — a viewer holds only what they were handed", () => {
  let grants: GrantService;

  beforeEach(async () => {
    grants = new GrantService(new MemoryStore());
    await grants.load();
    await grants.put(ATRIUM, "user", "user_alex", "operator");
  });

  test("no implicit floor: a viewer holds NOTHING on a mural nobody gave them", () => {
    expect(grants.effectiveRole(subject("viewer"), FOYER)).toBeNull();
  });

  test("…and exactly what they were given on the one they hold", () => {
    expect(grants.effectiveRole(subject("viewer"), ATRIUM)).toBe("operator");
  });

  test("a grant is still not lowered by the global role, nor raised past what it says", async () => {
    await grants.put(FOYER, "user", "user_alex", "viewer");
    expect(grants.effectiveRole(subject("viewer"), FOYER)).toBe("viewer");
  });

  test("FLEET ROLES ARE UNCHANGED — an operator and an admin keep every mural", () => {
    expect(grants.effectiveRole(subject("operator"), FOYER)).toBe("operator");
    expect(grants.effectiveRole(subject("admin"), FOYER)).toBe("admin");
    expect(grants.visibleMuralIds(subject("operator"))).toBe("all");
    expect(grants.visibleMuralIds(subject("admin"))).toBe("all");
  });

  test("visibleMuralIds is exactly the granted set, by user and by group", async () => {
    await grants.put(FOYER, "group", "wall-team", "viewer");
    expect(grants.visibleMuralIds(subject("viewer"))).toEqual(new Set([ATRIUM]));
    expect(grants.visibleMuralIds(subject("viewer", ["wall-team"]))).toEqual(
      new Set([ATRIUM, FOYER]),
    );
    expect(grants.visibleMuralIds(subject("viewer", [], "user_nobody"))).toEqual(new Set());
  });

  test("a thing on NO mural (the tray) is fleet plumbing — a scoped viewer holds nothing on it", () => {
    expect(grants.unscopedFallbackRole(subject("viewer"))).toBeNull();
    // …and a fleet role still falls back to its own global role, as it always did.
    expect(grants.unscopedFallbackRole(subject("operator"))).toBe("operator");
  });

  test("THERE IS NO OPT-OUT: a fresh service, default-constructed, already withholds", async () => {
    const fresh = new GrantService(new MemoryStore());
    await fresh.load();
    expect(fresh.effectiveRole(subject("viewer"), ATRIUM)).toBeNull();
    expect(fresh.visibleMuralIds(subject("viewer"))).toEqual(new Set());
    expect(fresh.unscopedFallbackRole(subject("viewer"))).toBeNull();
  });
});

describe("through the gate — sight and power narrow together", () => {
  const log = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return log;
    },
  } as unknown as FastifyBaseLogger;

  const MURAL_OF = new Map<string, string>([
    ["mural:mural_atrium", ATRIUM],
    ["mural:mural_foyer", FOYER],
    ["screen:scr_atrium", ATRIUM],
    ["screen:scr_foyer", FOYER],
    ["scene:scene_atrium", ATRIUM],
    ["scene:scene_foyer", FOYER],
  ]);

  let auth: AuthService;
  let grants: GrantService;

  beforeEach(async () => {
    const store = new MemoryStore();
    auth = new AuthService({
      store,
      fastify: {} as unknown as FastifyInstance,
      config: authConfigFromEnv({ AUTH_ENABLED: "true" }),
      log,
    });
    grants = new GrantService(store);
    await grants.load();
    await grants.put(ATRIUM, "user", "user_alex", "operator");
    auth.useGrants(grants, (via, id) => MURAL_OF.get(`${via}:${id}`) ?? null);
  });

  async function attempt(
    user: { id: string; role: "viewer" | "operator" | "admin"; groups?: string[] },
    method: string,
    path: string,
  ): Promise<number | null> {
    let status: number | null = null;
    (auth as unknown as { verifyRequest: () => Promise<unknown> }).verifyRequest = async () => ({
      id: user.id,
      email: `${user.id}@polyptic.test`,
      role: user.role,
      provider: "local" as const,
      displayName: null,
      groups: user.groups ?? [],
    });
    const request = { method, url: path, cookies: {} } as unknown as FastifyRequest;
    const reply = {
      code(value: number) {
        status = value;
        return this;
      },
      async send() {
        return undefined;
      },
    } as unknown as FastifyReply;
    await auth.requireAuth(request, reply, path);
    return status;
  }

  const ALEX = { id: "user_alex", role: "viewer" as const };

  test("APPLYING A SCENE is refused on a mural they were not given", async () => {
    // The hole this closes: scene-apply was viewer-level and GLOBAL, so a viewer could have
    // repainted any wall in the building while having no access to it.
    expect(await attempt(ALEX, "POST", "/api/v1/scenes/scene_foyer/apply")).toBe(403);
    expect(await attempt(ALEX, "POST", "/api/v1/scenes/scene_atrium/apply")).toBeNull();
  });

  test("A THUMBNAIL is refused too — a live picture of a wall you cannot see is the same leak", async () => {
    expect(await attempt(ALEX, "GET", "/api/v1/screens/scr_foyer/thumbnail")).toBe(403);
    expect(await attempt(ALEX, "GET", "/api/v1/screens/scr_atrium/thumbnail")).toBeNull();
  });

  test("an UNPLACED screen's thumbnail is refused: the tray is fleet plumbing", async () => {
    expect(await attempt(ALEX, "GET", "/api/v1/screens/scr_tray/thumbnail")).toBe(403);
  });

  test("the content verbs narrow the same way", async () => {
    expect(await attempt(ALEX, "PUT", "/api/v1/screens/scr_atrium/content")).toBeNull();
    expect(await attempt(ALEX, "PUT", "/api/v1/screens/scr_foyer/content")).toBe(403);
  });

  test("a fleet OPERATOR is unaffected — a fleet role is never narrowed", async () => {
    const op = { id: "user_op", role: "operator" as const };
    expect(await attempt(op, "POST", "/api/v1/scenes/scene_foyer/apply")).toBeNull();
    expect(await attempt(op, "GET", "/api/v1/screens/scr_foyer/thumbnail")).toBeNull();
    expect(await attempt(op, "GET", "/api/v1/screens/scr_tray/thumbnail")).toBeNull();
  });

  test("reading the fleet registry is still open to any signed-in account", async () => {
    // /state, /murals, /screens etc. stay reachable and are FILTERED rather than refused — a 403 on
    // the console's own bootstrap read would just be a broken app.
    expect(await attempt(ALEX, "GET", "/api/v1/state")).toBeNull();
    expect(await attempt(ALEX, "GET", "/api/v1/murals")).toBeNull();
    expect(await attempt(ALEX, "GET", "/api/v1/screens")).toBeNull();
  });
});
