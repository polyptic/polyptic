/**
 * The ROLE POLICY (POL-107, scoped per mural by POL-191) — one table that says who may call what.
 *
 * THE RULE: enforcement is server-side, on every `/api/v1/**` route, in ONE place (the gate in
 * index.ts calls {@link requirementFor} → {@link roleAllows}). The console hides affordances a role
 * would 403 on, but that is cosmetics; this table is the permission system.
 *
 *   - **Deny by default.** A route that is not in {@link ROUTE_POLICY} requires `admin`. A new route
 *     added tomorrow is therefore admin-only until someone deliberately widens it — the safe failure.
 *   - **Roles are ranked** (`viewer < operator < admin`) and each contains the one below it, so the
 *     table only ever names the MINIMUM role for a route.
 *   - The table is keyed exactly like POL-102's `TOKEN_ROUTES` (method + a regex on the path relative
 *     to `/api/v1`) on purpose: a session carries a ROLE, a token carries SCOPES, and both resolve
 *     against a per-route table. They compose by intersection — a token's scope can never grant more
 *     than the role of the operator who minted it, and neither table can be widened by the other.
 *
 * ── POL-191: the SCOPE column ───────────────────────────────────────────────────────────────────
 *
 * Every entry now also says WHERE its role is measured. Before POL-191 there was one answer — the
 * deployment — and it stayed implicit. Now a route can be measured against a single mural, and the
 * caller's role there is their global role RAISED by any grant they hold on it (see `grants.ts`; the
 * raise is one-way, so this table's meaning is unchanged for a deployment with no grants).
 *
 *   - `global`    — measured across the deployment, exactly as before. Fleet + secrets verbs.
 *   - `mural`     — measured on ONE mural, named by the request: directly in the path (`/murals/:id`),
 *                   indirectly through a wall / screen / scene that sits on one, or in the body for
 *                   the two routes whose whole job is to say which mural something belongs to.
 *   - `any-mural` — measured on the caller's BEST mural: "you own at least one wall somewhere."
 *                   Reserved for the fleet-wide things a mural owner cannot do without — the content
 *                   library, media upload, saving a scene. Without it, "manage the content on your
 *                   mural" is not actually achievable: you could point a screen at a source but never
 *                   create one.
 *
 * A `mural`-scoped route whose mural CANNOT be resolved (an unplaced screen, an unknown wall, a body
 * with no muralId) falls back to the GLOBAL role. That is the conservative direction: a grant only
 * ever widens, so failing to find the mural can refuse someone but never admit them.
 */
import type { OperatorRole } from "@polyptic/protocol";

/** Rank: a role may do anything at or below its own rank. */
const RANK: Record<OperatorRole, number> = { viewer: 0, operator: 1, admin: 2 };

/** Does `have` satisfy `need`? (viewer < operator < admin) */
export function roleAllows(have: OperatorRole, need: OperatorRole): boolean {
  return RANK[have] >= RANK[need];
}

/** How a `mural`-scoped route names its mural: the kind of id captured from the path, or the body. */
export type MuralVia = "mural" | "wall" | "screen" | "scene" | "body";

/**
 * WHERE a route's role is measured.
 *
 * The gate resolves a wall/screen/scene id to the mural it sits on through the control plane. `body`
 * means the mural id is in the request body, which the gate can read because a Fastify `preHandler`
 * runs AFTER body parsing.
 */
export type RouteScope =
  | { kind: "global" }
  | { kind: "any-mural" }
  | { kind: "mural"; via: MuralVia };

const GLOBAL: RouteScope = { kind: "global" };
const ANY_MURAL: RouteScope = { kind: "any-mural" };
const VIA = (via: MuralVia): RouteScope => ({ kind: "mural", via });

interface RoutePolicy {
  method: string;
  /** Matched against the path RELATIVE to `/api/v1` (e.g. `/scenes/abc/apply`). A path-scoped entry
   *  CAPTURES the id it is scoped by, in group 1. */
  pattern: RegExp;
  /** The MINIMUM role that may call it. Absent from the table ⇒ admin (deny by default). */
  role: OperatorRole;
  /** Where that role is measured. Omitted ⇒ `global`, so an entry that says nothing about scope means
   *  exactly what it meant before POL-191. */
  scope?: RouteScope;
}

/** One path segment (an id): anything but a slash. `:seg` matches one, `:id` also CAPTURES it. */
const SEG = "[^/]+";
const seg = (path: string): RegExp =>
  new RegExp(`^${path.replace(/:id/g, `(${SEG})`).replace(/:seg/g, SEG)}$`);

/**
 * THE TABLE. Everything absent from it requires `admin` GLOBALLY — including `/settings/**` (enrolment
 * token, image builds, HTTPS, display settings), `/machines/**` mutations (approve, reject, reboot,
 * remove, shell), `/screens/:id/devtools/**` + `/inspect` (a live remote-debugger tunnel into a wall),
 * `/credential-profiles` mutations (they hold content secrets) and `/operators/**` itself. None of
 * those is a mural-shaped verb: a grant on a canvas must never reach the fleet or its secrets.
 */
export const ROUTE_POLICY: RoutePolicy[] = [
  // ── viewer: the self-service auth routes (login/logout/me are public and never reach here) ───
  // Every account, whatever its role, may rotate ITS OWN password. The handler still verifies the
  // current one, and it can only ever target `request.authUser.id` — there is no id parameter.
  { method: "POST", pattern: seg("/auth/change-password"), role: "viewer" },

  // ── viewer: read the registry ────────────────────────────────────────────────
  { method: "GET", pattern: seg("/state"), role: "viewer" },
  { method: "GET", pattern: seg("/screens"), role: "viewer" },
  { method: "GET", pattern: seg("/machines"), role: "viewer" },
  { method: "GET", pattern: seg("/murals"), role: "viewer" },
  { method: "GET", pattern: seg("/walls"), role: "viewer" },
  { method: "GET", pattern: seg("/scenes"), role: "viewer" },
  { method: "GET", pattern: seg("/content-sources"), role: "viewer" },
  // Views only — the profile's secret is never in the payload (POL-24). A viewer sees which profile a
  // source uses; it cannot create, edit, test or delete one (those fall through to admin).
  { method: "GET", pattern: seg("/credential-profiles"), role: "viewer" },
  { method: "GET", pattern: seg("/screens/:seg/thumbnail"), role: "viewer" },
  // ── viewer: INVOKE a saved scene — the "staff invoke" half of the split ───────
  { method: "POST", pattern: seg("/scenes/:seg/apply"), role: "viewer" },

  // ── operator: the content library + media — fleet-wide surfaces a mural owner needs ──
  // `any-mural`: holding operator on ANY mural is enough to add to the shared library. See RouteScope.
  { method: "POST", pattern: seg("/content-sources"), role: "operator", scope: ANY_MURAL },
  { method: "PATCH", pattern: seg("/content-sources/:seg"), role: "operator", scope: ANY_MURAL },
  { method: "DELETE", pattern: seg("/content-sources/:seg"), role: "operator", scope: ANY_MURAL },
  { method: "POST", pattern: seg("/media"), role: "operator", scope: ANY_MURAL },
  { method: "POST", pattern: seg("/demo/web"), role: "operator", scope: ANY_MURAL },

  // ── operator: murals themselves ──────────────────────────────────────────────
  // Creating a mural stays a GLOBAL operator verb — there is no mural yet to hold a grant on. Whoever
  // creates one is granted `admin` ON it (see GrantService.grantOwner), so a team can then staff its
  // own wall without coming back to a fleet admin for every change.
  { method: "POST", pattern: seg("/murals"), role: "operator" },
  { method: "POST", pattern: seg("/murals/:id/rename"), role: "operator", scope: VIA("mural") },
  // DELETE is the destructive one, so it asks for admin ON THAT MURAL rather than operator.
  { method: "DELETE", pattern: seg("/murals/:id"), role: "admin", scope: VIA("mural") },
  { method: "POST", pattern: seg("/murals/:id/walls"), role: "operator", scope: VIA("mural") },

  // ── POL-191: who holds what on a mural. Reading the list is an operator verb there; changing it is
  // an admin one — handing out permission is itself the most powerful thing you can do on a wall.
  { method: "GET", pattern: seg("/murals/:id/grants"), role: "operator", scope: VIA("mural") },
  { method: "PUT", pattern: seg("/murals/:id/grants"), role: "admin", scope: VIA("mural") },
  {
    method: "DELETE",
    pattern: seg("/murals/:id/grants/:seg/:seg"),
    role: "admin",
    scope: VIA("mural"),
  },

  // ── operator: walls (combined surfaces) — scoped by the mural the wall sits on ──
  { method: "POST", pattern: seg("/walls/:id/rename"), role: "operator", scope: VIA("wall") },
  { method: "DELETE", pattern: seg("/walls/:id"), role: "operator", scope: VIA("wall") },
  { method: "PUT", pattern: seg("/walls/:id/content"), role: "operator", scope: VIA("wall") },
  { method: "PUT", pattern: seg("/walls/:id/zoom"), role: "operator", scope: VIA("wall") },
  { method: "POST", pattern: seg("/walls/:id/ident"), role: "operator", scope: VIA("wall") },

  // ── operator: screens — scoped by the mural the screen is PLACED on ───────────
  // An UNPLACED screen resolves to no mural and therefore falls back to the global role. That is the
  // honest answer: a screen in the tray belongs to nobody's canvas yet.
  { method: "PUT", pattern: seg("/screens/:id/content"), role: "operator", scope: VIA("screen") },
  { method: "PUT", pattern: seg("/screens/:id/zoom"), role: "operator", scope: VIA("screen") },
  // Placement is the exception that reads the BODY: the request's whole purpose is to name the mural
  // a screen is moving ONTO, and the screen's current mural (often none) is the wrong thing to ask.
  { method: "PUT", pattern: seg("/screens/:seg/placement"), role: "operator", scope: VIA("body") },
  { method: "DELETE", pattern: seg("/screens/:id/placement"), role: "operator", scope: VIA("screen") },
  { method: "POST", pattern: seg("/screens/:id/rename"), role: "operator", scope: VIA("screen") },
  { method: "POST", pattern: seg("/screens/:id/surfaces"), role: "operator", scope: VIA("screen") },
  { method: "POST", pattern: seg("/screens/:id/cast"), role: "operator", scope: VIA("screen") },
  { method: "POST", pattern: seg("/screens/:id/capture"), role: "operator", scope: VIA("screen") },
  // Ident is "make that panel flash so I can find it" — a wall-fitting verb, not a fleet one. (The
  // wall half of it sits with the other wall routes above.)
  { method: "POST", pattern: seg("/screens/:id/ident"), role: "operator", scope: VIA("screen") },
  // A machine is plumbing, not a canvas: identifying one stays a GLOBAL operator verb.
  { method: "POST", pattern: seg("/machines/:seg/ident"), role: "operator" },

  // ── operator: scenes — a scene belongs to exactly one mural, so it scopes to that one ──
  // Creating one carries its mural in the body (a scene snapshots a named mural).
  { method: "POST", pattern: seg("/scenes"), role: "operator", scope: VIA("body") },
  { method: "PATCH", pattern: seg("/scenes/:id"), role: "operator", scope: VIA("scene") },
  { method: "DELETE", pattern: seg("/scenes/:id"), role: "operator", scope: VIA("scene") },
];

/** What a request must satisfy: a minimum role, and where that role is measured. */
export interface RouteRequirement {
  role: OperatorRole;
  scope: RouteScope;
  /** The id captured from the path for a path-scoped `mural` route (`via` says what kind of id it is).
   *  Absent for the `body`, `any-mural` and `global` scopes. */
  id?: string;
}

/**
 * The requirement for a request. `path` is the FULL, slash-collapsed path (`/api/v1/...`); anything
 * outside `/api/v1/` returns null (not our surface — the device channels, the depot and /metrics have
 * their own gates, or none by design). Inside `/api/v1/`, an unmatched route is `admin`, globally.
 */
export function requirementFor(method: string, path: string): RouteRequirement | null {
  if (!path.startsWith("/api/v1/")) return null;
  const rel = path.slice("/api/v1".length); // keeps the leading slash
  const m = method.toUpperCase();
  for (const route of ROUTE_POLICY) {
    if (route.method !== m) continue;
    const match = route.pattern.exec(rel);
    if (!match) continue;
    const scope = route.scope ?? GLOBAL;
    const id = scope.kind === "mural" && scope.via !== "body" ? match[1] : undefined;
    return { role: route.role, scope, id };
  }
  return { role: "admin", scope: GLOBAL };
}

/**
 * The minimum GLOBAL role for a request, ignoring any mural scope.
 *
 * Kept for the callers that have no mural context to offer and never will — the /admin WS upgrade
 * check, and anything that wants the pre-POL-191 answer. A mural-scoped route reports its role here
 * too, which is exactly the fallback the gate uses when a mural cannot be resolved.
 */
export function requiredRoleFor(method: string, path: string): OperatorRole | null {
  return requirementFor(method, path)?.role ?? null;
}
