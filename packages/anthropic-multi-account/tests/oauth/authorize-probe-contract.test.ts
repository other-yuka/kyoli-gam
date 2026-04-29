import { describe, expect, test } from "bun:test";
import { classifyAuthorizeResponse, REJECT_MARKER } from "../../scripts/_authorize-probe-classifier.mjs";
import {
  AUTHORIZE_PROBE_BASE_SCOPES,
  AUTHORIZE_PROBE_CONFIG,
  AUTHORIZE_PROBE_EXPANDED_SCOPES,
  AUTHORIZE_PROBE_EXCLUDED_EXPANDED_SCOPE,
  AUTHORIZE_PROBE_PKCE_CHALLENGE_METHOD,
  AUTHORIZE_PROBE_REDIRECT_URI,
  buildAuthorizeProbePayload,
  buildAuthorizeUrl,
  deriveExpandedScopes,
  summarizeAuthorizeProbeVerdicts,
} from "../../scripts/_authorize-probe-contract.mjs";

const FIXED_CHECKED_AT = "2026-04-25T00:00:00.000Z";
const FIXED_STATE = "fixed-state";
const FIXED_CODE_CHALLENGE = "fixed-code-challenge";
const PAYLOAD_KEYS = ["baseVerdict", "checkedAt", "drifted", "expandedVerdict", "message"];
const BASE64URL_32_BYTE_LENGTH = 43;

const responseFixtures = [
  {
    name: "redirect location is accepted",
    response: { status: 302, location: "http://127.0.0.1:45454/callback?code=ok", bodyText: "" },
    expectedVerdict: "accepted",
  },
  {
    name: "reject marker on an error response is rejected",
    response: { status: 400, location: null, bodyText: REJECT_MARKER },
    expectedVerdict: "rejected",
  },
  {
    name: "missing redirect and reject marker is inconclusive",
    response: { status: 200, location: null, bodyText: "sign in" },
    expectedVerdict: "inconclusive",
  },
] as const;

const verdictFixtures = [
  {
    baseVerdict: "accepted",
    expandedVerdict: "rejected",
    expected: {
      drifted: false,
      message: "authorize scope behavior matches expected policy",
    },
  },
  {
    baseVerdict: "accepted",
    expandedVerdict: "accepted",
    expected: {
      drifted: false,
      message: "authorize policy is more permissive than expected but pinned 6-scope remains accepted",
    },
  },
  {
    baseVerdict: "rejected",
    expandedVerdict: "accepted",
    expected: {
      drifted: true,
      message: "pinned 6-scope fallback is no longer accepted",
    },
  },
  {
    baseVerdict: "inconclusive",
    expandedVerdict: "rejected",
    expected: {
      drifted: false,
      message: "authorize probe inconclusive (inconclusive/rejected)",
    },
  },
] as const;

describe("authorize probe contract", () => {
  test("defines base and expanded scopes from the same fallback contract", () => {
    const baseScopeItems = AUTHORIZE_PROBE_BASE_SCOPES.split(" ");
    const expandedScopeItems = AUTHORIZE_PROBE_EXPANDED_SCOPES.split(" ");
    const expectedExpandedScopeItems = baseScopeItems.filter((scope) => scope !== AUTHORIZE_PROBE_EXCLUDED_EXPANDED_SCOPE);

    expect(AUTHORIZE_PROBE_BASE_SCOPES).toBe(AUTHORIZE_PROBE_CONFIG.scopes);
    expect(baseScopeItems).toHaveLength(6);
    expect(baseScopeItems).toContain(AUTHORIZE_PROBE_EXCLUDED_EXPANDED_SCOPE);
    expect(expandedScopeItems).toEqual(expectedExpandedScopeItems);
    expect(expandedScopeItems).not.toContain(AUTHORIZE_PROBE_EXCLUDED_EXPANDED_SCOPE);
    expect(deriveExpandedScopes(AUTHORIZE_PROBE_BASE_SCOPES)).toBe(AUTHORIZE_PROBE_EXPANDED_SCOPES);
  });

  test("builds authorize URL params semantically", () => {
    const url = buildAuthorizeUrl(AUTHORIZE_PROBE_BASE_SCOPES, {
      state: FIXED_STATE,
      codeChallenge: FIXED_CODE_CHALLENGE,
    });

    expect(url.origin + url.pathname).toBe(AUTHORIZE_PROBE_CONFIG.authorizeUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(AUTHORIZE_PROBE_CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(AUTHORIZE_PROBE_REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(AUTHORIZE_PROBE_BASE_SCOPES);
    expect(url.searchParams.get("state")).toBe(FIXED_STATE);
    expect(url.searchParams.get("code_challenge")).toBe(FIXED_CODE_CHALLENGE);
    expect(url.searchParams.get("code_challenge_method")).toBe(AUTHORIZE_PROBE_PKCE_CHALLENGE_METHOD);
  });

  test("builds authorize URLs with a 32-byte state", () => {
    const url = buildAuthorizeUrl(AUTHORIZE_PROBE_BASE_SCOPES);
    const state = url.searchParams.get("state") ?? "";

    expect(state).toHaveLength(BASE64URL_32_BYTE_LENGTH);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  for (const { name, response, expectedVerdict } of responseFixtures) {
    test(`classifies authorize responses: ${name}`, () => {
      expect(classifyAuthorizeResponse(response.status, response.location, response.bodyText)).toBe(expectedVerdict);
    });
  }

  for (const { baseVerdict, expandedVerdict, expected } of verdictFixtures) {
    test(`summarizes ${baseVerdict}/${expandedVerdict} verdicts`, () => {
      expect(summarizeAuthorizeProbeVerdicts(baseVerdict, expandedVerdict)).toEqual(expected);
    });
  }

  test("builds the exact public JSON payload shape", () => {
    const payload = buildAuthorizeProbePayload({
      checkedAt: FIXED_CHECKED_AT,
      baseVerdict: "accepted",
      expandedVerdict: "rejected",
    });

    expect(Object.keys(payload).sort()).toEqual(PAYLOAD_KEYS);
    expect(payload).toEqual({
      checkedAt: FIXED_CHECKED_AT,
      baseVerdict: "accepted",
      expandedVerdict: "rejected",
      drifted: false,
      message: "authorize scope behavior matches expected policy",
    });
  });
});
