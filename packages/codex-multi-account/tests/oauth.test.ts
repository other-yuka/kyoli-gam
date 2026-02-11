import { describe, test, expect, afterEach } from "vitest";
import {
  generatePKCE,
  generateState,
  parseJwtClaims,
  extractAccountId,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
} from "../src/oauth";
import { OPENAI_CLIENT_ID, OAUTH_ISSUER } from "../src/constants";
import { buildFakeJwt, createTokenResponse } from "./helpers";

// ─── generatePKCE ────────────────────────────────────────────────

describe("generatePKCE", () => {
  test("verifier has length 64", async () => {
    const { verifier } = await generatePKCE();
    expect(verifier).toHaveLength(64);
  });

  test("verifier uses only unreserved URI characters", async () => {
    const { verifier } = await generatePKCE();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("challenge is base64url encoded (no +, /, =)", async () => {
    const { challenge } = await generatePKCE();
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
    expect(challenge).not.toContain("=");
    expect(challenge.length).toBeGreaterThan(0);
  });

  test("challenge is SHA-256 digest of verifier", async () => {
    const { verifier, challenge } = await generatePKCE();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const bytes = new Uint8Array(digest);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    const expected = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(challenge).toBe(expected);
  });
});

// ─── generateState ───────────────────────────────────────────────

describe("generateState", () => {
  test("returns a non-empty string", () => {
    const state = generateState();
    expect(state.length).toBeGreaterThan(0);
  });

  test("returns base64url characters only", () => {
    const state = generateState();
    expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  test("each call returns a different value", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});

// ─── parseJwtClaims ──────────────────────────────────────────────

describe("parseJwtClaims", () => {
  test("parses valid JWT payload", () => {
    const token = buildFakeJwt({ sub: "user-123", email: "a@b.com" });
    const claims = parseJwtClaims(token);
    expect(claims).toBeDefined();
    expect(claims!.email).toBe("a@b.com");
    expect((claims as Record<string, unknown>).sub).toBe("user-123");
  });

  test("returns undefined for empty string", () => {
    expect(parseJwtClaims("")).toBeUndefined();
  });

  test("returns undefined for token without dots", () => {
    expect(parseJwtClaims("nodots")).toBeUndefined();
  });

  test("returns undefined for token with only one dot", () => {
    expect(parseJwtClaims("header.")).toBeUndefined();
  });

  test("returns undefined for invalid base64 payload", () => {
    expect(parseJwtClaims("aaa.!!!.ccc")).toBeUndefined();
  });

  test("returns undefined for non-JSON payload", () => {
    const notJson = Buffer.from("not json at all").toString("base64url");
    expect(parseJwtClaims(`header.${notJson}.sig`)).toBeUndefined();
  });
});

// ─── extractAccountId ────────────────────────────────────────────

describe("extractAccountId", () => {
  test("extracts chatgpt_account_id from id_token", () => {
    const id_token = buildFakeJwt({ chatgpt_account_id: "acct-direct" });
    const access_token = buildFakeJwt({});
    expect(extractAccountId({ id_token, access_token })).toBe("acct-direct");
  });

  test("falls back to https://api.openai.com/auth claim", () => {
    const id_token = buildFakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" },
    });
    const access_token = buildFakeJwt({});
    expect(extractAccountId({ id_token, access_token })).toBe("acct-nested");
  });

  test("falls back to organizations[0].id", () => {
    const id_token = buildFakeJwt({
      organizations: [{ id: "org-123" }],
    });
    const access_token = buildFakeJwt({});
    expect(extractAccountId({ id_token, access_token })).toBe("org-123");
  });

  test("falls back to access_token when id_token missing", () => {
    const access_token = buildFakeJwt({ chatgpt_account_id: "acct-from-at" });
    expect(extractAccountId({ access_token })).toBe("acct-from-at");
  });

  test("falls back to access_token when id_token has no account info", () => {
    const id_token = buildFakeJwt({ email: "user@example.com" });
    const access_token = buildFakeJwt({ chatgpt_account_id: "acct-at-fallback" });
    expect(extractAccountId({ id_token, access_token })).toBe("acct-at-fallback");
  });

  test("returns undefined when no claims found", () => {
    const access_token = buildFakeJwt({ email: "nobody@example.com" });
    expect(extractAccountId({ access_token })).toBeUndefined();
  });
});

// ─── buildAuthorizeUrl ───────────────────────────────────────────

describe("buildAuthorizeUrl", () => {
  const redirectUri = "http://localhost:1455/auth/callback";
  const pkce = { challenge: "test-challenge-value" };
  const state = "test-state-value";

  test("starts with correct issuer authorize endpoint", () => {
    const url = buildAuthorizeUrl(redirectUri, pkce, state);
    expect(url.startsWith(`${OAUTH_ISSUER}/oauth/authorize`)).toBe(true);
  });

  test("contains response_type=code", () => {
    const url = new URL(buildAuthorizeUrl(redirectUri, pkce, state));
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  test("contains correct client_id", () => {
    const url = new URL(buildAuthorizeUrl(redirectUri, pkce, state));
    expect(url.searchParams.get("client_id")).toBe(OPENAI_CLIENT_ID);
  });

  test("contains redirect_uri, scope, code_challenge, state, originator", () => {
    const url = new URL(buildAuthorizeUrl(redirectUri, pkce, state));
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(url.searchParams.get("code_challenge")).toBe("test-challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("test-state-value");
    expect(url.searchParams.get("originator")).toBe("opencode");
  });
});

// ─── exchangeCodeForTokens ───────────────────────────────────────

describe("exchangeCodeForTokens", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends POST to token endpoint with correct form body", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedInit = init;
      return createTokenResponse({
        access_token: "at-123",
        expires_in: 3600,
      });
    };

    const pkce = { verifier: "test-verifier", challenge: "test-challenge" };
    await exchangeCodeForTokens("auth-code-xyz", "http://localhost/cb", pkce);

    expect(capturedUrl).toBe(`${OAUTH_ISSUER}/oauth/token`);
    expect(capturedInit?.method).toBe("POST");

    const body = capturedInit?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-xyz");
    expect(body.get("redirect_uri")).toBe("http://localhost/cb");
    expect(body.get("client_id")).toBe(OPENAI_CLIENT_ID);
    expect(body.get("code_verifier")).toBe("test-verifier");
  });

  test("throws on non-OK response", async () => {
    globalThis.fetch = async () => createTokenResponse({}, 401);

    const pkce = { verifier: "v", challenge: "c" };
    await expect(
      exchangeCodeForTokens("code", "http://localhost/cb", pkce),
    ).rejects.toThrow("Token request failed: 401");
  });
});

// ─── refreshAccessToken ──────────────────────────────────────────

describe("refreshAccessToken", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends POST to token endpoint with refresh_token grant", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return createTokenResponse({
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_in: 7200,
      });
    };

    const result = await refreshAccessToken("old-refresh-token");

    const body = capturedInit?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh-token");
    expect(body.get("client_id")).toBe(OPENAI_CLIENT_ID);
    expect(result.access_token).toBe("new-at");
    expect(result.expires_in).toBe(7200);
  });

  test("throws on non-OK response", async () => {
    globalThis.fetch = async () => createTokenResponse({}, 403);

    await expect(refreshAccessToken("bad-token")).rejects.toThrow(
      "Token request failed: 403",
    );
  });

  test("sends Content-Type application/x-www-form-urlencoded", async () => {
    let capturedHeaders: HeadersInit | undefined;

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return createTokenResponse({
        access_token: "at",
        expires_in: 100,
      });
    };

    await refreshAccessToken("rt");

    const headers = capturedHeaders as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });
});
