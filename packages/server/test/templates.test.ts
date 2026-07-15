/**
 * POL-111 — the substitution primitive itself, in isolation: what a `{{placeholder}}` resolves to,
 * and (the part that matters) what a HOSTILE variable value can and cannot do to a URL or to text.
 *
 * The threat model: an operator (or a compromised console session) sets a variable value. That value
 * lands inside a URL a kiosk browser will load and inside text a player will paint. It must be inert
 * in both — it can never become a scheme, a parameter, another placeholder, or markup.
 */
import { describe, expect, test } from "bun:test";

import { ScreenVariableValue, ScreenVariables } from "@polyptic/protocol";

import { buildScope, substituteText, substituteUrl, unresolvedIn } from "../src/templates";

const screen = {
  id: "screen-7",
  friendlyName: "Sheffield Lobby",
  machineId: "box-1",
  connector: "DP-1",
  castEnabled: false,
  variables: { line: "Line 3", site: "Sheffield" },
};
const machine = {
  id: "box-1",
  label: "wall1",
  outputs: [],
  status: "approved" as const,
  shellEnabled: false,
};

const scope = buildScope(screen, machine);

describe("scope", () => {
  test("built-ins are always available alongside the screen's own variables", () => {
    expect(scope["screen.name"]).toBe("Sheffield Lobby");
    expect(scope["screen.id"]).toBe("screen-7");
    expect(scope["machine.hostname"]).toBe("wall1");
    expect(scope["line"]).toBe("Line 3");
  });

  test("a screen with no machine still resolves built-ins (hostname empty, never a stray token)", () => {
    const s = buildScope({ ...screen, variables: {} }, undefined);
    expect(s["machine.hostname"]).toBe("");
    expect(substituteText("host={{machine.hostname}}", s)).toBe("host=");
  });
});

describe("substituteUrl", () => {
  test("built-ins and custom variables resolve, percent-encoded", () => {
    expect(substituteUrl("https://g.test/d/x?var-line={{line}}", scope)).toBe(
      "https://g.test/d/x?var-line=Line%203",
    );
    expect(substituteUrl("https://g.test/{{screen.id}}", scope)).toBe("https://g.test/screen-7");
  });

  test("whitespace inside the braces is tolerated", () => {
    expect(substituteUrl("https://g.test/?s={{  site  }}", scope)).toBe("https://g.test/?s=Sheffield");
  });

  test("an undefined placeholder resolves to EMPTY — never literal braces on the glass", () => {
    expect(substituteUrl("https://g.test/?s={{nope}}", scope)).toBe("https://g.test/?s=");
  });

  test("a URL with no placeholders is returned byte-identical (the hot path)", () => {
    const url = "https://g.test/d/abc?kiosk&refresh=30s";
    expect(substituteUrl(url, scope)).toBe(url);
  });

  // ── injection ───────────────────────────────────────────────────────────────
  test("a value cannot inject an extra query parameter", () => {
    const hostile = buildScope({ ...screen, variables: { line: "3&admin=1" } }, machine);
    const out = substituteUrl("https://g.test/d/x?line={{line}}", hostile);
    expect(out).toBe("https://g.test/d/x?line=3%26admin%3D1");
    expect(new URL(out).searchParams.get("admin")).toBeNull();
  });

  test("a value cannot smuggle a javascript: scheme into the loaded URL", () => {
    const hostile = buildScope({ ...screen, variables: { line: "javascript:alert(1)" } }, machine);
    const out = substituteUrl("https://g.test/?next={{line}}", hostile);
    expect(new URL(out).protocol).toBe("https:");
    expect(out).not.toContain("javascript:");
  });

  test("quotes and angle brackets are percent-encoded (no attribute/tag break-out)", () => {
    const hostile = buildScope({ ...screen, variables: { line: `"><script>x</script>` } }, machine);
    const out = substituteUrl("https://g.test/?q={{line}}", hostile);
    expect(out).not.toContain("<");
    expect(out).not.toContain('"');
    expect(new URL(out).searchParams.get("q")).toBe(`"><script>x</script>`);
  });

  test("a value cannot climb out of the path", () => {
    const hostile = buildScope({ ...screen, variables: { line: "../../etc/passwd" } }, machine);
    const out = substituteUrl("https://g.test/panels/{{line}}", hostile);
    expect(new URL(out).pathname).toBe("/panels/..%2F..%2Fetc%2Fpasswd");
  });

  test("a value containing its own {{token}} is NOT expanded (single pass, no recursion)", () => {
    // The protocol forbids braces in a value; this proves the substituter is safe even if one arrived
    // by another route (a legacy row, a future writer).
    const hostile = buildScope({ ...screen, variables: { line: "{{site}}" } }, machine);
    const out = substituteUrl("https://g.test/?l={{line}}", hostile);
    expect(out).toBe("https://g.test/?l=%7B%7Bsite%7D%7D");
    expect(out).not.toContain("Sheffield");
  });

  test("a `$&`-style value is inserted literally, not re-interpreted by the replacer", () => {
    const hostile = buildScope({ ...screen, variables: { line: "$&$1" } }, machine);
    expect(new URL(substituteUrl("https://g.test/?l={{line}}", hostile)).searchParams.get("l")).toBe("$&$1");
  });

  test("a placeholder in the HOST is refused outright — percent-encoding is no defence there", () => {
    // The WHATWG parser percent-DECODES the host, so an encoded `/` or `@` in a value comes back to
    // life and re-cuts where the host ends (host confusion). Variables are path/query/fragment only:
    // the template goes out untouched and simply fails to load.
    const hostile = buildScope({ ...screen, variables: { site: "evil.test/@" } }, machine);
    expect(substituteUrl("https://{{site}}.g.test/", hostile)).toBe("https://{{site}}.g.test/");
    expect(substituteUrl("https://{{site}}.g.test/", hostile)).not.toContain("evil.test");
  });

  test("a placeholder in the SCHEME or in the userinfo/port is refused too", () => {
    const hostile = buildScope({ ...screen, variables: { s: "javascript", u: "user:pw" } }, machine);
    expect(substituteUrl("{{s}}://g.test/", hostile)).toBe("{{s}}://g.test/");
    expect(substituteUrl("https://{{u}}@g.test/", hostile)).toBe("https://{{u}}@g.test/");
    // …but the same variable is perfectly fine in the query, where it is encoded as data.
    expect(substituteUrl("https://g.test/?u={{u}}", hostile)).toBe("https://g.test/?u=user%3Apw");
  });
});

describe("substituteText", () => {
  test("resolves into on-glass text, verbatim (the player paints TEXT NODES — no escaping needed)", () => {
    expect(substituteText("Welcome to {{site}} — {{line}}", scope)).toBe("Welcome to Sheffield — Line 3");
  });

  test("markup in a value stays DATA: it is displayed, never parsed", () => {
    const hostile = buildScope({ ...screen, variables: { line: "<img src=x onerror=alert(1)>" } }, machine);
    // Verbatim is correct here: the player renders `{{ text }}` through Vue interpolation (there is no
    // v-html in @polyptic/elements or the player), so this shows as literal characters on the wall.
    expect(substituteText("Now: {{line}}", hostile)).toBe("Now: <img src=x onerror=alert(1)>");
  });

  test("an undefined placeholder resolves to empty, never literal braces", () => {
    expect(substituteText("Line {{lien}} status", scope)).toBe("Line  status");
  });
});

describe("unresolvedIn", () => {
  test("reports only the placeholders nothing resolves, de-duplicated", () => {
    const missing = unresolvedIn(
      ["https://g.test/?a={{line}}&b={{lien}}", "Hi {{lien}} / {{screen.name}} / {{plant}}"],
      scope,
    );
    expect(missing).toEqual(["lien", "plant"]);
  });

  test("plain strings produce nothing", () => {
    expect(unresolvedIn(["https://g.test/d/abc?kiosk"], scope)).toEqual([]);
  });
});

describe("protocol validation (the first line of defence)", () => {
  test("keys are identifier-ish and dot-free, so a built-in can never be shadowed", () => {
    expect(ScreenVariables.safeParse({ line: "3" }).success).toBe(true);
    expect(ScreenVariables.safeParse({ "screen.name": "pwn" }).success).toBe(false);
    expect(ScreenVariables.safeParse({ "9lives": "x" }).success).toBe(false);
    expect(ScreenVariables.safeParse({ "a b": "x" }).success).toBe(false);
  });

  test("values reject braces (no second pass can ever exist) and control characters", () => {
    expect(ScreenVariableValue.safeParse("Line 3").success).toBe(true);
    expect(ScreenVariableValue.safeParse("{{site}}").success).toBe(false);
    expect(ScreenVariableValue.safeParse("a\nb").success).toBe(false);
    expect(ScreenVariableValue.safeParse("x".repeat(201)).success).toBe(false);
  });

  test("quotes / < / javascript: are allowed as DATA — the substituter neutralises them per context", () => {
    expect(ScreenVariableValue.safeParse(`O'Brien's <lobby>`).success).toBe(true);
    expect(ScreenVariableValue.safeParse("javascript:alert(1)").success).toBe(true);
  });

  test("the map is capped", () => {
    const many = Object.fromEntries([...Array(33)].map((_, i) => [`k${i}`, "v"]));
    expect(ScreenVariables.safeParse(many).success).toBe(false);
  });
});
