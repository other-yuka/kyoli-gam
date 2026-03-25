import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  applyAnthropicTokenRequestOverrides,
  loginWithPiAi,
  resetAnthropicTokenProxyStateForTest,
  rewriteAnthropicAuthUrl,
  withAnthropicTokenProxyFetch,
} from "../src/pi-ai-adapter";
import {
  ANTHROPIC_AUTHORIZE_ENDPOINT,
  ANTHROPIC_CLIENT_ID,
  ANTHROPIC_REDIRECT_URI,
  ANTHROPIC_SCOPES,
  ANTHROPIC_TOKEN_ENDPOINT,
} from "../src/constants";
import {
  setNodeTokenRequestRunnerForTest,
  type NodeTokenRequestOptions,
} from "../src/token-node-request";
import * as piAiOauth from "@mariozechner/pi-ai/oauth";
import * as usageModule from "../src/usage";

describe("pi-ai-adapter token endpoint proxy", () => {
  let originalFetch: typeof globalThis.fetch;

  function installPassthroughFetch(): ReturnType<typeof vi.fn> {
    const passthroughFetch = vi.fn(async () => new Response("outside", { status: 200 }));
    globalThis.fetch = passthroughFetch as unknown as typeof globalThis.fetch;
    return passthroughFetch;
  }

  function createTokenRequest(body: ReadableStream<Uint8Array>): Request {
    return new Request(
      "https://platform.claude.com/v1/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        duplex: "half",
      } as RequestInit,
    );
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAnthropicTokenProxyStateForTest();
    setNodeTokenRequestRunnerForTest(null);
    vi.restoreAllMocks();
  });

  test("proxy routes token endpoint requests through external node process", async () => {
    const runnerSpy = vi.fn(async (options: NodeTokenRequestOptions) => {
      expect(options.endpoint).toBe("https://platform.claude.com/v1/oauth/token");
      expect(typeof options.body).toBe("string");
      if (options.body.trim().startsWith("{")) {
        const parsed = JSON.parse(options.body) as {
          client_id?: string;
          redirect_uri?: string;
          scope?: string;
        };
        expect(parsed.client_id).toBe(ANTHROPIC_CLIENT_ID);
        expect(parsed.redirect_uri).toBe(ANTHROPIC_REDIRECT_URI);
        expect(parsed.scope).toBe(ANTHROPIC_SCOPES);
      } else {
        const params = new URLSearchParams(options.body);
        expect(params.get("client_id")).toBe(ANTHROPIC_CLIENT_ID);
        expect(params.get("redirect_uri")).toBe(ANTHROPIC_REDIRECT_URI);
        expect(params.get("scope")).toBe(ANTHROPIC_SCOPES);
      }

      return JSON.stringify({
        ok: true,
        body: JSON.stringify({
          access_token: "next-access",
          refresh_token: "next-refresh",
          expires_in: 3600,
        }),
      });
    });
    setNodeTokenRequestRunnerForTest(runnerSpy);

    const passthroughFetch = installPassthroughFetch();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          grant_type: "authorization_code",
          client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
          code: "auth-code",
        })));
        controller.close();
      },
    });

    const tokenRequest = createTokenRequest(stream);

    const response = await withAnthropicTokenProxyFetch(async () => {
      const tokenResponse = await fetch(tokenRequest);

      const unrelatedResponse = await fetch("https://example.com/health");
      expect(unrelatedResponse.status).toBe(200);
      return tokenResponse;
    });

    const result = await response.json() as {
      access_token: string;
      refresh_token: string;
    };

    expect(result.access_token).toBe("next-access");
    expect(result.refresh_token).toBe("next-refresh");
    expect(runnerSpy).toHaveBeenCalledTimes(1);
    expect(passthroughFetch).toHaveBeenCalledTimes(1);
  });

  test("proxy does not affect token endpoint requests outside auth context", async () => {
    const runnerSpy = vi.fn(async () => JSON.stringify({ ok: true, body: "{}" }));
    setNodeTokenRequestRunnerForTest(runnerSpy);

    const passthroughFetch = installPassthroughFetch();

    const response = await fetch("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    });

    expect(response.status).toBe(200);
    expect(runnerSpy).toHaveBeenCalledTimes(0);
    expect(passthroughFetch).toHaveBeenCalledTimes(1);
  });

  test("proxy surfaces node-runner failures", async () => {
    setNodeTokenRequestRunnerForTest(async () => JSON.stringify({
      ok: false,
      status: 429,
      body: JSON.stringify({
        error: { type: "rate_limit_error", message: "Rate limited. Please try again later." },
      }),
    }));

    let thrown: unknown;
    try {
      await withAnthropicTokenProxyFetch(async () => {
        await fetch("https://platform.claude.com/v1/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            refresh_token: "current-refresh",
          }),
        });
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("status=429");
  });

  test("proxy uses adapter token endpoint as source-of-truth, not a hardcoded URL", async () => {
    const runnerSpy = vi.fn(async (options: NodeTokenRequestOptions) => {
      expect(options.endpoint).toBe(ANTHROPIC_TOKEN_ENDPOINT);
      return JSON.stringify({
        ok: true,
        body: JSON.stringify({
          access_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
          expires_in: 3600,
        }),
      });
    });
    setNodeTokenRequestRunnerForTest(runnerSpy);

    installPassthroughFetch();

    const response = await withAnthropicTokenProxyFetch(async () => {
      return await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "tok" }),
      });
    });

    const result = await response.json() as { access_token: string };
    expect(result.access_token).toBe("refreshed-access");
    expect(runnerSpy).toHaveBeenCalledTimes(1);
  });

  test("rewriteAnthropicAuthUrl uses configured authorize endpoint and oauth params", () => {
    const rewritten = rewriteAnthropicAuthUrl("https://claude.ai/oauth/authorize?state=abc&scope=old");
    const parsed = new URL(rewritten);
    const configured = new URL(ANTHROPIC_AUTHORIZE_ENDPOINT);

    expect(parsed.origin).toBe(configured.origin);
    expect(parsed.pathname).toBe(configured.pathname);
    expect(parsed.searchParams.get("state")).toBe("abc");
    expect(parsed.searchParams.get("client_id")).toBe(ANTHROPIC_CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe(ANTHROPIC_REDIRECT_URI);
    expect(parsed.searchParams.get("scope")).toBe(ANTHROPIC_SCOPES);
  });

  test("applyAnthropicTokenRequestOverrides rewrites oauth body fields for authorization code exchange", () => {
    const overridden = applyAnthropicTokenRequestOverrides(new URLSearchParams({
      grant_type: "authorization_code",
      code: "auth-code",
      client_id: "old-client",
      redirect_uri: "https://old.example/callback",
      scope: "old-scope",
    }).toString());

    const params = new URLSearchParams(overridden);
    expect(params.get("client_id")).toBe(ANTHROPIC_CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(ANTHROPIC_REDIRECT_URI);
    expect(params.get("scope")).toBe(ANTHROPIC_SCOPES);
  });

  test("loginWithPiAi forwards rewritten auth url through onAuth callback", async () => {
    const onAuthSpy = vi.fn();
    const loginSpy = vi.spyOn(piAiOauth, "loginAnthropic").mockImplementation(async ({ onAuth }) => {
      onAuth({
        url: "https://claude.ai/oauth/authorize?state=xyz&client_id=legacy",
        instructions: "continue",
      });

      return {
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3_600_000,
      };
    });
    const profileSpy = vi.spyOn(usageModule, "fetchProfile").mockResolvedValue({
      ok: true,
      data: { email: "user@example.com", planTier: "pro" },
    });

    await loginWithPiAi({
      onAuth: onAuthSpy,
      onPrompt: async () => "",
    });

    const authInfo = onAuthSpy.mock.calls[0]?.[0] as { url: string };
    const parsed = new URL(authInfo.url);
    expect(parsed.searchParams.get("client_id")).toBe(ANTHROPIC_CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe(ANTHROPIC_REDIRECT_URI);
    expect(parsed.searchParams.get("scope")).toBe(ANTHROPIC_SCOPES);

    loginSpy.mockRestore();
    profileSpy.mockRestore();
  });
});
