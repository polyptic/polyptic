/**
 * PlayerAuth — the /player channel's access control (POL-54).
 *
 * THE GAP THIS CLOSES: the player WS was completely ungated — anyone who could reach the server
 * could send `player/hello {screenId}` and receive that screen's full slice, live, forever. A slice
 * is not public data: web/dashboard URLs are credential-stamped at send time (`?auth_token=`,
 * POL-24), so the open channel leaked live IdP access tokens to anyone on the network, plus every
 * content URL, page definition, and rename. It also let an outsider mark screens ONLINE in the
 * console and spoof `player/ack` revisions.
 *
 * THE IDENTITY A PLAYER LEGITIMATELY HAS: it is launched by the AGENT — which authenticated on ITS
 * channel (2b credential / mTLS, POL-25) — at a URL the SERVER minted (`ScreenAssignment.playerUrl`
 * in `server/apply`). So the server stamps a per-screen bearer token into that URL (`?token=`), the
 * player echoes it in `player/hello`, and the channel admits only a matching (screenId, token) pair.
 * The token therefore rides the exact trust chain that already exists: server → authenticated agent
 * → browser launch → player. No new secret distribution, no manual step, no boot click (D4).
 *
 * TOKEN SHAPE: HMAC-SHA256(secret, screenId), hex — deterministic per screen, derived from ONE
 * per-deployment secret persisted in the store (generated on first boot, like the mTLS CA). Why
 * deterministic + persistent, not short-lived:
 *   - A wall must survive ANY reconnect/reload forever with the URL it was launched with — a token
 *     that ages out kills repaint-on-reconnect and violates "the wall never dies" (D5's live path is
 *     a reconnect away at all times). Expiry adds wall-killing failure modes and no attacker cost:
 *     the URL lives on the box either way.
 *   - Compromise of one token exposes ONE screen's slice, not the fleet, and not the agent channel.
 *   - Rotation = replace the secret row; every `server/apply` after that carries fresh URLs and
 *     agents relaunch their browsers (they diff playerUrl), so the fleet self-heals without hands.
 *
 * ENFORCEMENT rides `AUTH_ENABLED` — the same switch that gates REST and the /admin WS — so a dev
 * stack (`AUTH_ENABLED=false`) keeps its paste-a-player-URL workflow, and every secured deployment
 * gets the gate without new configuration. Tokens are ALWAYS minted into playerUrls (even with auth
 * off), so flipping auth on later needs no re-enrolment: the boxes already hold valid URLs.
 */
import { createHmac, randomBytes } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import { constantTimeEqual } from "./enroll";
import type { Store } from "./store";

export class PlayerAuth {
  private constructor(
    private readonly secret: Buffer,
    /** When true (auth enabled) the /player upgrade path REQUIRES a valid token on hello. */
    readonly required: boolean,
  ) {}

  /**
   * Load the persisted per-deployment secret, or generate + persist one on first boot. The secret
   * must be durable: a restarted server has handed out playerUrls that walls are still running on.
   */
  static async init(store: Store, required: boolean, log: FastifyBaseLogger): Promise<PlayerAuth> {
    let secret = await store.getPlayerTokenSecret();
    if (!secret) {
      secret = randomBytes(32).toString("hex");
      await store.setPlayerTokenSecret(secret);
      log.info({ event: "player.auth.secret.created" }, "generated the player-token secret (first boot)");
    }
    return new PlayerAuth(Buffer.from(secret, "hex"), required);
  }

  /** A test-friendly constructor (no store) — unit tests and fixtures. */
  static fromSecret(secretHex: string, required: boolean): PlayerAuth {
    return new PlayerAuth(Buffer.from(secretHex, "hex"), required);
  }

  /** The bearer token for one screen: HMAC-SHA256(secret, screenId), hex (64 chars). */
  tokenFor(screenId: string): string {
    return createHmac("sha256", this.secret).update(screenId, "utf8").digest("hex");
  }

  /** Constant-time check that `token` is THIS screen's token (a token never authorizes another
   *  screen — cross-screen replay of a leaked token fails here). */
  verify(screenId: string, token: string | undefined): boolean {
    if (!token) return false;
    return constantTimeEqual(token, this.tokenFor(screenId));
  }
}
