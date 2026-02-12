import { beforeEach, describe, expect, test, vi } from "bun:test";
import { createExecutorForProvider } from "../src/executor";
import type { ManagedAccount, PluginClient } from "../src/types";

function createAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    index: 0,
    uuid: "acct-1",
    refreshToken: "rt-1",
    addedAt: Date.now(),
    lastUsed: Date.now(),
    enabled: true,
    consecutiveAuthFailures: 0,
    isAuthDisabled: false,
    ...overrides,
  };
}

function createClient(): PluginClient {
  return {
    auth: { set: async () => {} },
    tui: { showToast: async () => {} },
    app: { log: async () => {} },
  };
}

describe("core/executor", () => {
  let client: PluginClient;

  beforeEach(() => {
    client = createClient();
  });

  test("returns response on first success", async () => {
    const account = createAccount();
    const manager = {
      getAccountCount: () => 1,
      refresh: async () => {},
      selectAccount: async () => account,
      markSuccess: vi.fn(async () => {}),
      markAuthFailure: vi.fn(async () => {}),
      markRevoked: vi.fn(async () => {}),
      hasAnyUsableAccount: () => true,
      getMinWaitTime: () => 0,
    };

    const runtimeFactory = {
      getRuntime: async () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      }),
      invalidate: vi.fn(),
    };

    const { executeWithAccountRotation } = createExecutorForProvider("Codex", {
      handleRateLimitResponse: async () => {},
      formatWaitTime: (ms) => `${ms}ms`,
      sleep: async () => {},
      showToast: async () => {},
      getAccountLabel: () => "Account",
    });

    const response = await executeWithAccountRotation(
      manager,
      runtimeFactory,
      client,
      "https://api.example.com",
    );

    expect(response.status).toBe(200);
    expect(manager.markSuccess).toHaveBeenCalledWith("acct-1");
  });

  test("handles 429 by calling rate-limit handler", async () => {
    const account = createAccount();
    const manager = {
      getAccountCount: () => 1,
      refresh: async () => {},
      selectAccount: async () => account,
      markSuccess: vi.fn(async () => {}),
      markAuthFailure: vi.fn(async () => {}),
      markRevoked: vi.fn(async () => {}),
      hasAnyUsableAccount: () => true,
      getMinWaitTime: () => 0,
    };

    let calls = 0;
    const runtimeFactory = {
      getRuntime: async () => ({
        fetch: async () => {
          calls += 1;
          if (calls === 1) return new Response("", { status: 429 });
          return new Response("ok", { status: 200 });
        },
      }),
      invalidate: vi.fn(),
    };

    const handleRateLimitResponse = vi.fn(async () => {});
    const { executeWithAccountRotation } = createExecutorForProvider("Anthropic", {
      handleRateLimitResponse,
      formatWaitTime: (ms) => `${ms}ms`,
      sleep: async () => {},
      showToast: async () => {},
      getAccountLabel: () => "Account",
    });

    const response = await executeWithAccountRotation(manager, runtimeFactory, client, "https://api.example.com");
    expect(response.status).toBe(200);
    expect(handleRateLimitResponse).toHaveBeenCalledTimes(1);
  });

  test("throws provider-scoped auth error when all accounts unusable", async () => {
    const account = createAccount();
    const manager = {
      getAccountCount: () => 1,
      refresh: async () => {},
      selectAccount: async () => account,
      markSuccess: vi.fn(async () => {}),
      markAuthFailure: vi.fn(async () => {}),
      markRevoked: vi.fn(async () => {}),
      hasAnyUsableAccount: () => false,
      getMinWaitTime: () => 0,
    };

    const runtimeFactory = {
      getRuntime: async () => ({ fetch: async () => new Response("", { status: 401 }) }),
      invalidate: vi.fn(),
    };

    const { executeWithAccountRotation } = createExecutorForProvider("Codex", {
      handleRateLimitResponse: async () => {},
      formatWaitTime: (ms) => `${ms}ms`,
      sleep: async () => {},
      showToast: async () => {},
      getAccountLabel: () => "Account",
    });

    await expect(
      executeWithAccountRotation(manager, runtimeFactory, client, "https://api.example.com"),
    ).rejects.toThrow("All Codex accounts have authentication failures");
  });
});
