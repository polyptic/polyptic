/**
 * TokenService — the OAuth client-credentials engine behind credential profiles (POL-24).
 *
 * For each profile it POSTs `grant_type=client_credentials` (+ optional scope/audience) to the
 * profile's token endpoint, caches the returned JWT access token in memory, and schedules a refresh
 * at ~75% of the token's lifetime so the cache is ALWAYS warm — a render push never waits on the IdP.
 * Failures back off (30s → doubling, capped at 5 min) and surface as an `error` status the console
 * shows verbatim.
 *
 * Tokens are NEVER persisted (short-lived, re-fetched on boot) and NEVER leave the server except
 * stamped into a content URL on the player wire at send time (see ControlPlane.decorateSliceForSend).
 * The client secret enters this class from the store and goes nowhere else.
 *
 * `onTokenUsable` fires only on the not-usable → usable EDGE (first fetch, or recovery after an
 * error / secret fix): the wiring re-pushes renders to affected screens so a wall stuck on a login
 * page heals itself.
 *
 * `onTokenRenewed` fires on a ROUTINE refresh — a fresh token replacing one that was still usable
 * (POL-149). The wiring re-pushes the same screens so the iframe re-stamps its `auth_token` and the
 * framed app (e.g. Grafana) re-establishes its session BEFORE the old one lapses. This reverses
 * POL-24's original "routine refreshes push nothing" stance: that assumed a re-stamp reloads a live
 * iframe and that the framed app's own session carries the page indefinitely. The field proved the
 * session DOES expire (an unattended wall was bounced to Grafana's login screen with a flood of 401s),
 * and POL-86's proven-before-painted player now swaps a re-stamped URL in place — the OLD content
 * stays up until the NEW url proves — so the re-stamp is seamless, not a login-screen flash.
 *
 * POL-155 — but a re-stamp still costs a full framed-app re-init (Grafana reloads every plugin) with a
 * visible flash, and the token refresh runs at ~75% of a SHORT token life (every few minutes), far
 * more often than the framed session actually needs a fresh token. So `onTokenRenewed` is THROTTLED
 * per profile: a routine renewal re-pushes at most once per `renewRePushIntervalMs` (sized to the
 * framed session's lifetime, not the token-refresh cadence). The token cache still refreshes on every
 * cycle — `getToken` always serves the newest token — only the wall re-push is rate-limited, so each
 * re-push carries a currently-valid token and lands well before the framed session would lapse, but
 * the wall is not reloaded on every token refresh. The `onTokenUsable` EDGE is NEVER throttled: a
 * screen stuck on a login page (first-usable, or recovery after an error) heals immediately.
 */
import type { CredentialTokenStatus } from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";

import type { PersistedCredentialProfile } from "./store";

/** Live token health for one profile, shaped for CredentialProfileView. */
export interface TokenStatus {
  tokenStatus: CredentialTokenStatus;
  tokenExpiresAt?: string;
  lastError?: string;
}

interface TokenState {
  profile: PersistedCredentialProfile;
  accessToken?: string;
  /** Epoch ms the cached token expires. */
  expiresAt?: number;
  status: CredentialTokenStatus;
  lastError?: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Consecutive failures, drives the retry backoff. */
  failures: number;
  /** Guards against a stale in-flight fetch clobbering the state after upsert/remove. */
  generation: number;
  /** POL-155 — epoch ms of the last re-push (usable edge or a fired routine renewal). Routine
   *  renewals within `renewRePushIntervalMs` of this are throttled so the wall is not reloaded on
   *  every token refresh. Undefined until the first re-push. */
  lastRePushAt?: number;
}

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 300_000;
/** Refresh at 75% of the token's lifetime, but never sooner than 15s out (tiny expires_in). */
const MIN_REFRESH_MS = 15_000;
/** Treat a token within 10s of expiry as unusable — a player load takes time to reach the app. */
const EXPIRY_SLACK_MS = 10_000;
/** POL-155 — default minimum gap between routine renewal re-pushes for one profile. Sized to a framed
 *  session's lifetime (minutes-to-hours), NOT the token-refresh cadence (~75% of a short token life,
 *  often every few minutes). Long enough to kill the periodic flash, short enough that the framed
 *  session is refreshed well before it would lapse. Configurable via the constructor. */
export const DEFAULT_RENEW_REPUSH_INTERVAL_MS = 30 * 60_000;

export interface TokenServiceDeps {
  log: FastifyBaseLogger;
  /** Fired on the not-usable → usable edge (never on routine refresh; never throttled). */
  onTokenUsable?: (profileId: string) => void;
  /** POL-149 — fired on a routine refresh: a fresh token replaced one that was still usable. The
   *  wiring re-pushes affected screens so the framed app re-auths before its session lapses.
   *  POL-155 — throttled per profile to at most once per `renewRePushIntervalMs`. */
  onTokenRenewed?: (profileId: string) => void;
  /** Fired on any status/expiry change worth reflecting in the console (coalesced by the caller). */
  onStatusChange?: () => void;
  /** POL-155 — minimum gap between routine renewal re-pushes per profile. Default
   *  `DEFAULT_RENEW_REPUSH_INTERVAL_MS`. Set ≤0 to re-push on every refresh (POL-149 behaviour). */
  renewRePushIntervalMs?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export class TokenService {
  private readonly states = new Map<string, TokenState>();
  private readonly renewRePushIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: TokenServiceDeps) {
    this.renewRePushIntervalMs =
      deps.renewRePushIntervalMs !== undefined && Number.isFinite(deps.renewRePushIntervalMs)
        ? deps.renewRePushIntervalMs
        : DEFAULT_RENEW_REPUSH_INTERVAL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Seed the service with the persisted profiles on boot; fetches all tokens immediately. */
  setProfiles(profiles: PersistedCredentialProfile[]): void {
    for (const profile of profiles) this.upsertProfile(profile);
  }

  /** Add a profile or apply changed config; (re)fetches its token immediately. */
  upsertProfile(profile: PersistedCredentialProfile): void {
    const existing = this.states.get(profile.id);
    if (existing?.timer) clearTimeout(existing.timer);
    const state: TokenState = {
      profile,
      status: "pending",
      failures: 0,
      generation: (existing?.generation ?? 0) + 1,
    };
    this.states.set(profile.id, state);
    void this.refresh(profile.id, state.generation);
  }

  /** Forget a profile and its cached token. */
  removeProfile(profileId: string): void {
    const state = this.states.get(profileId);
    if (state?.timer) clearTimeout(state.timer);
    this.states.delete(profileId);
  }

  /** The current usable token for a profile, or undefined while pending/error/near-expiry. Sync —
   *  called on the render send path, which must never wait on the IdP. */
  getToken(profileId: string): string | undefined {
    const state = this.states.get(profileId);
    if (!state?.accessToken || state.expiresAt === undefined) return undefined;
    if (Date.now() >= state.expiresAt - EXPIRY_SLACK_MS) return undefined;
    return state.accessToken;
  }

  /** Live health for the console's CredentialProfileView. Unknown profile reads as pending. */
  statusFor(profileId: string): TokenStatus {
    const state = this.states.get(profileId);
    if (!state) return { tokenStatus: "pending" };
    return {
      tokenStatus: state.status,
      tokenExpiresAt: state.expiresAt !== undefined ? new Date(state.expiresAt).toISOString() : undefined,
      lastError: state.lastError,
    };
  }

  /** One forced exchange NOW (the console's Test button). Updates the cache/status on the way. */
  async testProfile(profileId: string): Promise<{ ok: boolean; expiresIn?: number; error?: string }> {
    const state = this.states.get(profileId);
    if (!state) return { ok: false, error: "unknown profile" };
    if (state.timer) clearTimeout(state.timer);
    const result = await this.refresh(profileId, state.generation);
    return result;
  }

  /** Clear every pending timer (shutdown). */
  stop(): void {
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
  }

  /** Fetch a token for the profile; on success cache + schedule the 75% refresh, on failure record
   *  the error + schedule a backoff retry. `generation` fences out fetches from replaced configs. */
  private async refresh(
    profileId: string,
    generation: number,
  ): Promise<{ ok: boolean; expiresIn?: number; error?: string }> {
    const state = this.states.get(profileId);
    if (!state || state.generation !== generation) return { ok: false, error: "profile replaced" };
    const { profile } = state;

    const wasUsable = this.getToken(profileId) !== undefined;

    try {
      const form = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: profile.clientId,
        client_secret: profile.clientSecret,
      });
      if (profile.scope) form.set("scope", profile.scope);
      if (profile.audience) form.set("audience", profile.audience);

      const response = await fetch(profile.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });

      const current = this.states.get(profileId);
      if (!current || current.generation !== generation) return { ok: false, error: "profile replaced" };

      if (!response.ok) {
        // Surface the IdP's own words (error/error_description) — that's what an operator can act on.
        const body = await response.text().catch(() => "");
        let detail = body.slice(0, 300);
        try {
          const json = JSON.parse(body) as { error?: string; error_description?: string };
          detail = [json.error, json.error_description].filter(Boolean).join(": ") || detail;
        } catch {
          /* not JSON — keep the raw slice */
        }
        return this.recordFailure(current, generation, `HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
      }

      const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
      const accessToken = typeof payload.access_token === "string" ? payload.access_token : undefined;
      const expiresIn =
        typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in > 0
          ? Math.floor(payload.expires_in)
          : 300; // some IdPs omit expires_in — assume a conservative 5 min
      if (!accessToken) {
        return this.recordFailure(current, generation, "token response had no access_token");
      }

      current.accessToken = accessToken;
      current.expiresAt = Date.now() + expiresIn * 1000;
      current.status = "ok";
      current.lastError = undefined;
      current.failures = 0;
      this.schedule(profileId, generation, Math.max(expiresIn * 750, MIN_REFRESH_MS));
      this.deps.log.info(
        { event: "token.refreshed", profileId, expiresIn },
        `credential profile ${profile.name}: token refreshed`,
      );
      this.deps.onStatusChange?.();
      if (wasUsable) {
        // Routine refresh (POL-149): re-push so the framed app re-auths with the fresh token before
        // its old session lapses. POL-155 — throttle to at most once per renewRePushIntervalMs: the
        // token cache is already warm (getToken serves the newest token), so skipping a re-push only
        // defers the next seamless in-place re-stamp; it never lets the wall fall to a login screen,
        // because the next re-push still lands well before the framed session's (much longer than a
        // token life) lifetime elapses.
        const now = this.now();
        const dueAt = (current.lastRePushAt ?? -Infinity) + this.renewRePushIntervalMs;
        if (now >= dueAt) {
          current.lastRePushAt = now;
          this.deps.onTokenRenewed?.(profileId);
        } else {
          this.deps.log.debug(
            { event: "token.renew.throttled", profileId, nextRePushInMs: Math.round(dueAt - now) },
            `credential profile ${profile.name}: token renewed, re-push throttled (POL-155)`,
          );
        }
      } else {
        // Edge: a screen may be sitting on a login page — heal it immediately, never throttled.
        current.lastRePushAt = this.now();
        this.deps.onTokenUsable?.(profileId);
      }
      return { ok: true, expiresIn };
    } catch (err) {
      const current = this.states.get(profileId);
      if (!current || current.generation !== generation) return { ok: false, error: "profile replaced" };
      return this.recordFailure(current, generation, String(err instanceof Error ? err.message : err));
    }
  }

  private recordFailure(
    state: TokenState,
    generation: number,
    error: string,
  ): { ok: false; error: string } {
    // A still-valid cached token keeps serving through a failed refresh; only the status flips when
    // the cache is empty/expired.
    state.status = this.getToken(state.profile.id) !== undefined ? "ok" : "error";
    state.lastError = error;
    state.failures += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (state.failures - 1), RETRY_MAX_MS);
    this.schedule(state.profile.id, generation, delay);
    this.deps.log.warn(
      { event: "token.refresh.failed", profileId: state.profile.id, failures: state.failures, error },
      `credential profile ${state.profile.name}: token fetch failed`,
    );
    this.deps.onStatusChange?.();
    return { ok: false, error };
  }

  private schedule(profileId: string, generation: number, delayMs: number): void {
    const state = this.states.get(profileId);
    if (!state || state.generation !== generation) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.refresh(profileId, generation), delayMs);
    // Never keep the process alive just for a token refresh.
    state.timer.unref?.();
  }
}
