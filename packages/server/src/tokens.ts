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
 * error / secret fix): the wiring re-pushes renders to affected screens, which stamps a fresh
 * `auth_token` into the content URL. For Grafana that first stamped URL is the SIGN-IN: `url_login`
 * validates the JWT once and mints Grafana's OWN session cookie (default ~30-day lifetime, silently
 * self-rotating). After that the framed app stays authenticated with no further help from us. So the
 * usable edge is the only push that signs the wall in — and the recovery heal if the token was ever
 * not-usable.
 *
 * POL-155 — a ROUTINE token refresh does NOT re-push. `auth_token` is Grafana's `url_login` sign-in
 * mechanism, not a per-request bearer: once the session cookie exists, re-stamping a NEW auth_token
 * would only change the iframe URL, forcing the player to re-navigate the frame and Grafana to reboot
 * (a visible flash) — for no benefit, because the existing cookie already keeps the wall signed in.
 * POL-149 re-pushed on every routine renewal on the mistaken premise that the framed session expires
 * with the JWT; it does not. The token CACHE still refreshes every cycle (so a future first-usable /
 * recovery push always carries a valid token) — only the wall-facing re-push on routine renewal is
 * gone. Caveat: if Grafana's session genuinely lapses (30+ days, or Grafana restarts) we cannot yet
 * DETECT it — surface-health proves fetchability but can't tell a login page from a dashboard. The
 * proper fix is login-page detection, not a perpetual reload; that gap is accepted for now.
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
}

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 300_000;
/** Refresh at 75% of the token's lifetime, but never sooner than 15s out (tiny expires_in). */
const MIN_REFRESH_MS = 15_000;
/** Treat a token within 10s of expiry as unusable — a player load takes time to reach the app. */
const EXPIRY_SLACK_MS = 10_000;

export interface TokenServiceDeps {
  log: FastifyBaseLogger;
  /** Fired on the not-usable → usable edge (first fetch, or recovery after an error / secret fix).
   *  The wiring re-pushes affected screens — the push that signs a framed app (e.g. Grafana) in.
   *  A routine refresh does NOT fire this (POL-155): the framed app holds its own session. */
  onTokenUsable?: (profileId: string) => void;
  /** Fired on any status/expiry change worth reflecting in the console (coalesced by the caller). */
  onStatusChange?: () => void;
}

export class TokenService {
  private readonly states = new Map<string, TokenState>();

  constructor(private readonly deps: TokenServiceDeps) {}

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
      // POL-155 — only the not-usable → usable EDGE re-pushes: that stamped URL is the framed app's
      // sign-in (Grafana's url_login mints its own session cookie on first load). A routine refresh
      // (wasUsable) re-fetches the token to keep the cache warm but does NOT re-push — re-stamping a
      // new auth_token into a live iframe would only re-navigate the frame and reboot the app (a
      // visible flash) while the app's existing session already keeps the wall signed in.
      if (!wasUsable) this.deps.onTokenUsable?.(profileId);
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
