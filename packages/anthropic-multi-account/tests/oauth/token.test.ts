import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { ANTHROPIC_OAUTH_ADAPTER, TOKEN_EXPIRY_BUFFER_MS } from "../../src/shared/constants";
import * as anthropicOAuth from "../../src/oauth/anthropic-oauth";
import type { CredentialRefreshPatch } from "../../src/shared/types";
import { clearRefreshMutex, isTokenExpired, refreshToken } from "../../src/oauth/token";
import { createMockClient } from "../helpers";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("token", () => {
  let refreshWithOAuthSpy: ReturnType<typeof vi.spyOn<typeof anthropicOAuth, "refreshWithOAuth">>;

  beforeEach(() => {
    refreshWithOAuthSpy = vi.spyOn(anthropicOAuth, "refreshWithOAuth");
  });

  afterEach(() => {
    refreshWithOAuthSpy.mockRestore();
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
    test("calls refreshWithOAuth and returns patch", async () => {
      const client = createMockClient();
      const patch: CredentialRefreshPatch = {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: Date.now() + 3_600_000,
        uuid: "user-uuid",
        email: "user@example.com",
      };
      refreshWithOAuthSpy.mockResolvedValue(patch);

      const result = await refreshToken("old-refresh", "account-1", client);

      expect(refreshWithOAuthSpy).toHaveBeenCalledTimes(1);
      expect(refreshWithOAuthSpy).toHaveBeenCalledWith("old-refresh");
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Expected successful refresh result");
      }
      expect(result.patch).toEqual(patch);
      expect(client.logs.length).toBe(0);
    });

    test("handles minimal patch response", async () => {
      const client = createMockClient();
      refreshWithOAuthSpy.mockResolvedValue({
        accessToken: "new-access",
        expiresAt: Date.now() + 3_600_000,
      });

      const result = await refreshToken("old-refresh", "account-1", client);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Expected successful refresh result");
      }

      expect(result.patch.accessToken).toBe("new-access");
      expect(result.patch.expiresAt).toBeGreaterThan(Date.now());
      expect(result.patch.refreshToken).toBeUndefined();
    });
  });

  describe("refreshToken failure", () => {
    test("returns transient failure and logs warn for bare 400/401/403 without permanent OAuth error codes", async () => {
      const ambiguousStatuses = [400, 401, 403];

      for (const status of ambiguousStatuses) {
        const client = createMockClient();
        refreshWithOAuthSpy.mockReset();
        refreshWithOAuthSpy.mockRejectedValue(new Error(`Token refresh failed: ${status}`));

        const result = await refreshToken("old-refresh", `account-${status}`, client);

        expect(result).toEqual({ ok: false, permanent: false });
        expect(client.logs.length).toBe(1);
        expect(client.logs[0]?.service).toBe(ANTHROPIC_OAUTH_ADAPTER.serviceLogName);
        expect(client.logs[0]?.level).toBe("warn");
        expect(client.logs[0]?.message.includes(`${status}`)).toBe(true);
      }
    });

    test("returns transient failure and logs warn for non-permanent statuses", async () => {
      const transientStatuses = [500, 502, 503];

      for (const status of transientStatuses) {
        const client = createMockClient();
        refreshWithOAuthSpy.mockReset();
        refreshWithOAuthSpy.mockRejectedValue(new Error(`Token refresh failed: ${status}`));

        const result = await refreshToken("old-refresh", `account-${status}`, client);

        expect(result).toEqual({ ok: false, permanent: false });
        expect(client.logs.length).toBe(1);
        expect(client.logs[0]?.service).toBe(ANTHROPIC_OAUTH_ADAPTER.serviceLogName);
        expect(client.logs[0]?.level).toBe("warn");
        expect(client.logs[0]?.message.includes(`${status}`)).toBe(true);
      }
    });

    test("returns transient failure when refreshWithOAuth throws network-like error", async () => {
      const client = createMockClient();
      refreshWithOAuthSpy.mockRejectedValue(new Error("network error"));

      const result = await refreshToken("old-refresh", "account-network-error", client);

      expect(result).toEqual({ ok: false, permanent: false });
      expect(client.logs.length).toBe(1);
      expect(client.logs[0]?.level).toBe("warn");
      expect(client.logs[0]?.message).toContain("network error");
    });

    test("returns permanent failure for wrapped anthropic-oauth auth-invalid errors without numeric status", async () => {
      const permanentMessages = [
        "[anthropic-oauth] refreshWithOAuth failed: body={\"error\":\"invalid_grant\",\"error_description\":\"Refresh token revoked\"}",
        "refresh failed: invalid_scope requested scope is invalid",
        "Token refresh failed: unauthorized_client: refresh token is no longer valid",
      ];

      for (const [index, message] of permanentMessages.entries()) {
        const client = createMockClient();
        refreshWithOAuthSpy.mockReset();
        refreshWithOAuthSpy.mockRejectedValue(new Error(message));

        const result = await refreshToken("old-refresh", `account-auth-invalid-${index}`, client);

        expect(result).toEqual({ ok: false, permanent: true });
        expect(client.logs.length).toBe(1);
        expect(client.logs[0]?.service).toBe(ANTHROPIC_OAUTH_ADAPTER.serviceLogName);
        expect(client.logs[0]?.level).toBe("error");
        expect(client.logs[0]?.message).toContain(message);
      }
    });
  });

  describe("refreshToken Promise dedup", () => {
    test("deduplicates concurrent refreshes for same accountId", async () => {
      const client = createMockClient();
      const deferred = createDeferred<CredentialRefreshPatch>();
      refreshWithOAuthSpy.mockImplementation(() => deferred.promise);

      const firstCall = refreshToken("old-refresh", "same-account", client);
      const secondCall = refreshToken("old-refresh", "same-account", client);

      expect(refreshWithOAuthSpy).toHaveBeenCalledTimes(1);
      deferred.resolve({
        accessToken: "new-access",
        expiresAt: Date.now() + 3_600_000,
      });

      const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);

      expect(firstResult).toBe(secondResult);
    });

    test("makes a new refresh call after prior refresh completes", async () => {
      const client = createMockClient();
      refreshWithOAuthSpy.mockResolvedValue({
        accessToken: "new-access",
        expiresAt: Date.now() + 3_600_000,
      });

      const firstCall = refreshToken("old-refresh", "same-account", client);
      const secondCall = refreshToken("old-refresh", "same-account", client);
      await Promise.all([firstCall, secondCall]);

      expect(refreshWithOAuthSpy).toHaveBeenCalledTimes(1);

      await refreshToken("old-refresh", "same-account", client);

      expect(refreshWithOAuthSpy).toHaveBeenCalledTimes(2);
    });

    test("does not deduplicate concurrent refreshes for different accountIds", async () => {
      const client = createMockClient();
      const deferredA = createDeferred<CredentialRefreshPatch>();
      const deferredB = createDeferred<CredentialRefreshPatch>();
      let callIndex = 0;
      refreshWithOAuthSpy.mockImplementation(() => {
        callIndex += 1;
        return callIndex === 1 ? deferredA.promise : deferredB.promise;
      });

      const callA = refreshToken("old-refresh-a", "account-a", client);
      const callB = refreshToken("old-refresh-b", "account-b", client);

      expect(refreshWithOAuthSpy).toHaveBeenCalledTimes(2);

      deferredA.resolve({ accessToken: "token-a", expiresAt: Date.now() + 3_600_000 });
      deferredB.resolve({ accessToken: "token-b", expiresAt: Date.now() + 3_600_000 });

      const [resultA, resultB] = await Promise.all([callA, callB]);

      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
      if (!resultA.ok || !resultB.ok) {
        throw new Error("Expected successful refresh results");
      }
      expect(resultA.patch.accessToken).toBe("token-a");
      expect(resultB.patch.accessToken).toBe("token-b");
    });
  });

  describe("clearRefreshMutex", () => {
    test("clears specific accountId mutex only", async () => {
      const client = createMockClient();
      const deferreds = [
        createDeferred<CredentialRefreshPatch>(),
        createDeferred<CredentialRefreshPatch>(),
        createDeferred<CredentialRefreshPatch>(),
      ];
      let callIndex = 0;
      refreshWithOAuthSpy.mockImplementation(() => {
        const deferred = deferreds[callIndex];
        callIndex += 1;
        if (!deferred) {
          throw new Error("Unexpected refresh call");
        }
        return deferred.promise;
      });

      const firstA = refreshToken("refresh-a", "account-a", client);
      const firstB = refreshToken("refresh-b", "account-b", client);
      const dedupA = refreshToken("refresh-a", "account-a", client);
      const dedupB = refreshToken("refresh-b", "account-b", client);

      expect(refreshWithOAuthSpy).toHaveBeenCalledTimes(2);

      clearRefreshMutex("account-a");

      const secondA = refreshToken("refresh-a", "account-a", client);
      const stillDedupB = refreshToken("refresh-b", "account-b", client);

      expect(refreshWithOAuthSpy).toHaveBeenCalledTimes(3);

      deferreds[0].resolve({ accessToken: "token-a-1", expiresAt: Date.now() + 3_600_000 });
      deferreds[1].resolve({ accessToken: "token-b-1", expiresAt: Date.now() + 3_600_000 });
      deferreds[2].resolve({ accessToken: "token-a-2", expiresAt: Date.now() + 3_600_000 });

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

      expect(resultA1.patch.accessToken).toBe("token-a-1");
      expect(resultADedup.patch.accessToken).toBe("token-a-1");
      expect(resultA2.patch.accessToken).toBe("token-a-2");
      expect(resultB1.patch.accessToken).toBe("token-b-1");
      expect(resultBDedup.patch.accessToken).toBe("token-b-1");
      expect(resultBStillDedup.patch.accessToken).toBe("token-b-1");
    });

    test("clears all mutexes when accountId is omitted", async () => {
      const client = createMockClient();
      const deferreds = [
        createDeferred<CredentialRefreshPatch>(),
        createDeferred<CredentialRefreshPatch>(),
        createDeferred<CredentialRefreshPatch>(),
        createDeferred<CredentialRefreshPatch>(),
      ];
      let callIndex = 0;
      refreshWithOAuthSpy.mockImplementation(() => {
        const deferred = deferreds[callIndex];
        callIndex += 1;
        if (!deferred) {
          throw new Error("Unexpected refresh call");
        }
        return deferred.promise;
      });

      const firstA = refreshToken("refresh-a", "account-a", client);
      const firstB = refreshToken("refresh-b", "account-b", client);

      expect(refreshWithOAuthSpy).toHaveBeenCalledTimes(2);

      clearRefreshMutex();

      const secondA = refreshToken("refresh-a", "account-a", client);
      const secondB = refreshToken("refresh-b", "account-b", client);

      expect(refreshWithOAuthSpy).toHaveBeenCalledTimes(4);

      deferreds[0].resolve({ accessToken: "token-a-1", expiresAt: Date.now() + 3_600_000 });
      deferreds[1].resolve({ accessToken: "token-b-1", expiresAt: Date.now() + 3_600_000 });
      deferreds[2].resolve({ accessToken: "token-a-2", expiresAt: Date.now() + 3_600_000 });
      deferreds[3].resolve({ accessToken: "token-b-2", expiresAt: Date.now() + 3_600_000 });

      const [resultA1, resultB1, resultA2, resultB2] = await Promise.all([firstA, firstB, secondA, secondB]);

      expect(resultA1.ok).toBe(true);
      expect(resultB1.ok).toBe(true);
      expect(resultA2.ok).toBe(true);
      expect(resultB2.ok).toBe(true);
      if (!resultA1.ok || !resultB1.ok || !resultA2.ok || !resultB2.ok) {
        throw new Error("Expected successful refresh results");
      }

      expect(resultA1.patch.accessToken).toBe("token-a-1");
      expect(resultA2.patch.accessToken).toBe("token-a-2");
      expect(resultB1.patch.accessToken).toBe("token-b-1");
      expect(resultB2.patch.accessToken).toBe("token-b-2");
    });
  });
});
