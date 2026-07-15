/**
 * The ROLE POLICY (POL-107) — one table that says who may call what.
 *
 * THE RULE: enforcement is server-side, on every `/api/v1/**` route, in ONE place (the gate in
 * index.ts calls {@link requiredRoleFor} → {@link roleAllows}). The console hides affordances a role
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
 */
import type { OperatorRole } from "@polyptic/protocol";

/** Rank: a role may do anything at or below its own rank. */
const RANK: Record<OperatorRole, number> = { viewer: 0, operator: 1, admin: 2 };

/** Does `have` satisfy `need`? (viewer < operator < admin) */
export function roleAllows(have: OperatorRole, need: OperatorRole): boolean {
  return RANK[have] >= RANK[need];
}

interface RoutePolicy {
  method: string;
  /** Matched against the path RELATIVE to `/api/v1` (e.g. `/scenes/abc/apply`). */
  pattern: RegExp;
  /** The MINIMUM role that may call it. Absent from the table ⇒ admin (deny by default). */
  role: OperatorRole;
}

/** One path segment (an id): anything but a slash. */
const SEG = "[^/]+";
const seg = (path: string): RegExp => new RegExp(`^${path.replace(/:seg/g, SEG)}$`);

/**
 * THE TABLE. Everything absent from it requires `admin` — including `/settings/**` (enrolment token,
 * image builds, HTTPS, display settings), `/machines/**` mutations (approve, reject, reboot, remove,
 * shell), `/screens/:id/devtools/**` + `/inspect` (a live remote-debugger tunnel into a wall),
 * `/credential-profiles` mutations (they hold content secrets) and `/operators/**` itself.
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

  // ── operator: content + layout ───────────────────────────────────────────────
  { method: "POST", pattern: seg("/content-sources"), role: "operator" },
  { method: "PATCH", pattern: seg("/content-sources/:seg"), role: "operator" },
  { method: "DELETE", pattern: seg("/content-sources/:seg"), role: "operator" },
  { method: "POST", pattern: seg("/media"), role: "operator" },
  { method: "POST", pattern: seg("/scenes"), role: "operator" },
  { method: "PATCH", pattern: seg("/scenes/:seg"), role: "operator" },
  { method: "DELETE", pattern: seg("/scenes/:seg"), role: "operator" },
  { method: "POST", pattern: seg("/murals"), role: "operator" },
  { method: "POST", pattern: seg("/murals/:seg/rename"), role: "operator" },
  { method: "DELETE", pattern: seg("/murals/:seg"), role: "operator" },
  { method: "POST", pattern: seg("/murals/:seg/walls"), role: "operator" },
  { method: "POST", pattern: seg("/walls/:seg/rename"), role: "operator" },
  { method: "DELETE", pattern: seg("/walls/:seg"), role: "operator" },
  { method: "PUT", pattern: seg("/walls/:seg/content"), role: "operator" },
  { method: "PUT", pattern: seg("/walls/:seg/zoom"), role: "operator" },
  { method: "PUT", pattern: seg("/screens/:seg/content"), role: "operator" },
  { method: "PUT", pattern: seg("/screens/:seg/zoom"), role: "operator" },
  { method: "PUT", pattern: seg("/screens/:seg/placement"), role: "operator" },
  { method: "DELETE", pattern: seg("/screens/:seg/placement"), role: "operator" },
  { method: "POST", pattern: seg("/screens/:seg/rename"), role: "operator" },
  { method: "POST", pattern: seg("/screens/:seg/surfaces"), role: "operator" },
  { method: "POST", pattern: seg("/screens/:seg/cast"), role: "operator" },
  { method: "POST", pattern: seg("/screens/:seg/capture"), role: "operator" },
  { method: "POST", pattern: seg("/demo/web"), role: "operator" },
  // Ident is "make that panel flash so I can find it" — a wall-fitting verb, not a fleet one.
  { method: "POST", pattern: seg("/screens/:seg/ident"), role: "operator" },
  { method: "POST", pattern: seg("/walls/:seg/ident"), role: "operator" },
  { method: "POST", pattern: seg("/machines/:seg/ident"), role: "operator" },
];

/**
 * The minimum role for a request. `path` is the FULL, slash-collapsed path (`/api/v1/...`); anything
 * outside `/api/v1/` returns null (not our surface — the device channels, the depot and /metrics have
 * their own gates, or none by design). Inside `/api/v1/`, an unmatched route is `admin`.
 */
export function requiredRoleFor(method: string, path: string): OperatorRole | null {
  if (!path.startsWith("/api/v1/")) return null;
  const rel = path.slice("/api/v1".length); // keeps the leading slash
  const m = method.toUpperCase();
  for (const route of ROUTE_POLICY) {
    if (route.method === m && route.pattern.test(rel)) return route.role;
  }
  return "admin";
}
