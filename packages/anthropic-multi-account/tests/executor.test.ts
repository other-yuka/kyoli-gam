import { describe, test, expect, beforeEach, vi, type Mock } from "bun:test";
import { executeWithAccountRotation } from "../src/executor";
import { createMockClient } from "./helpers";
import type { ManagedAccount, PluginClient } from "../src/types";

function createAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    index: 0,
    uuid: "acct-1",
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
      selectIndex += 1;
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

describe("executeWithAccountRotation", () => {
  let client: PluginClient;

  beforeEach(() => {
    client = createMockClient();
  });

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
    expect(manager.markSuccess).toHaveBeenCalledWith("acct-1");
  });

  test("on 429 calls markRateLimited and retries another account", async () => {
    const acct1 = createAccount();
    const acct2 = createSecondAccount();
    const manager = createMockManager([acct1, acct2]);

    let callCount = 0;
    const fetchFn = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(jsonResponse({ error: "rate_limited" }, 429, { "retry-after-ms": "10" }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const factory = createMockRuntimeFactory(fetchFn);
    const response = await executeWithAccountRotation(manager as any, factory as any, client, "https://api.example.com/v1/chat");

    expect(response.status).toBe(200);
    expect(manager.markRateLimited).toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("on 401 invalidates runtime and succeeds after retry", async () => {
    const account = createAccount();
    const manager = createMockManager([account]);

    let callCount = 0;
    const fetchFn = vi.fn(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(jsonResponse({ error: "unauthorized" }, 401));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const factory = createMockRuntimeFactory(fetchFn);
    const response = await executeWithAccountRotation(manager as any, factory as any, client, "https://api.example.com/v1/chat");

    expect(response.status).toBe(200);
    expect(factory.invalidate).toHaveBeenCalledWith("acct-1");
    expect(manager.markSuccess).toHaveBeenCalledWith("acct-1");
  });

  test("throws Anthropic auth failure error when all accounts fail 401", async () => {
    const account = createAccount();
    const manager = createMockManager([account]);
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({ error: "unauthorized" }, 401)));
    const factory = createMockRuntimeFactory(fetchFn);

    manager.hasAnyUsableAccount = vi.fn(() => false);

    await expect(
      executeWithAccountRotation(manager as any, factory as any, client, "https://api.example.com/v1/chat"),
    ).rejects.toThrow("All Anthropic accounts have authentication failures");
  });

  test("on revoked 403 marks account revoked and rotates", async () => {
    const acct1 = createAccount();
    const acct2 = createSecondAccount();
    const manager = createMockManager([acct1, acct2]);

    let callCount = 0;
    const fetchFn = vi.fn(() => {
      callCount += 1;
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
    const response = await executeWithAccountRotation(manager as any, factory as any, client, "https://api.example.com/v1/chat");

    expect(response.status).toBe(200);
    expect(manager.markRevoked).toHaveBeenCalledWith("acct-1");
  });

  test("on non-revoked 403 returns response as-is", async () => {
    const account = createAccount();
    const manager = createMockManager([account]);

    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ));

    const factory = createMockRuntimeFactory(fetchFn);
    const response = await executeWithAccountRotation(manager as any, factory as any, client, "https://api.example.com/v1/chat");

    expect(response.status).toBe(403);
    expect(manager.markRevoked).not.toHaveBeenCalled();
    expect(manager.markSuccess).toHaveBeenCalledWith("acct-1");
  });

  test("retries server errors and returns success", async () => {
    const account = createAccount();
    const manager = createMockManager([account]);

    let callCount = 0;
    const fetchFn = vi.fn(() => {
      callCount += 1;
      if (callCount <= 2) {
        return Promise.resolve(jsonResponse({ error: "server_error" }, 500));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const factory = createMockRuntimeFactory(fetchFn);
    const response = await executeWithAccountRotation(manager as any, factory as any, client, "https://api.example.com/v1/chat");

    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  test("throws after exhausting max retries", async () => {
    const account = createAccount();
    const manager = createMockManager([account]);
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ error: "rate_limited" }, 429, { "retry-after-ms": "10" }),
      ));

    const factory = createMockRuntimeFactory(fetchFn);

    await expect(
      executeWithAccountRotation(manager as any, factory as any, client, "https://api.example.com/v1/chat"),
    ).rejects.toThrow(/Exhausted \d+ retries across all accounts/);
  });

  test("waits when temporarily no selectable account", async () => {
    const account = createAccount();
    const manager = createMockManager([account]);

    let selectCallCount = 0;
    manager.selectAccount = vi.fn(() => {
      selectCallCount += 1;
      if (selectCallCount === 1) return Promise.resolve(null);
      return Promise.resolve(account);
    });
    manager.hasAnyUsableAccount = vi.fn(() => true);
    manager.getMinWaitTime = vi.fn(() => 10);

    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    const factory = createMockRuntimeFactory(fetchFn);

    const response = await executeWithAccountRotation(manager as any, factory as any, client, "https://api.example.com/v1/chat");
    expect(response.status).toBe(200);
    expect(selectCallCount).toBeGreaterThanOrEqual(2);
  });

  test("throws Anthropic disabled error when no usable accounts remain", async () => {
    const manager = createMockManager([]);
    manager.getAccountCount = vi.fn(() => 0);
    manager.selectAccount = vi.fn(() => Promise.resolve(null));
    manager.hasAnyUsableAccount = vi.fn(() => false);

    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    const factory = createMockRuntimeFactory(fetchFn);

    await expect(
      executeWithAccountRotation(manager as any, factory as any, client, "https://api.example.com/v1/chat"),
    ).rejects.toThrow("All Anthropic accounts are disabled");
  });

  test("runtime token-refresh failure invalidates and switches account", async () => {
    const acct1 = createAccount();
    const acct2 = createSecondAccount();
    const manager = createMockManager([acct1, acct2]);

    let callCount = 0;
    const factory: MockRuntimeFactory = {
      getRuntime: vi.fn(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.reject(new Error("Token refresh failed: 401"));
        }
        return Promise.resolve({
          fetch: vi.fn(() => Promise.resolve(jsonResponse({ ok: true }))),
        });
      }),
      invalidate: vi.fn(() => {}),
    };

    const response = await executeWithAccountRotation(manager as any, factory as any, client, "https://api.example.com/v1/chat");

    expect(response.status).toBe(200);
    expect(factory.invalidate).toHaveBeenCalledWith("acct-1");
    expect(manager.markAuthFailure).toHaveBeenCalled();
  });

  test("forwards input and init to runtime fetch", async () => {
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
