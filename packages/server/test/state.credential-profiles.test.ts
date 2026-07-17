/**
 * POL-24 — credential profiles: centrally-held OAuth clients for Bucket-A content auth.
 *
 * These drive `ControlPlane` directly against the `MemoryStore` (no server/WS/IdP). They pin the
 * load-bearing contracts:
 *   - the client secret NEVER appears in an outward-facing view;
 *   - a profile referenced by a source cannot be deleted (reassign first);
 *   - the send-time stamp (`decorateSliceForSend`) appends the CURRENT token to web/dashboard URLs
 *     without mutating the stored slice — the DB keeps the clean url;
 *   - profiles + source references survive a restart (fresh ControlPlane over the same store).
 *
 * The TokenService suite at the bottom exercises the real client-credentials exchange against a
 * local Bun.serve stand-in for an IdP token endpoint.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";
import { TokenService } from "../src/tokens";

import type { CreateCredentialProfileBody } from "@polyptic/protocol";

const PROFILE_BODY: CreateCredentialProfileBody = {
  name: "Grafana IdP",
  tokenEndpoint: "https://idp.example.test/token",
  clientId: "polyptic-kiosk",
  clientSecret: "s3cret",
};

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

/** Register one machine with one output and return its screen id. */
async function registerScreen(): Promise<string> {
  const result = await cp.registerMachine({
    machineId: "m-1",
    agentVersion: "test",
    backend: "dev-open",
    outputs: [{ connector: "HDMI-A-1", width: 1920, height: 1080 }],
  });
  const screenId = result.assignments[0]?.screenId;
  if (!screenId) throw new Error("expected a screen to be created");
  return screenId;
}

describe("ControlPlane credential profiles (POL-24)", () => {
  test("create assigns a server id; views carry config + health but NEVER the secret", async () => {
    const profile = await cp.createCredentialProfile(PROFILE_BODY);
    expect(profile.id).toBe("credential-1");

    const views = cp.getCredentialProfileViews();
    expect(views).toHaveLength(1);
    const view = views[0]!;
    expect(view.name).toBe("Grafana IdP");
    expect(view.clientId).toBe("polyptic-kiosk");
    expect(view.tokenParam).toBe("auth_token");
    expect(view.tokenStatus).toBe("pending"); // no token provider wired in this test
    expect(view.inUseBy).toBe(0);
    expect(JSON.stringify(views)).not.toContain("s3cret");
  });

  test("update with clientSecret omitted keeps the stored secret; provided replaces it", async () => {
    const profile = await cp.createCredentialProfile(PROFILE_BODY);

    await cp.updateCredentialProfile(profile.id, { name: "Renamed" });
    expect(cp.getCredentialProfileInternal(profile.id)?.clientSecret).toBe("s3cret");
    expect(cp.getCredentialProfileInternal(profile.id)?.name).toBe("Renamed");

    await cp.updateCredentialProfile(profile.id, { clientSecret: "rotated" });
    expect(cp.getCredentialProfileInternal(profile.id)?.clientSecret).toBe("rotated");
  });

  test("a profile referenced by a source cannot be deleted; detaching frees it", async () => {
    const profile = await cp.createCredentialProfile(PROFILE_BODY);
    const created = await cp.createContentSource({
      name: "Ops Overview",
      kind: "dashboard",
      url: "https://grafana.example.test/d/abc?kiosk",
      credentialProfileId: profile.id,
    });
    expect(created.ok).toBe(true);

    const refused = await cp.deleteCredentialProfile(profile.id);
    expect(refused).toEqual({ ok: false, error: "in-use", inUseBy: 1 });

    if (!created.ok) throw new Error("unreachable");
    const detached = await cp.updateContentSource(created.source.id, { credentialProfileId: null });
    expect(detached.ok).toBe(true);
    expect(await cp.deleteCredentialProfile(profile.id)).toEqual({ ok: true });
  });

  test("a source referencing an unknown profile is rejected", async () => {
    const created = await cp.createContentSource({
      name: "Bad",
      kind: "web",
      url: "https://example.test/",
      credentialProfileId: "credential-999",
    });
    expect(created).toEqual({ ok: false, error: "unknown-profile" });
  });

  test("decorateSliceForSend stamps the current token into the URL; the stored slice stays clean", async () => {
    const profile = await cp.createCredentialProfile(PROFILE_BODY);
    const created = await cp.createContentSource({
      name: "Ops Overview",
      kind: "dashboard",
      url: "https://grafana.example.test/d/abc?kiosk",
      credentialProfileId: profile.id,
    });
    if (!created.ok) throw new Error("expected source");
    const screenId = await registerScreen();
    const assigned = await cp.setScreenContent(screenId, { sourceId: created.source.id });
    expect(assigned.ok).toBe(true);

    // No provider wired → NO token is stamped (login page until the token-usable edge). The slice
    // still picks up POL-94's send-time `sourceId` stamp — that is what lets the player attribute a
    // reachability report back to this library source — but the URL itself is untouched.
    const stored = cp.getSlice(screenId)!;
    const undecorated = cp.decorateSliceForSend(stored);
    expect((undecorated.surfaces[0] as { url: string }).url).toBe("https://grafana.example.test/d/abc?kiosk");
    expect((undecorated.surfaces[0] as { sourceId?: string }).sourceId).toBe(created.source.id);
    expect((stored.surfaces[0] as { sourceId?: string }).sourceId).toBeUndefined(); // stored stays clean

    cp.setTokenProvider({
      getToken: (id) => (id === profile.id ? "JWT-123" : undefined),
      statusFor: () => ({ tokenStatus: "ok" }),
    });

    const decorated = cp.decorateSliceForSend(stored);
    const url = new URL((decorated.surfaces[0] as { url: string }).url);
    expect(url.searchParams.get("auth_token")).toBe("JWT-123");
    expect(url.searchParams.has("kiosk")).toBe(true); // existing query preserved

    // The stored slice (what the DB holds) still carries the clean url.
    const storedUrl = (cp.getSlice(screenId)!.surfaces[0] as { url: string }).url;
    expect(storedUrl).not.toContain("auth_token");

    // And the screen is reported as depending on the profile (the token-usable re-push set).
    expect(cp.screenIdsUsingProfile(profile.id)).toEqual([screenId]);
  });

  test("POL-149: a renewed token re-stamps only the screens using that profile; others untouched", async () => {
    // Two profiles, two dashboards, two screens — one on each profile.
    const profileA = await cp.createCredentialProfile({ ...PROFILE_BODY, name: "Grafana A" });
    const profileB = await cp.createCredentialProfile({ ...PROFILE_BODY, name: "Grafana B" });
    const sourceA = await cp.createContentSource({
      name: "Ops A",
      kind: "dashboard",
      url: "https://grafana.example.test/d/aaa?kiosk",
      credentialProfileId: profileA.id,
    });
    const sourceB = await cp.createContentSource({
      name: "Ops B",
      kind: "dashboard",
      url: "https://grafana.example.test/d/bbb?kiosk",
      credentialProfileId: profileB.id,
    });
    if (!sourceA.ok || !sourceB.ok) throw new Error("expected sources");

    const registered = await cp.registerMachine({
      machineId: "m-1",
      agentVersion: "test",
      backend: "dev-open",
      outputs: [
        { connector: "HDMI-A-1", width: 1920, height: 1080 },
        { connector: "HDMI-A-2", width: 1920, height: 1080 },
      ],
    });
    const screenA = registered.assignments[0]!.screenId;
    const screenB = registered.assignments[1]!.screenId;
    await cp.setScreenContent(screenA, { sourceId: sourceA.source.id });
    await cp.setScreenContent(screenB, { sourceId: sourceB.source.id });

    // A mutable token cache — rotating profile A's token models a routine refresh.
    const currentToken: Record<string, string> = { [profileA.id]: "A-old", [profileB.id]: "B-tok" };
    cp.setTokenProvider({
      getToken: (id) => currentToken[id],
      statusFor: () => ({ tokenStatus: "ok" }),
    });

    // The re-push set for profile A is EXACTLY screen A (profile B's screen is not disturbed).
    expect(cp.screenIdsUsingProfile(profileA.id)).toEqual([screenA]);
    expect(cp.screenIdsUsingProfile(profileB.id)).toEqual([screenB]);

    const tokenInUrl = (screenId: string): string | null => {
      const decorated = cp.decorateSliceForSend(cp.getSlice(screenId)!);
      return new URL((decorated.surfaces[0] as { url: string }).url).searchParams.get("auth_token");
    };
    expect(tokenInUrl(screenA)).toBe("A-old");
    expect(tokenInUrl(screenB)).toBe("B-tok");

    // Routine refresh rotates A's token. The re-push (server wiring) re-decorates screen A's slice —
    // which now carries the NEW token — while screen B (a different profile) still carries B-tok.
    currentToken[profileA.id] = "A-new";
    expect(tokenInUrl(screenA)).toBe("A-new");
    expect(tokenInUrl(screenB)).toBe("B-tok");
  });

  test("profiles and source references survive a restart", async () => {
    const profile = await cp.createCredentialProfile(PROFILE_BODY);
    await cp.createContentSource({
      name: "Ops Overview",
      kind: "dashboard",
      url: "https://grafana.example.test/d/abc",
      credentialProfileId: profile.id,
    });

    const rebooted = new ControlPlane(store);
    await rebooted.init();
    expect(rebooted.getCredentialProfileInternal(profile.id)?.clientSecret).toBe("s3cret");
    expect(rebooted.getCredentialProfileViews()[0]?.inUseBy).toBe(1);
    // The id counter resumed past the persisted profile.
    const next = await rebooted.createCredentialProfile({ ...PROFILE_BODY, name: "Second" });
    expect(next.id).toBe("credential-2");
  });
});

describe("TokenService (POL-24)", () => {
  const noopLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as ConstructorParameters<typeof TokenService>[0]["log"];

  let idp: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    idp?.stop(true);
    idp = undefined;
  });

  test("exchanges client credentials for a token; getToken serves it; usable-edge fires once", async () => {
    let requests = 0;
    let lastBody = "";
    idp = Bun.serve({
      port: 0,
      fetch: async (req) => {
        requests += 1;
        lastBody = await req.text();
        return Response.json({ access_token: `tok-${requests}`, expires_in: 3600, token_type: "Bearer" });
      },
    });

    const usableEdges: string[] = [];
    const tokens = new TokenService({
      log: noopLog,
      onTokenUsable: (id) => usableEdges.push(id),
    });
    tokens.upsertProfile({
      id: "credential-1",
      name: "Test IdP",
      strategy: "oauth-client-credentials",
      tokenEndpoint: `http://localhost:${idp.port}/token`,
      clientId: "polyptic-kiosk",
      clientSecret: "s3cret",
      scope: "api://grafana/.default",
      audience: null,
      tokenParam: "auth_token",
    });

    // The fetch is async — poll briefly for the cache to warm.
    for (let i = 0; i < 100 && tokens.getToken("credential-1") === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(tokens.getToken("credential-1")).toBe("tok-1");
    expect(tokens.statusFor("credential-1").tokenStatus).toBe("ok");
    expect(usableEdges).toEqual(["credential-1"]); // the not-usable → usable edge fired once

    const form = new URLSearchParams(lastBody);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe("polyptic-kiosk");
    expect(form.get("client_secret")).toBe("s3cret");
    expect(form.get("scope")).toBe("api://grafana/.default");
    expect(form.get("audience")).toBeNull(); // null audience is not sent

    // A forced re-exchange while already usable is a ROUTINE renewal, not a usable edge: it warms the
    // cache with the fresh token but does NOT re-fire onTokenUsable (POL-155 — no wall re-push, so no
    // framed-app reload). getToken now serves the freshly-minted token.
    const result = await tokens.testProfile("credential-1");
    expect(result).toEqual({ ok: true, expiresIn: 3600 });
    expect(usableEdges).toEqual(["credential-1"]); // still one edge — the renewal did not re-push
    expect(tokens.getToken("credential-1")).toBe("tok-2");

    tokens.stop();
  });

  test("POL-155: a routine renewal does NOT re-push — only the first-usable edge does", async () => {
    let requests = 0;
    idp = Bun.serve({
      port: 0,
      fetch: () => {
        requests += 1;
        return Response.json({ access_token: `tok-${requests}`, expires_in: 3600, token_type: "Bearer" });
      },
    });

    const usableEdges: string[] = [];
    const tokens = new TokenService({
      log: noopLog,
      onTokenUsable: (id) => usableEdges.push(id),
    });
    tokens.upsertProfile({
      id: "credential-7",
      name: "Grafana IdP",
      strategy: "oauth-client-credentials",
      tokenEndpoint: `http://localhost:${idp.port}/token`,
      clientId: "polyptic-kiosk",
      clientSecret: "s3cret",
      scope: null,
      audience: null,
      tokenParam: "auth_token",
    });

    for (let i = 0; i < 100 && tokens.getToken("credential-7") === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // First fetch: the usable edge fires once — that stamped auth_token signs Grafana in.
    expect(usableEdges).toEqual(["credential-7"]);

    // Routine refreshes while still usable re-fetch the token (getToken serves the newest) but NEVER
    // re-push: Grafana holds its own session, so re-stamping would only reboot the frame (a flash).
    await tokens.testProfile("credential-7");
    await tokens.testProfile("credential-7");
    expect(usableEdges).toEqual(["credential-7"]); // still exactly one edge — no routine re-push
    expect(tokens.getToken("credential-7")).toBe(`tok-${requests}`); // cache stayed warm

    tokens.stop();
  });

  test("an IdP failure surfaces its message and reads as error; getToken stays empty", async () => {
    idp = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ error: "invalid_client", error_description: "bad secret" }, { status: 401 }),
    });

    const tokens = new TokenService({ log: noopLog });
    tokens.upsertProfile({
      id: "credential-1",
      name: "Test IdP",
      strategy: "oauth-client-credentials",
      tokenEndpoint: `http://localhost:${idp.port}/token`,
      clientId: "polyptic-kiosk",
      clientSecret: "wrong",
      scope: null,
      audience: null,
      tokenParam: "auth_token",
    });

    for (let i = 0; i < 100 && tokens.statusFor("credential-1").tokenStatus === "pending"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(tokens.getToken("credential-1")).toBeUndefined();
    const status = tokens.statusFor("credential-1");
    expect(status.tokenStatus).toBe("error");
    expect(status.lastError).toContain("invalid_client");
    expect(status.lastError).toContain("bad secret");

    tokens.stop();
  });
});
