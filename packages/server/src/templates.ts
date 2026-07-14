/**
 * POL-111 — per-screen template variables, substituted at SEND time.
 *
 * One source, fifty screens. A content source's URL / page text / ticker carries `{{placeholder}}`
 * tokens; the control plane resolves them against the RECEIVING screen's scope on the way out
 * (ControlPlane.decorateSliceForSend — the same seam POL-24 stamps credential tokens at). The rule
 * that seam establishes is absolute here too: **the DB and the stored slices always keep the CLEAN,
 * tokenised value.** Nothing substituted is ever persisted, so one source stays one source, a rename
 * re-resolves for free, and a screen that reconnects gets the current substitution, not a fossil.
 *
 * ── Security posture ────────────────────────────────────────────────────────────────────────────
 * A variable value is untrusted DATA that lands in two very different contexts, so it is defended
 * three times over:
 *
 *  1. At the edge (`ScreenVariableValue`, protocol): no control characters, no `{{`/`}}`.
 *  2. Single pass, always. `String.replace` with a *function* replacer scans the TEMPLATE only —
 *     the substituted text is never re-scanned, and `$&`-style patterns inside a value are not
 *     interpreted. A value containing `{{x}}` therefore stays literal: no recursive expansion, no
 *     billion-laughs, no way for one variable to reach another.
 *  3. Per context on the way in:
 *       • URL   — the value is percent-encoded (`encodeURIComponent`), so it cannot introduce a
 *                 scheme (`javascript:`), a new query parameter (`&admin=1`), a fragment, a path
 *                 traversal, a credential (`user:pw@`), or a quote that escapes an HTML attribute.
 *                 The result is then re-parsed and must still be an http(s) URL, or we fall back
 *                 (empty substitution, then the clean template) rather than emit something exotic.
 *       • TEXT  — page text/ticker/countdown labels are rendered by the player as TEXT NODES (Vue
 *                 interpolation; there is no `v-html` anywhere in `@polyptic/elements` or the
 *                 player), so `<script>` is displayed, not executed. We escape nothing and mangle
 *                 nothing — an operator who wants a `<` on the glass gets a `<`.
 *
 * Undefined placeholders resolve to EMPTY (never literal braces — POL-111 DoD). `unresolvedIn()`
 * feeds the console's warning badge so the operator sees the typo they'd otherwise never notice.
 */

import type { Machine, Screen } from "@polyptic/protocol";

/** A resolved variable scope for ONE screen: built-ins + that screen's own custom variables. */
export type VariableScope = Readonly<Record<string, string>>;

/** `{{ name }}` — dots allowed (built-in namespaces), whitespace tolerated, bounded length. */
const TOKEN = /\{\{\s*([A-Za-z][A-Za-z0-9_.-]{0,63})\s*\}\}/g;

/** Cheap pre-check: no `{{` means there is nothing to do (the hot path — most URLs are plain). */
function hasToken(template: string): boolean {
  return template.includes("{{");
}

/**
 * The scope a screen's content is rendered against: the always-available built-ins, then the
 * screen's own variables. Custom keys cannot contain a dot (protocol), so a built-in can never be
 * shadowed no matter what an operator types.
 */
export function buildScope(screen: Screen, machine?: Machine): VariableScope {
  return {
    ...screen.variables,
    "screen.name": screen.friendlyName,
    "screen.id": screen.id,
    "machine.hostname": machine?.label ?? "",
  };
}

/** The one and only substitution primitive. Single pass over the TEMPLATE; values are never re-scanned. */
function substitute(template: string, scope: VariableScope, encode: (value: string) => string): string {
  if (!hasToken(template)) return template;
  return template.replace(TOKEN, (_match, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(scope, name) ? scope[name] : undefined;
    return value === undefined ? "" : encode(value);
  });
}

/** Is this still something we are willing to point a kiosk browser at? */
function isHttpUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Does a placeholder sit in the scheme or the AUTHORITY (userinfo/host/port) of this template?
 *
 * If it does, we refuse to substitute the URL at all — see `substituteUrl`. Percent-encoding is NOT
 * a defence in the authority: the WHATWG URL parser percent-DECODES the host, so an encoded `/` or
 * `@` inside a value comes back to life and can re-cut where the host ends. Variables are therefore
 * a path/query/fragment feature. `https://{{region}}.g.test/` is a real thing operators might want;
 * it is not worth a host-confusion bug on a fleet of kiosks, and a per-region SOURCE costs nothing.
 */
function tokenInAuthority(template: string): boolean {
  const schemeEnd = template.indexOf("://");
  if (schemeEnd < 0) return hasToken(template); // no authority we can reason about → refuse
  if (template.slice(0, schemeEnd).includes("{{")) return true; // a templated SCHEME. No.
  const rest = template.slice(schemeEnd + 3);
  const end = rest.search(/[/?#]/);
  return (end === -1 ? rest : rest.slice(0, end)).includes("{{");
}

/**
 * Substitute into a URL. Values are percent-encoded (`encodeURIComponent`), so wherever they land in
 * the path/query/fragment they are inert data: no new parameter, no fragment, no path traversal, no
 * quote that could break out of an HTML attribute, no `javascript:`. A placeholder in the scheme or
 * authority is refused outright (see above) — the clean template goes out unsubstituted and simply
 * fails to load, which the POL-86 prober already handles, rather than the wall quietly loading a
 * host a variable chose.
 *
 * Belt and braces: the result must still parse as an http(s) URL. If some pathological combination
 * produces something that doesn't, we degrade to the all-empty substitution, then to the template.
 */
export function substituteUrl(template: string, scope: VariableScope): string {
  if (!hasToken(template)) return template;
  if (tokenInAuthority(template)) return template;
  const filled = substitute(template, scope, encodeURIComponent);
  if (isHttpUrl(filled)) return filled;
  const blanked = substitute(template, scope, () => "");
  return isHttpUrl(blanked) ? blanked : template;
}

/** Substitute into on-glass TEXT. No escaping: the player renders these as text nodes (see header). */
export function substituteText(template: string, scope: VariableScope): string {
  return substitute(template, scope, (value) => value);
}

/**
 * Every placeholder in `templates` that resolves to nothing in `scope`, de-duplicated, in first-seen
 * order. Drives the console's "2 placeholders unresolved" warning badge — the DoD's price for
 * resolving an undefined variable to empty instead of shouting on the wall.
 */
export function unresolvedIn(templates: Iterable<string>, scope: VariableScope): string[] {
  const missing = new Set<string>();
  for (const template of templates) {
    if (!hasToken(template)) continue;
    for (const match of template.matchAll(TOKEN)) {
      const name = match[1];
      if (name !== undefined && !Object.prototype.hasOwnProperty.call(scope, name)) missing.add(name);
    }
  }
  return [...missing];
}
