import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  FALLBACK,
  resetOAuthConfigDetectionForTest,
  scanBinaryForOAuthConfig,
  setOAuthConfigDetectionOverridesForTest,
} from "../src/oauth-config-detect";
import { base64url, generatePKCE, generateState } from "../src/oauth-pkce";
import { startCallbackServer } from "../src/oauth-callback-server";
import {
  anthropicOAuthTestExports,
  detectOAuthConfig,
  loginWithOAuth,
  refreshWithOAuth,
  type LoginCallbacks,
  type LoginResult,
} from "../src/anthropic-oauth";
import { getUserAgent } from "../src/model-config";
import { runNodeTokenRequest, setNodeTokenRequestRunnerForTest } from "../src/token-node-request";
import { setupTestEnv } from "./helpers";

const EXISTING_SMALL_FILE = import.meta.dir + "/helpers.ts";

describe("anthropic-oauth", () => {
  afterEach(() => {
    resetOAuthConfigDetectionForTest();
    setOAuthConfigDetectionOverridesForTest(null);
    anthropicOAuthTestExports.setCallbackServerStarterForTest(null);
    anthropicOAuthTestExports.setBrowserExecForTest(null);
    anthropicOAuthTestExports.setProfileFetcherForTest(null);
    anthropicOAuthTestExports.setUsageFetcherForTest(null);
    setNodeTokenRequestRunnerForTest(null);
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    setNodeTokenRequestRunnerForTest(null);
  });

  describe("token-node-request", () => {
    function createExecFileMock(): typeof childProcess.execFile {
      return ((...callArgs: unknown[]) => {
        const callback = callArgs[3] as
          | ((error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void)
          | undefined;

        callback?.(null, JSON.stringify({ ok: true, body: "{}" }), "");
        return {} as childProcess.ChildProcess;
      }) as unknown as typeof childProcess.execFile;
    }

    test("defaults Content-Type to application/json in subprocess env and script", async () => {
      const execFileSpy = vi.spyOn(childProcess, "execFile").mockImplementation(createExecFileMock());

      await runNodeTokenRequest({
        body: JSON.stringify({ grant_type: "authorization_code" }),
        endpoint: "https://platform.claude.com/v1/oauth/token",
        executable: "node",
        timeoutMs: 30_000,
      });

      expect(execFileSpy).toHaveBeenCalledTimes(1);
      const [, args, options] = execFileSpy.mock.calls[0] ?? [];
      const script = args?.[1];
      const env = options?.env;

      expect(args?.[0]).toBe("-e");
      expect(typeof script).toBe("string");
      expect(script).toContain('process.env.ANTHROPIC_REFRESH_CONTENT_TYPE || "application/json"');
      expect(script).toContain('"Content-Type": contentType');
      expect(env?.ANTHROPIC_REFRESH_CONTENT_TYPE).toBe("application/json");
    });

    test("passes application/x-www-form-urlencoded Content-Type to subprocess env", async () => {
      const execFileSpy = vi.spyOn(childProcess, "execFile").mockImplementation(createExecFileMock());

      await runNodeTokenRequest({
        body: "grant_type=refresh_token&refresh_token=current-refresh",
        contentType: "application/x-www-form-urlencoded",
        endpoint: "https://platform.claude.com/v1/oauth/token",
        executable: "node",
        timeoutMs: 30_000,
      });

      expect(execFileSpy).toHaveBeenCalledTimes(1);
      const [, , options] = execFileSpy.mock.calls[0] ?? [];

      expect(options?.env?.ANTHROPIC_REFRESH_CONTENT_TYPE).toBe("application/x-www-form-urlencoded");
    });

    test("passes User-Agent through to subprocess env and script when provided", async () => {
      const execFileSpy = vi.spyOn(childProcess, "execFile").mockImplementation(createExecFileMock());

      await runNodeTokenRequest({
        body: JSON.stringify({ grant_type: "authorization_code" }),
        endpoint: "https://platform.claude.com/v1/oauth/token",
        executable: "node",
        timeoutMs: 30_000,
        userAgent: getUserAgent(),
      });

      expect(execFileSpy).toHaveBeenCalledTimes(1);
      const [, args, options] = execFileSpy.mock.calls[0] ?? [];
      const script = args?.[1];
      const env = options?.env;

      expect(typeof script).toBe("string");
      expect(script).toContain('const userAgent = process.env.ANTHROPIC_REFRESH_USER_AGENT;');
      expect(script).toContain('...(userAgent ? { "User-Agent": userAgent } : {}),');
      expect(env?.ANTHROPIC_REFRESH_USER_AGENT).toBe(getUserAgent());
    });
  });

  describe("PKCE", () => {
    test("encodes buffers as base64url without padding", () => {
      expect(base64url(Buffer.from([251, 255, 190]))).toBe("-_--");
    });

    test("known-vector: RFC 7636 Appendix B verifier produces the expected challenge", () => {
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

      const challenge = base64url(createHash("sha256").update(verifier).digest());
      expect(challenge).toBe(expectedChallenge);
    });

    test("generatePKCE returns a verifier and matching challenge", () => {
      const pkce = generatePKCE();

      expect(pkce.verifier).toBeString();
      expect(pkce.verifier.length).toBeGreaterThan(0);
      expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(pkce.challenge).toBe(base64url(createHash("sha256").update(pkce.verifier).digest()));
    });

    test("generateState returns non-empty, distinct strings", () => {
      const a = generateState();
      const b = generateState();

      expect(a).toBeString();
      expect(a.length).toBeGreaterThan(0);
      expect(b).toBeString();
      expect(b.length).toBeGreaterThan(0);
      expect(a).not.toBe(b);
    });
  });

  describe("detectOAuthConfig", () => {
    test("removes org:create_api_key from fallback scopes", () => {
      expect(FALLBACK.scopes).toBe("user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload");
      expect(FALLBACK.scopes).not.toContain("org:create_api_key");
    });

    test("returns FALLBACK when binary not found", async () => {
      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => null,
      });

      const config = await detectOAuthConfig();
      expect(config).toEqual(FALLBACK);
      expect(config.source).toBe("fallback");
      expect(config.baseApiUrl).toBe("https://api.anthropic.com");
    });

    test("prefers non-local config block over local development-style candidates", () => {
      const localBlock = 'BASE_API_URL:"http://localhost:3000" CLIENT_ID:"22222222-2222-4222-8222-222222222222" CLAUDE_AI_AUTHORIZE_URL:"http://localhost:3000/oauth/authorize" TOKEN_URL:"http://localhost:3000/oauth/token" SCOPES:"scope:local"';
      const prodBlock = 'BASE_API_URL:"https://api.anthropic.com" CLIENT_ID:"11111111-1111-4111-8111-111111111111" CLAUDE_AI_AUTHORIZE_URL:"https://claude.com/cai/oauth/authorize" TOKEN_URL:"https://platform.claude.com/v1/oauth/token" SCOPES:"org:create_api_key user:profile user:inference user:sessions:claude_code"';
      const buf = Buffer.from(`${localBlock} ${prodBlock}`);

      expect(scanBinaryForOAuthConfig(buf)).toMatchObject({
        clientId: "11111111-1111-4111-8111-111111111111",
        baseApiUrl: "https://api.anthropic.com",
      });
    });

    test("extracts scopes from the production binary block when present", () => {
      const buf = Buffer.from('CLIENT_ID:"11111111-1111-4111-8111-111111111111" CLAUDE_AI_AUTHORIZE_URL:"https://claude.com/cai/oauth/authorize" TOKEN_URL:"https://platform.claude.com/v1/oauth/token" SCOPES:"scope:a scope:b" BASE_API_URL:"https://api.anthropic.com"');

      expect(scanBinaryForOAuthConfig(buf)).toMatchObject({
        baseApiUrl: "https://api.anthropic.com",
        scopes: "scope:a scope:b",
      });
    });

    test("falls back to safe scopes when scanned scopes contain org:create_api_key", () => {
      const buf = Buffer.from('CLIENT_ID:"11111111-1111-4111-8111-111111111111" CLAUDE_AI_AUTHORIZE_URL:"https://claude.com/cai/oauth/authorize" TOKEN_URL:"https://platform.claude.com/v1/oauth/token" SCOPES:"org:create_api_key user:profile user:inference user:sessions:claude_code" BASE_API_URL:"https://api.anthropic.com"');

      expect(scanBinaryForOAuthConfig(buf)).toMatchObject({
        baseApiUrl: "https://api.anthropic.com",
        scopes: FALLBACK.scopes,
      });
    });

    test("keeps scopes aligned with the selected production client block when multiple blocks are mixed", () => {
      const localBlock = 'BASE_API_URL:"http://localhost:3000" TOKEN_URL:"http://localhost:3000/oauth/token" CLIENT_ID:"22222222-2222-4222-8222-222222222222" SCOPES:"scope:local"';
      const prodBlock = 'TOKEN_URL:"https://platform.claude.com/v1/oauth/token" CLIENT_ID:"11111111-1111-4111-8111-111111111111" SCOPES:"scope:prod user:sessions:claude_code" BASE_API_URL:"https://api.anthropic.com"';
      const buf = Buffer.from(`${localBlock} ${prodBlock}`);

      expect(scanBinaryForOAuthConfig(buf)).toMatchObject({
        clientId: "11111111-1111-4111-8111-111111111111",
        baseApiUrl: "https://api.anthropic.com",
        scopes: "scope:prod user:sessions:claude_code",
      });
    });

    test("does not form a hybrid candidate from adjacent local and production blocks", () => {
      const localBlock = 'BASE_API_URL:"http://localhost:3000" CLIENT_ID:"22222222-2222-4222-8222-222222222222"';
      const prodBlock = 'TOKEN_URL:"https://platform.claude.com/v1/oauth/token" CLIENT_ID:"11111111-1111-4111-8111-111111111111" BASE_API_URL:"https://api.anthropic.com" SCOPES:"scope:prod user:sessions:claude_code"';
      const buf = Buffer.from(`${localBlock} ${prodBlock}`);

      expect(scanBinaryForOAuthConfig(buf)).toMatchObject({
        clientId: "11111111-1111-4111-8111-111111111111",
        tokenUrl: "https://platform.claude.com/v1/oauth/token",
        baseApiUrl: "https://api.anthropic.com",
        scopes: "scope:prod user:sessions:claude_code",
      });
    });

    test("never throws on filesystem error (EACCES-like)", async () => {
      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => "/nonexistent/path/eacces-sim",
      });

      const config = await detectOAuthConfig();
      expect(config.source).toBe("fallback");
    });

    test("silently falls back when the binary cannot be read", async () => {
      const { dir, cleanup } = await setupTestEnv();

      try {
        const ccPath = `${dir}/claude`;
        await Bun.write(ccPath, "fake claude binary");

        setOAuthConfigDetectionOverridesForTest({
          findCCBinary: () => ccPath,
          readBinaryFile: async () => {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          },
        });

        const detected = await detectOAuthConfig();

        expect(detected.source).toBe("fallback");
        expect(detected.clientId).toBe(FALLBACK.clientId);
        expect(detected.tokenUrl).toBe(FALLBACK.tokenUrl);
      } finally {
        await cleanup();
      }
    });

    test("never throws on malformed binary buffer", async () => {
      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => EXISTING_SMALL_FILE,
        readBinaryFile: async () => Buffer.from("garbage data no config anchor"),
      });

      const config = await detectOAuthConfig();
      expect(config.source).toBe("fallback");
    });
  });

  describe("callback server", () => {
    test("returns code and state on matching callback", async () => {
      const expectedState = "correct-state-abc";
      const { port, waitForCode } = await startCallbackServer({ expectedState });

      const response = await fetch(
        `http://localhost:${port}/callback?code=auth-code-xyz&state=${expectedState}`,
        { redirect: "manual" },
      );

      expect(response.status).toBe(302);

      const result = await waitForCode;
      expect(result.code).toBe("auth-code-xyz");
      expect(result.state).toBe(expectedState);
    });

    test("rejects on state mismatch", async () => {
      const { port, waitForCode } = await startCallbackServer({
        expectedState: "expected-state",
      });
      waitForCode.catch(() => {});

      const response = await fetch(
        `http://localhost:${port}/callback?code=auth-code&state=wrong-state`,
        { redirect: "manual" },
      );

      expect(response.status).toBe(400);

      let thrown: unknown;
      try {
        await waitForCode;
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("state mismatch");
    });

    test("rejects on missing code", async () => {
      const { port, waitForCode } = await startCallbackServer({
        expectedState: "expected-state",
      });
      waitForCode.catch(() => {});

      const response = await fetch(
        `http://localhost:${port}/callback?state=expected-state`,
        { redirect: "manual" },
      );

      expect(response.status).toBe(400);

      let thrown: unknown;
      try {
        await waitForCode;
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("missing code");
    });

    test("returns 404 for non-callback paths", async () => {
      const { port, waitForCode, stop } = await startCallbackServer({
        expectedState: "expected-state",
      });
      waitForCode.catch(() => {});

      const response = await fetch(`http://localhost:${port}/other`);
      expect(response.status).toBe(404);

      stop();
    });

    test("rejects on timeout", async () => {
      const { waitForCode } = await startCallbackServer({
        expectedState: "unreachable",
        timeoutMs: 50,
      });
      waitForCode.catch(() => {});

      let thrown: unknown;
      try {
        await waitForCode;
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("timed out");
    });

    test("stop is idempotent", async () => {
      const { waitForCode, stop } = await startCallbackServer({
        expectedState: "expected-state",
      });
      waitForCode.catch(() => {});

      expect(() => {
        stop();
        stop();
        stop();
      }).not.toThrow();
    });

    test("uses a dynamic port for each server", async () => {
      const server1 = await startCallbackServer({ expectedState: "a" });
      server1.waitForCode.catch(() => {});
      const server2 = await startCallbackServer({ expectedState: "b" });
      server2.waitForCode.catch(() => {});

      expect(server1.port).toBeGreaterThan(0);
      expect(server2.port).toBeGreaterThan(0);
      expect(server1.port).not.toBe(server2.port);

      server1.stop();
      server2.stop();
    });
  });

  test("openBrowser selects the correct platform command", () => {
    expect(anthropicOAuthTestExports.getOpenBrowserCommand("http://localhost:12345", "darwin")).toBe(
      'open "http://localhost:12345"',
    );
    expect(anthropicOAuthTestExports.getOpenBrowserCommand("http://localhost:12345", "win32")).toBe(
      'start "" "http://localhost:12345"',
    );
    expect(anthropicOAuthTestExports.getOpenBrowserCommand("http://localhost:12345", "linux")).toBe(
      'xdg-open "http://localhost:12345"',
    );
  });

  test("openBrowser never throws when browser launch fails", () => {
    anthropicOAuthTestExports.setBrowserExecForTest((_command, callback) => {
      callback?.(new Error("launch failed"));
    });

    expect(() => anthropicOAuthTestExports.openBrowser("http://localhost:12345")).not.toThrow();
  });

  test("LoginCallbacks and LoginResult expose only the shared T6 auth surface", () => {
    const callbacks: LoginCallbacks = {
      onAuth: () => {},
      onProgress: () => {},
    };
    const result: LoginResult = {
      email: "user@example.com",
      refreshToken: "refresh-token",
    };

    expect(typeof callbacks.onAuth).toBe("function");
    expect(typeof callbacks.onProgress).toBe("function");
    expect(result.email).toBe("user@example.com");
    expect(result.refreshToken).toBe("refresh-token");
  });

  test("postTokenEndpoint passes Content-Type through to the subprocess helper", async () => {
    setOAuthConfigDetectionOverridesForTest({
      findCCBinary: () => null,
    });

    let receivedContentType: string | undefined;
    let receivedEndpoint: string | undefined;
    setNodeTokenRequestRunnerForTest(async (options) => {
      receivedContentType = options.contentType;
      receivedEndpoint = options.endpoint;

      return JSON.stringify({
        ok: true,
        body: JSON.stringify({
          access_token: "next-access",
          refresh_token: "next-refresh",
          expires_in: 3600,
        }),
      });
    });

    await anthropicOAuthTestExports.postTokenEndpoint(
      "application/x-www-form-urlencoded",
      "grant_type=authorization_code&code=auth-code",
    );

    expect(receivedContentType).toBe("application/x-www-form-urlencoded");
    expect(receivedEndpoint).toBe("https://platform.claude.com/v1/oauth/token");
  });

  test("postTokenEndpoint forwards the Claude CLI User-Agent to the subprocess helper", async () => {
    setOAuthConfigDetectionOverridesForTest({
      findCCBinary: () => null,
    });

    let receivedUserAgent: string | undefined;
    setNodeTokenRequestRunnerForTest(async (options) => {
      receivedUserAgent = options.userAgent;

      return JSON.stringify({
        ok: true,
        body: JSON.stringify({
          access_token: "next-access",
          refresh_token: "next-refresh",
          expires_in: 3600,
        }),
      });
    });

    await anthropicOAuthTestExports.postTokenEndpoint(
      "application/json",
      JSON.stringify({ grant_type: "authorization_code" }),
    );

      expect(receivedUserAgent).toBe(getUserAgent());
  });

  test("postTokenEndpoint parses a valid token response via TokenResponseSchema", async () => {
    setOAuthConfigDetectionOverridesForTest({
      findCCBinary: () => null,
    });

    setNodeTokenRequestRunnerForTest(async () => JSON.stringify({
      ok: true,
      body: JSON.stringify({
        access_token: "next-access",
        refresh_token: "next-refresh",
        expires_in: 3600,
        account: {
          uuid: "acct-123",
          email_address: "user@example.com",
        },
      }),
    }));

    const result = await anthropicOAuthTestExports.postTokenEndpoint(
      "application/json",
      JSON.stringify({ grant_type: "refresh_token" }),
    );

    expect(result).toEqual({
      access_token: "next-access",
      refresh_token: "next-refresh",
      expires_in: 3600,
      account: {
        uuid: "acct-123",
        email_address: "user@example.com",
      },
    });
  });

  test("postTokenEndpoint throws a debuggable invalid JSON error when the token body is malformed", async () => {
    setOAuthConfigDetectionOverridesForTest({
      findCCBinary: () => null,
    });

    setNodeTokenRequestRunnerForTest(async () => JSON.stringify({
      ok: true,
      body: "not-json",
    }));

    let thrown: unknown;
    try {
      await anthropicOAuthTestExports.postTokenEndpoint(
        "application/json",
        JSON.stringify({ grant_type: "refresh_token" }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Anthropic token request returned invalid JSON.");
    expect((thrown as Error).message).toContain("body=not-json");
  });

  describe("refreshWithOAuth", () => {
    test("returns full CredentialRefreshPatch with rotated refresh token and account info", async () => {
      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => null,
      });

      let capturedContentType: string | undefined;
      let capturedBody: string | undefined;
      let capturedTimeoutMs: number | undefined;

      setNodeTokenRequestRunnerForTest(async (options) => {
        capturedContentType = options.contentType;
        capturedBody = options.body;
        capturedTimeoutMs = options.timeoutMs;

        return JSON.stringify({
          ok: true,
          body: JSON.stringify({
            access_token: "new-a",
            refresh_token: "new-r",
            expires_in: 3600,
            account: {
              uuid: "u-1",
              email_address: "e@x",
            },
          }),
        });
      });

      const result = await refreshWithOAuth("old-refresh");

      expect(capturedContentType).toBe("application/x-www-form-urlencoded");
      expect(capturedTimeoutMs).toBe(15_000);

      const params = new URLSearchParams(capturedBody!);
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("old-refresh");
      expect(params.get("client_id")).toBeString();

      expect(result.accessToken).toBe("new-a");
      expect(result.refreshToken).toBe("new-r");
      expect(result.uuid).toBe("u-1");
      expect(result.email).toBe("e@x");
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    test("omits refreshToken from patch when server does not rotate it", async () => {
      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => null,
      });

      setNodeTokenRequestRunnerForTest(async () => JSON.stringify({
        ok: true,
        body: JSON.stringify({
          access_token: "new-a",
          expires_in: 3600,
        }),
      }));

      const result = await refreshWithOAuth("old-refresh");

      expect(result.accessToken).toBe("new-a");
      expect(result.expiresAt).toBeGreaterThan(Date.now());
      expect("refreshToken" in result).toBe(false);
    });

    test("throws error containing HTTP status when token endpoint returns non-OK", async () => {
      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => null,
      });

      setNodeTokenRequestRunnerForTest(async () => JSON.stringify({
        ok: false,
        status: 401,
      }));

      let thrown: unknown;
      try {
        await refreshWithOAuth("expired-refresh");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("401");
      expect((thrown as Error).message).toContain("Anthropic token request failed");
    });
  });

  describe("exchangeCodeForTokens", () => {
    test("sends JSON body with all 6 required fields and returns validated TokenResponse", async () => {
      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => null,
      });

      let capturedContentType: string | undefined;
      let capturedBody: string | undefined;
      let capturedTimeoutMs: number | undefined;

      setNodeTokenRequestRunnerForTest(async (options) => {
        capturedContentType = options.contentType;
        capturedBody = options.body;
        capturedTimeoutMs = options.timeoutMs;

        return JSON.stringify({
          ok: true,
          body: JSON.stringify({
            access_token: "access-abc",
            refresh_token: "refresh-xyz",
            expires_in: 7200,
            account: {
              uuid: "acct-456",
              email_address: "test@example.com",
            },
          }),
        });
      });

      const result = await anthropicOAuthTestExports.exchangeCodeForTokens({
        code: "auth-code-123",
        codeVerifier: "verifier-abc",
        state: "state-xyz",
        redirectUri: "http://localhost:54321/callback",
      });

      expect(result).toEqual({
        access_token: "access-abc",
        refresh_token: "refresh-xyz",
        expires_in: 7200,
        account: {
          uuid: "acct-456",
          email_address: "test@example.com",
        },
      });

      expect(capturedContentType).toBe("application/json");
      expect(capturedTimeoutMs).toBe(30_000);

      const parsedBody = JSON.parse(capturedBody!);
      expect(parsedBody).toEqual({
        grant_type: "authorization_code",
        client_id: expect.any(String),
        code: "auth-code-123",
        redirect_uri: "http://localhost:54321/callback",
        code_verifier: "verifier-abc",
        state: "state-xyz",
      });
      expect(Object.keys(parsedBody)).toHaveLength(6);
    });

    test("throws an error with HTTP status when the token endpoint returns non-OK", async () => {
      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => null,
      });

      setNodeTokenRequestRunnerForTest(async () => JSON.stringify({
        ok: false,
        status: 400,
        body: "invalid_grant",
      }));

      let thrown: unknown;
      try {
        await anthropicOAuthTestExports.exchangeCodeForTokens({
          code: "bad-code",
          codeVerifier: "verifier",
          state: "state",
          redirectUri: "http://localhost:12345/callback",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain("400");
      expect(message).toContain("Anthropic token request failed");
    });
  });

  describe("loginWithOAuth", () => {
    test("completes the public OAuth login flow and returns Partial<StoredAccount>", async () => {
      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => null,
      });

      let openedUrl: string | undefined;
      anthropicOAuthTestExports.setBrowserExecForTest((command, callback) => {
        openedUrl = command;
        callback?.(null);
      });

      anthropicOAuthTestExports.setProfileFetcherForTest(async () => ({
        ok: true,
        data: {
          email: "a@b",
          planTier: "max",
        },
      }));

      const usageTokens: string[] = [];
      anthropicOAuthTestExports.setUsageFetcherForTest(async (accessToken) => {
        usageTokens.push(accessToken);
        return { ok: false, reason: "not needed for login result" };
      });

      let tokenRequestBody: string | undefined;
      setNodeTokenRequestRunnerForTest(async (options) => {
        tokenRequestBody = options.body;
        return JSON.stringify({
          ok: true,
          body: JSON.stringify({
            access_token: "access-123",
            refresh_token: "refresh-456",
            expires_in: 3600,
          }),
        });
      });

      const progressMessages: string[] = [];
      const authEvents: Array<{ url: string; instructions?: string }> = [];
      let callbackResponsePromise: Promise<Response> | undefined;

      const loginPromise = loginWithOAuth({
        onAuth: (info) => {
          authEvents.push(info);
          const authorizeUrl = new URL(info.url);
          const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
          const state = authorizeUrl.searchParams.get("state");

          callbackResponsePromise = fetch(`${redirectUri}?code=oauth-code-123&state=${state}`, {
            redirect: "manual",
          });
        },
        onProgress: (message) => {
          progressMessages.push(message);
        },
      });

      const result = await loginPromise;
      const callbackResponse = await callbackResponsePromise;

      expect(callbackResponse?.status).toBe(302);
      expect(authEvents).toHaveLength(1);

      const authInfo = authEvents[0]!;
      const authorizeUrl = new URL(authInfo.url);
      expect(authInfo.instructions).toBe("Complete authorization in your browser.");
      expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://claude.com/cai/oauth/authorize");
      expect(authorizeUrl.searchParams.get("code")).toBe("true");
      expect(authorizeUrl.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizeUrl.searchParams.get("scope")).toBeString();
      expect(authorizeUrl.searchParams.get("code_challenge")).toBeString();
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizeUrl.searchParams.get("state")).toBeString();
      expect(authorizeUrl.searchParams.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      expect(openedUrl).toBe(
        anthropicOAuthTestExports.getOpenBrowserCommand(authInfo.url, process.platform),
      );
      expect(progressMessages).toEqual([
        "Waiting for browser authorization...",
        "Exchanging authorization code...",
        "Fetching profile...",
      ]);

      const parsedTokenRequestBody = JSON.parse(tokenRequestBody!);
      expect(parsedTokenRequestBody.code).toBe("oauth-code-123");
      expect(parsedTokenRequestBody.state).toBe(authorizeUrl.searchParams.get("state"));
      expect(parsedTokenRequestBody.redirect_uri).toBe(authorizeUrl.searchParams.get("redirect_uri"));
      expect(parsedTokenRequestBody.code_verifier).toBeString();

      expect(result.accessToken).toBe("access-123");
      expect(result.refreshToken).toBe("refresh-456");
      expect(result.expiresAt).toBeGreaterThan(Date.now());
      expect(result.email).toBe("a@b");
      expect(result.planTier).toBe("max");
      expect(result.addedAt).toBeNumber();
      expect(result.lastUsed).toBeNumber();
      expect(usageTokens).toEqual(["access-123"]);
    });

    test("treats usage fetch as best-effort and still succeeds when it throws", async () => {
      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => null,
      });

      anthropicOAuthTestExports.setBrowserExecForTest((_command, callback) => {
        callback?.(null);
      });

      anthropicOAuthTestExports.setProfileFetcherForTest(async () => ({
        ok: true,
        data: {
          email: "best-effort@example.com",
          planTier: "pro",
        },
      }));

      anthropicOAuthTestExports.setUsageFetcherForTest(async () => {
        throw new Error("usage endpoint unavailable");
      });

      setNodeTokenRequestRunnerForTest(async () => JSON.stringify({
        ok: true,
        body: JSON.stringify({
          access_token: "usage-access",
          refresh_token: "usage-refresh",
          expires_in: 3600,
        }),
      }));

      const loginPromise = loginWithOAuth({
        onAuth: (info) => {
          const authorizeUrl = new URL(info.url);
          const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
          const state = authorizeUrl.searchParams.get("state");

          void fetch(`${redirectUri}?code=oauth-code-best-effort&state=${state}`, {
            redirect: "manual",
          });
        },
      });

      const result = await loginPromise;

      expect(result.accessToken).toBe("usage-access");
      expect(result.refreshToken).toBe("usage-refresh");
      expect(result.email).toBe("best-effort@example.com");
      expect(result.planTier).toBe("pro");
    });

    test("stops the callback server when waiting for code fails", async () => {
      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => null,
      });

      anthropicOAuthTestExports.setBrowserExecForTest((_command, callback) => {
        callback?.(null);
      });

      const waitError = new Error("callback failed");
      const waitForCode = Promise.reject(waitError);
      waitForCode.catch(() => {});

      let stopCalls = 0;
      anthropicOAuthTestExports.setCallbackServerStarterForTest(async () => ({
        port: 43210,
        waitForCode,
        stop: () => {
          stopCalls += 1;
        },
      }));

      let thrown: unknown;
      try {
        await loginWithOAuth({
          onAuth: () => {},
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(waitError);
      expect(stopCalls).toBe(1);
    });

    test("exports the public login contract", async () => {
      const callbacks: LoginCallbacks = {
        onAuth: () => {},
      };

      expect(typeof loginWithOAuth).toBe("function");
      expect(typeof refreshWithOAuth).toBe("function");
      expect(typeof detectOAuthConfig).toBe("function");
      expect(typeof callbacks.onAuth).toBe("function");
      expect(anthropicOAuthTestExports.loginWithOAuth).toBe(loginWithOAuth);
    });
  });
});
