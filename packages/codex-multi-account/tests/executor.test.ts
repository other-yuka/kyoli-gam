import { describe, test, expect, beforeEach, vi, type Mock } from "bun:test";
import { executeWithAccountRotation } from "../src/executor";
import { createMockClient } from "./helpers";
import type { ManagedAccount, PluginClient } from "../src/types";

// ─── Test Fixtures ───────────────────────────────────────────────

function createAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    index: 0,
    uuid: "acct-1",
    accountId: "aid-1",
    email: "test@example.com",
    refreshToken: "rt-1",
    addedAt: Date.now(),
    lastUsed: Date.now(),
    enabled: true,
    consecutiveAuthFailures: 0,
    isAuthDisabled: false,
    ...overrides,
  };
}

function createSecondAccount(): ManagedAccount {
  return createAccount({
    index: 1,
    uuid: "acct-2",
    accountId: "aid-2",
    email: "test2@example.com",
    refreshToken: "rt-2",
  });
}

interface MockAccountManager {
  getAccountCount: Mock;
  selectAccount: Mock;
  getActiveAccount: Mock;
  refresh: Mock;
  markSuccess: Mock;
  markRateLimited: Mock;
  markAuthFailure: Mock;
  markRevoked: Mock;
  hasAnyUsableAccount: Mock;
  getMinWaitTime: Mock;
  applyUsageCache: Mock;
}

function createMockManager(accounts: ManagedAccount[] = [createAccount()]): MockAccountManager {
  let selectIndex = 0;

  return {
    getAccountCount: vi.fn(() => accounts.length),
    selectAccount: vi.fn(() => {
      const acct = accounts[selectIndex % accounts.length];
      selectIndex++;
      return Promise.resolve(acct ?? null);
    }),
    getActiveAccount: vi.fn(() => accounts[0] ?? null),
    refresh: vi.fn(() => Promise.resolve()),
    markSuccess: vi.fn(() => Promise.resolve()),
    markRateLimited: vi.fn(() => Promise.resolve()),
    markAuthFailure: vi.fn(() => Promise.resolve()),
    markRevoked: vi.fn(() => Promise.resolve()),
    hasAnyUsableAccount: vi.fn(() => true),
    getMinWaitTime: vi.fn(() => 0),
    applyUsageCache: vi.fn(() => Promise.resolve()),
  };
}

interface MockRuntimeFactory {
  getRuntime: Mock;
  invalidate: Mock;
}

function createMockRuntimeFactory(fetchFn: typeof fetch): MockRuntimeFactory {
  return {
    getRuntime: vi.fn(() => Promise.resolve({ fetch: fetchFn })),
    invalidate: vi.fn(() => {}),
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// ─── Tests ───────────────────────────────────────────────────────

describe("executeWithAccountRotation", () => {
  let client: PluginClient;

  beforeEach(() => {
    client = createMockClient();
  });

  // ── Success Path ─────────────────────────────────────────────

  describe("success path", () => {
    test("returns response on first successful request", async () => {
      const account = createAccount();
      const manager = createMockManager([account]);
      const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
      const factory = createMockRuntimeFactory(fetchFn);

      const response = await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
    });

    test("calls markSuccess on the account after success", async () => {
      const account = createAccount();
      const manager = createMockManager([account]);
      const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
      const factory = createMockRuntimeFactory(fetchFn);

      await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      expect(manager.markSuccess).toHaveBeenCalledWith("acct-1");
    });
  });

  // ── 429 Rate Limit ──────────────────────────────────────────

  describe("account rotation on 429", () => {
    test("on 429, calls markRateLimited and retries with next account", async () => {
      const acct1 = createAccount();
      const acct2 = createSecondAccount();
      const manager = createMockManager([acct1, acct2]);

      let callCount = 0;
      const fetchFn = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            jsonResponse({ error: "rate_limited" }, 429, { "retry-after-ms": "10" }),
          );
        }
        return Promise.resolve(jsonResponse({ ok: true }));
      });

      const factory = createMockRuntimeFactory(fetchFn);

      const response = await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      expect(response.status).toBe(200);
      expect(manager.markRateLimited).toHaveBeenCalled();
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  // ── 401 Auth Failure ────────────────────────────────────────

  describe("auth failure on 401", () => {
    test("on 401, invalidates runtime and retries with fresh token", async () => {
      const account = createAccount();
      const manager = createMockManager([account]);

      let callCount = 0;
      const fetchFn = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(jsonResponse({ error: "unauthorized" }, 401));
        }
        // Retry after invalidation succeeds
        return Promise.resolve(jsonResponse({ ok: true }));
      });

      const factory = createMockRuntimeFactory(fetchFn);

      const response = await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      expect(response.status).toBe(200);
      expect(factory.invalidate).toHaveBeenCalledWith("acct-1");
      expect(manager.markSuccess).toHaveBeenCalledWith("acct-1");
    });

    test("if retry also 401, marks auth failure and switches account", async () => {
      const acct1 = createAccount();
      const acct2 = createSecondAccount();
      const manager = createMockManager([acct1, acct2]);

      let callCount = 0;
      const fetchFn = vi.fn(() => {
        callCount++;
        // First two calls (initial + retry) return 401 for acct-1
        if (callCount <= 2) {
          return Promise.resolve(jsonResponse({ error: "unauthorized" }, 401));
        }
        // Third call (acct-2) succeeds
        return Promise.resolve(jsonResponse({ ok: true }));
      });

      const factory = createMockRuntimeFactory(fetchFn);

      const response = await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      expect(response.status).toBe(200);
      expect(manager.markAuthFailure).toHaveBeenCalledWith("acct-1", { ok: false, permanent: false });
    });

    test("if all accounts fail auth, throws", async () => {
      const account = createAccount();
      const manager = createMockManager([account]);

      // All calls return 401
      const fetchFn = vi.fn(() =>
        Promise.resolve(jsonResponse({ error: "unauthorized" }, 401)),
      );

      const factory = createMockRuntimeFactory(fetchFn);

      // After 401 retry fails, mark auth failure then hasAnyUsableAccount returns false
      manager.hasAnyUsableAccount = vi.fn(() => false);

      await expect(
        executeWithAccountRotation(
          manager as any,
          factory as any,
          client,
          "https://api.example.com/v1/chat",
        ),
      ).rejects.toThrow("All Codex accounts have authentication failures");
    });
  });

  // ── 403 Revoked ─────────────────────────────────────────────

  describe("revoked on 403", () => {
    test("on 403 with revoked body, calls markRevoked and switches", async () => {
      const acct1 = createAccount();
      const acct2 = createSecondAccount();
      const manager = createMockManager([acct1, acct2]);

      let callCount = 0;
      const fetchFn = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "token has been revoked" }), {
              status: 403,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(jsonResponse({ ok: true }));
      });

      const factory = createMockRuntimeFactory(fetchFn);

      const response = await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      expect(response.status).toBe(200);
      expect(manager.markRevoked).toHaveBeenCalledWith("acct-1");
    });

    test("on 403 without revoked body, returns response as-is", async () => {
      const account = createAccount();
      const manager = createMockManager([account]);

      const fetchFn = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "forbidden" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
        ),
      );

      const factory = createMockRuntimeFactory(fetchFn);

      const response = await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      // Non-revoked 403 is returned directly (markSuccess is called, response returned)
      expect(response.status).toBe(403);
      expect(manager.markRevoked).not.toHaveBeenCalled();
      expect(manager.markSuccess).toHaveBeenCalledWith("acct-1");
    });
  });

  // ── Server Error Retry ──────────────────────────────────────

  describe("server error retry", () => {
    test("on 500, retries up to MAX_SERVER_RETRIES_PER_ATTEMPT times with same account", async () => {
      const account = createAccount();
      const manager = createMockManager([account]);

      let callCount = 0;
      const fetchFn = vi.fn(() => {
        callCount++;
        // First call: 500, then 2 retries also 500, then next loop iteration succeeds
        if (callCount <= 3) {
          return Promise.resolve(jsonResponse({ error: "server_error" }, 500));
        }
        return Promise.resolve(jsonResponse({ ok: true }));
      });

      const factory = createMockRuntimeFactory(fetchFn);

      const response = await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      expect(response.status).toBe(200);
      // 1 initial + 2 retries = 3 calls for first attempt, then 1 success = 4 total
      expect(fetchFn).toHaveBeenCalledTimes(4);
    });

    test("on 500 that resolves after one server retry, returns success", async () => {
      const account = createAccount();
      const manager = createMockManager([account]);

      let callCount = 0;
      const fetchFn = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(jsonResponse({ error: "server_error" }, 500));
        }
        return Promise.resolve(jsonResponse({ ok: true }));
      });

      const factory = createMockRuntimeFactory(fetchFn);

      const response = await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      expect(response.status).toBe(200);
      // 1 initial + 1 retry = 2 calls
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  // ── Max Retries Exhausted ───────────────────────────────────

  describe("max retries exhausted", () => {
    test("throws after exhausting all retries across all accounts", async () => {
      const account = createAccount();
      const manager = createMockManager([account]);

      // Always return 429 to exhaust retries
      const fetchFn = vi.fn(() =>
        Promise.resolve(
          jsonResponse({ error: "rate_limited" }, 429, { "retry-after-ms": "10" }),
        ),
      );

      const factory = createMockRuntimeFactory(fetchFn);

      await expect(
        executeWithAccountRotation(
          manager as any,
          factory as any,
          client,
          "https://api.example.com/v1/chat",
        ),
      ).rejects.toThrow(/Exhausted \d+ retries across all accounts/);
    });
  });

  // ── resolveAccount wait ─────────────────────────────────────

  describe("resolveAccount wait", () => {
    test("waits when selectAccount returns null but hasAnyUsableAccount and getMinWaitTime > 0", async () => {
      const account = createAccount();
      const manager = createMockManager([account]);

      let selectCallCount = 0;
      manager.selectAccount = vi.fn(() => {
        selectCallCount++;
        // First call returns null (waiting), second call returns account
        if (selectCallCount === 1) return Promise.resolve(null);
        return Promise.resolve(account);
      });

      manager.hasAnyUsableAccount = vi.fn(() => true);
      manager.getMinWaitTime = vi.fn(() => 10); // 10ms wait — fast for tests

      const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
      const factory = createMockRuntimeFactory(fetchFn);

      const response = await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      expect(response.status).toBe(200);
      expect(selectCallCount).toBeGreaterThanOrEqual(2);
    });

    test("throws when no usable accounts remain", async () => {
      const manager = createMockManager([]);
      manager.getAccountCount = vi.fn(() => 0);
      manager.selectAccount = vi.fn(() => Promise.resolve(null));
      manager.hasAnyUsableAccount = vi.fn(() => false);

      const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
      const factory = createMockRuntimeFactory(fetchFn);

      await expect(
        executeWithAccountRotation(
          manager as any,
          factory as any,
          client,
          "https://api.example.com/v1/chat",
        ),
      ).rejects.toThrow("All Codex accounts are disabled");
    });
  });

  // ── Runtime Fetch Failure ───────────────────────────────────

  describe("runtime fetch failure", () => {
    test("on token refresh failure (auth error), invalidates and switches account", async () => {
      const acct1 = createAccount();
      const acct2 = createSecondAccount();
      const manager = createMockManager([acct1, acct2]);

      let callCount = 0;
      const factory: MockRuntimeFactory = {
        getRuntime: vi.fn(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error("Token refresh failed: 401"));
          }
          return Promise.resolve({
            fetch: vi.fn(() => Promise.resolve(jsonResponse({ ok: true }))),
          });
        }),
        invalidate: vi.fn(() => {}),
      };

      const response = await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      expect(response.status).toBe(200);
      expect(factory.invalidate).toHaveBeenCalledWith("acct-1");
      expect(manager.markAuthFailure).toHaveBeenCalled();
    });

    test("on network error (non-token-refresh), continues to next attempt", async () => {
      const account = createAccount();
      const manager = createMockManager([account]);

      let callCount = 0;
      const fetchFn = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error("fetch failed: ECONNRESET"));
        }
        return Promise.resolve(jsonResponse({ ok: true }));
      });

      const factory = createMockRuntimeFactory(fetchFn);

      const response = await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
      );

      expect(response.status).toBe(200);
      expect(callCount).toBe(2);
    });
  });

  // ── Request Forwarding ──────────────────────────────────────

  describe("request forwarding", () => {
    test("passes input and init through to runtime fetch", async () => {
      const account = createAccount();
      const manager = createMockManager([account]);

      const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
      const factory = createMockRuntimeFactory(fetchFn);

      const requestInit: RequestInit = {
        method: "POST",
        body: JSON.stringify({ prompt: "hello" }),
        headers: { "content-type": "application/json" },
      };

      await executeWithAccountRotation(
        manager as any,
        factory as any,
        client,
        "https://api.example.com/v1/chat",
        requestInit,
      );

      expect(fetchFn).toHaveBeenCalledWith("https://api.example.com/v1/chat", requestInit);
    });
  });
});
