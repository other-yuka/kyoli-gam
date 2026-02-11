import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OPENAI_OAUTH_ADAPTER,
  OPENAI_CLIENT_ID,
  OPENAI_TOKEN_ENDPOINT,
  TOKEN_EXPIRY_BUFFER_MS,
} from "../src/constants";
import { clearRefreshMutex, isTokenExpired, refreshToken } from "../src/token";
import { createMockClient, createDeferred, createTokenResponse, buildFakeJwt } from "../tests/helpers";

describe("token", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearRefreshMutex();
  });

  describe("isTokenExpired", () => {
    test("returns true when no accessToken", () => {
      expect(
        isTokenExpired({
          accessToken: undefined,
          expiresAt: Date.now() + TOKEN_EXPIRY_BUFFER_MS + 120_000,
        }),
      ).toBe(true);
    });

    test("returns true when no expiresAt", () => {
      expect(
        isTokenExpired({
          accessToken: "access-token",
          expiresAt: undefined,
        }),
      ).toBe(true);
    });

    test("returns true when token is within expiry buffer", () => {
      expect(
        isTokenExpired({
          accessToken: "access-token",
          expiresAt: Date.now() + TOKEN_EXPIRY_BUFFER_MS - 1,
        }),
      ).toBe(true);
    });

    test("returns false when token is still valid", () => {
      expect(
        isTokenExpired({
          accessToken: "access-token",
          expiresAt: Date.now() + TOKEN_EXPIRY_BUFFER_MS + 120_000,
        }),
      ).toBe(false);
    });
  });

  describe("refreshToken success", () => {
    test("calls fetch with expected request format", async () => {
      const client = createMockClient();
      const fakeAccessToken = buildFakeJwt({ chatgpt_account_id: "acct-123" });
      const mockFetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
          createTokenResponse({
            access_token: fakeAccessToken,
            refresh_token: "new-refresh",
            expires_in: 3600,
            id_token: buildFakeJwt({ chatgpt_account_id: "acct-123", email: "user@example.com" }),
          }),
        ),
      );
      globalThis.fetch = mockFetch;

      await refreshToken("old-refresh", "account-1", client);

      expect(mockFetch.mock.calls.length).toBe(1);
      const [url, init] = mockFetch.mock.calls[0] ?? [];
      expect(url).toBe(OPENAI_TOKEN_ENDPOINT);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });

      const body = new URLSearchParams((init?.body as URLSearchParams).toString());
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh");
      expect(body.get("client_id")).toBe(OPENAI_CLIENT_ID);
    });

    test("returns full patch with accessToken, expiresAt, refreshToken, accountId", async () => {
      const client = createMockClient();
      const fakeAccessToken = buildFakeJwt({ chatgpt_account_id: "acct-456" });
      const fakeIdToken = buildFakeJwt({ chatgpt_account_id: "acct-456" });
      const mockFetch = vi.fn(() =>
        Promise.resolve(
          createTokenResponse({
            access_token: fakeAccessToken,
            refresh_token: "new-refresh",
            expires_in: 3600,
            id_token: fakeIdToken,
          }),
        ),
      );
      globalThis.fetch = mockFetch;

      const beforeRefresh = Date.now();
      const result = await refreshToken("old-refresh", "account-1", client);
      const afterRefresh = Date.now();

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Expected successful refresh result");
      }

      expect(result.patch.accessToken).toBe(fakeAccessToken);
      expect(result.patch.refreshToken).toBe("new-refresh");
      expect(result.patch.accountId).toBe("acct-456");
      expect(result.patch.expiresAt).toBeGreaterThanOrEqual(beforeRefresh + 3_600_000);
      expect(result.patch.expiresAt).toBeLessThanOrEqual(afterRefresh + 3_600_000);
    });

    test("handles response without optional fields", async () => {
      const client = createMockClient();
      const fakeAccessToken = buildFakeJwt({});
      const mockFetch = vi.fn(() =>
        Promise.resolve(
          createTokenResponse({
            access_token: fakeAccessToken,
            expires_in: 3600,
          }),
        ),
      );
      globalThis.fetch = mockFetch;

      const result = await refreshToken("old-refresh", "account-1", client);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Expected successful refresh result");
      }

      expect(result.patch.accessToken).toBe(fakeAccessToken);
      expect(result.patch.refreshToken).toBeUndefined();
      expect(result.patch.accountId).toBeUndefined();
    });
  });

  describe("refreshToken failure", () => {
    test("returns permanent failure and logs error for 400/401/403", async () => {
      const permanentStatuses = [400, 401, 403];

      for (const status of permanentStatuses) {
        const client = createMockClient();
        const mockFetch = vi.fn(() => Promise.resolve(new Response("", { status })));
        globalThis.fetch = mockFetch;

        const result = await refreshToken("old-refresh", `account-${status}`, client);

        expect(result).toEqual({ ok: false, permanent: true, status });
        expect(client.logs.length).toBe(1);
        expect(client.logs[0]?.service).toBe(OPENAI_OAUTH_ADAPTER.serviceLogName);
        expect(client.logs[0]?.level).toBe("error");
        expect(client.logs[0]?.message.includes(`Token refresh failed: ${status}`)).toBe(true);
      }
    });

    test("returns transient failure and logs warn for 500/502/503", async () => {
      const transientStatuses = [500, 502, 503];

      for (const status of transientStatuses) {
        const client = createMockClient();
        const mockFetch = vi.fn(() => Promise.resolve(new Response("", { status })));
        globalThis.fetch = mockFetch;

        const result = await refreshToken("old-refresh", `account-${status}`, client);

        expect(result).toEqual({ ok: false, permanent: false, status });
        expect(client.logs.length).toBe(1);
        expect(client.logs[0]?.service).toBe(OPENAI_OAUTH_ADAPTER.serviceLogName);
        expect(client.logs[0]?.level).toBe("warn");
        expect(client.logs[0]?.message.includes(`Token refresh failed: ${status}`)).toBe(true);
      }
    });

    test("returns transient failure when fetch throws", async () => {
      const client = createMockClient();
      const mockFetch = vi.fn(() => Promise.reject(new Error("network error")));
      globalThis.fetch = mockFetch;

      const result = await refreshToken("old-refresh", "account-network-error", client);

      expect(result).toEqual({ ok: false, permanent: false });
      expect(client.logs.length).toBe(1);
      expect(client.logs[0]?.level).toBe("warn");
      expect(client.logs[0]?.message).toContain("network error");
    });

    test("returns ok:false permanent:true when empty refresh token is passed", async () => {
      const client = createMockClient();
      const mockFetch = vi.fn(() => Promise.resolve(new Response("")));
      globalThis.fetch = mockFetch;

      const result = await refreshToken("", "account-empty", client);

      expect(result).toEqual({ ok: false, permanent: true });
      expect(mockFetch.mock.calls.length).toBe(0);
    });
  });

  describe("refreshToken Promise dedup", () => {
    test("deduplicates concurrent refreshes for same accountId", async () => {
      const client = createMockClient();
      const fakeAccessToken = buildFakeJwt({});
      const deferred = createDeferred<Response>();
      const mockFetch = vi.fn(() => deferred.promise);
      globalThis.fetch = mockFetch;

      const firstCall = refreshToken("old-refresh", "same-account", client);
      const secondCall = refreshToken("old-refresh", "same-account", client);

      expect(mockFetch.mock.calls.length).toBe(1);
      deferred.resolve(
        createTokenResponse({
          access_token: fakeAccessToken,
          expires_in: 3600,
        }),
      );

      const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);

      expect(firstResult).toBe(secondResult);
      expect(firstResult).toEqual(secondResult);
    });

    test("makes a new fetch after prior refresh completes", async () => {
      const client = createMockClient();
      const fakeAccessToken = buildFakeJwt({});
      const mockFetch = vi.fn(() =>
        Promise.resolve(
          createTokenResponse({
            access_token: fakeAccessToken,
            expires_in: 3600,
          }),
        ),
      );
      globalThis.fetch = mockFetch;

      const firstCall = refreshToken("old-refresh", "same-account", client);
      const secondCall = refreshToken("old-refresh", "same-account", client);
      await Promise.all([firstCall, secondCall]);

      expect(mockFetch.mock.calls.length).toBe(1);

      await refreshToken("old-refresh", "same-account", client);

      expect(mockFetch.mock.calls.length).toBe(2);
    });

    test("does not deduplicate concurrent refreshes for different accountIds", async () => {
      const client = createMockClient();
      const fakeTokenA = buildFakeJwt({ chatgpt_account_id: "acct-a" });
      const fakeTokenB = buildFakeJwt({ chatgpt_account_id: "acct-b" });
      const deferredA = createDeferred<Response>();
      const deferredB = createDeferred<Response>();
      let callIndex = 0;
      const mockFetch = vi.fn(() => {
        callIndex += 1;
        return callIndex === 1 ? deferredA.promise : deferredB.promise;
      });
      globalThis.fetch = mockFetch;

      const callA = refreshToken("old-refresh-a", "account-a", client);
      const callB = refreshToken("old-refresh-b", "account-b", client);

      expect(mockFetch.mock.calls.length).toBe(2);

      deferredA.resolve(
        createTokenResponse({
          access_token: fakeTokenA,
          expires_in: 3600,
        }),
      );
      deferredB.resolve(
        createTokenResponse({
          access_token: fakeTokenB,
          expires_in: 3600,
        }),
      );

      const [resultA, resultB] = await Promise.all([callA, callB]);

      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
      if (!resultA.ok || !resultB.ok) {
        throw new Error("Expected successful refresh results");
      }
      expect(resultA.patch.accessToken).toBe(fakeTokenA);
      expect(resultB.patch.accessToken).toBe(fakeTokenB);
    });
  });

  describe("clearRefreshMutex", () => {
    test("clears specific accountId mutex only", async () => {
      const client = createMockClient();
      const fakeTokenA1 = buildFakeJwt({ chatgpt_account_id: "acct-a" });
      const fakeTokenB1 = buildFakeJwt({ chatgpt_account_id: "acct-b" });
      const fakeTokenA2 = buildFakeJwt({ chatgpt_account_id: "acct-a" });
      const deferreds = [createDeferred<Response>(), createDeferred<Response>(), createDeferred<Response>()];
      let callIndex = 0;
      const mockFetch = vi.fn(() => {
        const deferred = deferreds[callIndex];
        callIndex += 1;
        if (!deferred) {
          throw new Error("Unexpected fetch call");
        }
        return deferred.promise;
      });
      globalThis.fetch = mockFetch;

      const firstA = refreshToken("refresh-a", "account-a", client);
      const firstB = refreshToken("refresh-b", "account-b", client);
      const dedupA = refreshToken("refresh-a", "account-a", client);
      const dedupB = refreshToken("refresh-b", "account-b", client);

      expect(mockFetch.mock.calls.length).toBe(2);

      clearRefreshMutex("account-a");

      const secondA = refreshToken("refresh-a", "account-a", client);
      const stillDedupB = refreshToken("refresh-b", "account-b", client);

      expect(mockFetch.mock.calls.length).toBe(3);

      deferreds[0]?.resolve(createTokenResponse({ access_token: fakeTokenA1, expires_in: 3600 }));
      deferreds[1]?.resolve(createTokenResponse({ access_token: fakeTokenB1, expires_in: 3600 }));
      deferreds[2]?.resolve(createTokenResponse({ access_token: fakeTokenA2, expires_in: 3600 }));

      const [resultA1, resultADedup, resultB1, resultBDedup, resultA2, resultBStillDedup] = await Promise.all([
        firstA,
        dedupA,
        firstB,
        dedupB,
        secondA,
        stillDedupB,
      ]);

      expect(resultA1.ok).toBe(true);
      expect(resultADedup.ok).toBe(true);
      expect(resultB1.ok).toBe(true);
      expect(resultBDedup.ok).toBe(true);
      expect(resultA2.ok).toBe(true);
      expect(resultBStillDedup.ok).toBe(true);
      if (!resultA1.ok || !resultADedup.ok || !resultB1.ok || !resultBDedup.ok || !resultA2.ok || !resultBStillDedup.ok) {
        throw new Error("Expected successful refresh results");
      }

      expect(resultA1.patch.accessToken).toBe(fakeTokenA1);
      expect(resultADedup.patch.accessToken).toBe(fakeTokenA1);
      expect(resultA2.patch.accessToken).toBe(fakeTokenA2);
      expect(resultB1.patch.accessToken).toBe(fakeTokenB1);
      expect(resultBDedup.patch.accessToken).toBe(fakeTokenB1);
      expect(resultBStillDedup.patch.accessToken).toBe(fakeTokenB1);
    });

    test("clears all mutexes when accountId is omitted", async () => {
      const client = createMockClient();
      const fakeTokenA1 = buildFakeJwt({ chatgpt_account_id: "acct-a" });
      const fakeTokenB1 = buildFakeJwt({ chatgpt_account_id: "acct-b" });
      const fakeTokenA2 = buildFakeJwt({ chatgpt_account_id: "acct-a" });
      const fakeTokenB2 = buildFakeJwt({ chatgpt_account_id: "acct-b" });
      const deferreds = [
        createDeferred<Response>(),
        createDeferred<Response>(),
        createDeferred<Response>(),
        createDeferred<Response>(),
      ];
      let callIndex = 0;
      const mockFetch = vi.fn(() => {
        const deferred = deferreds[callIndex];
        callIndex += 1;
        if (!deferred) {
          throw new Error("Unexpected fetch call");
        }
        return deferred.promise;
      });
      globalThis.fetch = mockFetch;

      const firstA = refreshToken("refresh-a", "account-a", client);
      const firstB = refreshToken("refresh-b", "account-b", client);

      expect(mockFetch.mock.calls.length).toBe(2);

      clearRefreshMutex();

      const secondA = refreshToken("refresh-a", "account-a", client);
      const secondB = refreshToken("refresh-b", "account-b", client);

      expect(mockFetch.mock.calls.length).toBe(4);

      deferreds[0]?.resolve(createTokenResponse({ access_token: fakeTokenA1, expires_in: 3600 }));
      deferreds[1]?.resolve(createTokenResponse({ access_token: fakeTokenB1, expires_in: 3600 }));
      deferreds[2]?.resolve(createTokenResponse({ access_token: fakeTokenA2, expires_in: 3600 }));
      deferreds[3]?.resolve(createTokenResponse({ access_token: fakeTokenB2, expires_in: 3600 }));

      const [resultA1, resultB1, resultA2, resultB2] = await Promise.all([firstA, firstB, secondA, secondB]);

      expect(resultA1.ok).toBe(true);
      expect(resultB1.ok).toBe(true);
      expect(resultA2.ok).toBe(true);
      expect(resultB2.ok).toBe(true);
      if (!resultA1.ok || !resultB1.ok || !resultA2.ok || !resultB2.ok) {
        throw new Error("Expected successful refresh results");
      }

      expect(resultA1.patch.accessToken).toBe(fakeTokenA1);
      expect(resultA2.patch.accessToken).toBe(fakeTokenA2);
      expect(resultB1.patch.accessToken).toBe(fakeTokenB1);
      expect(resultB2.patch.accessToken).toBe(fakeTokenB2);
    });
  });
});
