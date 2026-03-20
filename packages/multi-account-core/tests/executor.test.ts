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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "retry-after-ms": "10" },
  });
}

type MockManager = {
  getAccountCount: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  selectAccount: ReturnType<typeof vi.fn>;
  markSuccess: ReturnType<typeof vi.fn>;
  markAuthFailure: ReturnType<typeof vi.fn>;
  markRevoked: ReturnType<typeof vi.fn>;
  hasAnyUsableAccount: ReturnType<typeof vi.fn>;
  getMinWaitTime: ReturnType<typeof vi.fn>;
};

function createRotatingManager(accounts: ManagedAccount[]): MockManager {
  let selectIndex = 0;

  return {
    getAccountCount: vi.fn(() => accounts.length),
    refresh: vi.fn(async () => {}),
    selectAccount: vi.fn(async () => {
      const account = accounts[selectIndex % accounts.length];
      selectIndex += 1;
      return account ?? null;
    }),
    markSuccess: vi.fn(async () => {}),
    markAuthFailure: vi.fn(async () => {}),
    markRevoked: vi.fn(async () => {}),
    hasAnyUsableAccount: vi.fn(() => true),
    getMinWaitTime: vi.fn(() => 0),
  };
}

type FetchOutcome = Response | Error;

type MockRuntimeFactory = {
  getRuntime: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  calls: string[];
};

function createQueuedRuntimeFactory(outcomesByUuid: Record<string, FetchOutcome[]>): MockRuntimeFactory {
  const calls: string[] = [];

  return {
    getRuntime: vi.fn(async (uuid: string) => ({
      fetch: async () => {
        calls.push(uuid);
        const queue = outcomesByUuid[uuid];
        const outcome = queue?.shift();
        if (!outcome) {
          throw new Error(`Missing mocked outcome for ${uuid}`);
        }
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
    })),
    invalidate: vi.fn(),
    calls,
  };
}

function createTokenRefreshError(permanent: boolean, status?: number): Error {
  return Object.assign(new Error(`Token refresh failed${status ? `: ${status}` : ""}`), {
    name: "TokenRefreshError",
    permanent,
    status,
  });
}

function createExecutor(handleRateLimitResponse: ReturnType<typeof vi.fn>) {
  return createExecutorForProvider("Anthropic", {
    handleRateLimitResponse,
    formatWaitTime: (ms) => `${ms}ms`,
    sleep: async () => {},
    showToast: async () => {},
    getAccountLabel: () => "Account",
  });
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

  test("401 -> fresh retry 429 enters 429 handling and never marks success for failing account", async () => {
    const acct1 = createAccount({ uuid: "acct-1" });
    const acct2 = createAccount({ uuid: "acct-2", index: 1, refreshToken: "rt-2" });
    const manager = createRotatingManager([acct1, acct2]);
    const runtimeFactory = createQueuedRuntimeFactory({
      "acct-1": [
        jsonResponse(401, { error: "unauthorized" }),
        jsonResponse(429, { error: "rate_limited" }),
      ],
      "acct-2": [jsonResponse(200, { ok: true })],
    });

    const handleRateLimitResponse = vi.fn(async () => {});
    const { executeWithAccountRotation } = createExecutor(handleRateLimitResponse);

    const response = await executeWithAccountRotation(manager, runtimeFactory, client, "https://api.example.com");

    expect(response.status).toBe(200);
    expect(handleRateLimitResponse).toHaveBeenCalledTimes(1);
    expect(handleRateLimitResponse).toHaveBeenCalledWith(manager, client, acct1, expect.any(Response));
    expect(manager.markSuccess).toHaveBeenCalledTimes(1);
    expect(manager.markSuccess).toHaveBeenCalledWith("acct-2");
    expect(manager.markSuccess).not.toHaveBeenCalledWith("acct-1");
  });

  test("401 -> fresh retry 403 revoked marks account revoked and does not mark success", async () => {
    const acct1 = createAccount({ uuid: "acct-1" });
    const acct2 = createAccount({ uuid: "acct-2", index: 1, refreshToken: "rt-2" });
    const manager = createRotatingManager([acct1, acct2]);
    const runtimeFactory = createQueuedRuntimeFactory({
      "acct-1": [
        jsonResponse(401, { error: "unauthorized" }),
        jsonResponse(403, { error: "oauth token revoked" }),
      ],
      "acct-2": [jsonResponse(200, { ok: true })],
    });

    const { executeWithAccountRotation } = createExecutor(vi.fn(async () => {}));

    const response = await executeWithAccountRotation(manager, runtimeFactory, client, "https://api.example.com");

    expect(response.status).toBe(200);
    expect(manager.markRevoked).toHaveBeenCalledTimes(1);
    expect(manager.markRevoked).toHaveBeenCalledWith("acct-1");
    expect(manager.markSuccess).toHaveBeenCalledTimes(1);
    expect(manager.markSuccess).toHaveBeenCalledWith("acct-2");
    expect(manager.markSuccess).not.toHaveBeenCalledWith("acct-1");
  });

  test("401 -> fresh retry 403 non-revoked returns 403 without markSuccess", async () => {
    const acct1 = createAccount({ uuid: "acct-1" });
    const manager = createRotatingManager([acct1]);
    const runtimeFactory = createQueuedRuntimeFactory({
      "acct-1": [
        jsonResponse(401, { error: "unauthorized" }),
        jsonResponse(403, { error: "forbidden" }),
      ],
    });

    const { executeWithAccountRotation } = createExecutor(vi.fn(async () => {}));

    const response = await executeWithAccountRotation(manager, runtimeFactory, client, "https://api.example.com");

    expect(response.status).toBe(403);
    expect(manager.markRevoked).not.toHaveBeenCalled();
    expect(manager.markSuccess).not.toHaveBeenCalled();
  });

  test("401 -> fresh retry 500 consumes outer retry and does not mark success", async () => {
    const acct1 = createAccount({ uuid: "acct-1" });
    const acct2 = createAccount({ uuid: "acct-2", index: 1, refreshToken: "rt-2" });
    const manager = createRotatingManager([acct1, acct2]);
    const runtimeFactory = createQueuedRuntimeFactory({
      "acct-1": [
        jsonResponse(401, { error: "unauthorized" }),
        jsonResponse(500, { error: "server_error" }),
      ],
      "acct-2": [jsonResponse(200, { ok: true })],
    });

    const { executeWithAccountRotation } = createExecutor(vi.fn(async () => {}));

    const response = await executeWithAccountRotation(manager, runtimeFactory, client, "https://api.example.com");

    expect(response.status).toBe(200);
    expect(manager.markSuccess).toHaveBeenCalledTimes(1);
    expect(manager.markSuccess).toHaveBeenCalledWith("acct-2");
    expect(manager.markSuccess).not.toHaveBeenCalledWith("acct-1");
  });

  test("repeated 401 -> fresh 429 -> switch flow exhausts retry budget", async () => {
    const acct1 = createAccount({ uuid: "acct-1" });
    const acct2 = createAccount({ uuid: "acct-2", index: 1, refreshToken: "rt-2" });
    const manager = createRotatingManager([acct1, acct2]);
    const runtimeFactory = createQueuedRuntimeFactory({
      "acct-1": [
        jsonResponse(401, { error: "unauthorized" }),
        jsonResponse(429, { error: "rate_limited" }),
        jsonResponse(401, { error: "unauthorized" }),
        jsonResponse(429, { error: "rate_limited" }),
        jsonResponse(401, { error: "unauthorized" }),
        jsonResponse(429, { error: "rate_limited" }),
      ],
      "acct-2": [
        jsonResponse(401, { error: "unauthorized" }),
        jsonResponse(429, { error: "rate_limited" }),
        jsonResponse(401, { error: "unauthorized" }),
        jsonResponse(429, { error: "rate_limited" }),
        jsonResponse(401, { error: "unauthorized" }),
        jsonResponse(429, { error: "rate_limited" }),
      ],
    });

    const handleRateLimitResponse = vi.fn(async () => {});
    const { executeWithAccountRotation } = createExecutor(handleRateLimitResponse);

    await expect(
      executeWithAccountRotation(manager, runtimeFactory, client, "https://api.example.com"),
    ).rejects.toThrow("Exhausted 6 retries across all accounts");

    expect(handleRateLimitResponse).toHaveBeenCalledTimes(6);
    expect(manager.markSuccess).not.toHaveBeenCalled();
  });

  test("5xx server-retry token refresh error follows auth-failure path", async () => {
    const acct1 = createAccount({ uuid: "acct-1" });
    const acct2 = createAccount({ uuid: "acct-2", index: 1, refreshToken: "rt-2" });
    const manager = createRotatingManager([acct1, acct2]);
    const runtimeFactory = createQueuedRuntimeFactory({
      "acct-1": [
        jsonResponse(500, { error: "server_error" }),
        createTokenRefreshError(true, 401),
      ],
      "acct-2": [jsonResponse(200, { ok: true })],
    });

    const { executeWithAccountRotation } = createExecutor(vi.fn(async () => {}));

    const response = await executeWithAccountRotation(manager, runtimeFactory, client, "https://api.example.com");

    expect(response.status).toBe(200);
    expect(runtimeFactory.invalidate).toHaveBeenCalledWith("acct-1");
    expect(manager.markAuthFailure).toHaveBeenCalledWith(
      "acct-1",
      expect.objectContaining({ ok: false, permanent: true }),
    );
    expect(manager.markSuccess).toHaveBeenCalledTimes(1);
    expect(manager.markSuccess).toHaveBeenCalledWith("acct-2");
    expect(manager.markSuccess).not.toHaveBeenCalledWith("acct-1");
  });

  test("5xx server-retry network error continues outer retry loop", async () => {
    const acct1 = createAccount({ uuid: "acct-1" });
    const acct2 = createAccount({ uuid: "acct-2", index: 1, refreshToken: "rt-2" });
    const manager = createRotatingManager([acct1, acct2]);
    const runtimeFactory = createQueuedRuntimeFactory({
      "acct-1": [
        jsonResponse(500, { error: "server_error" }),
        new Error("network down"),
      ],
      "acct-2": [jsonResponse(200, { ok: true })],
    });

    const { executeWithAccountRotation } = createExecutor(vi.fn(async () => {}));

    const response = await executeWithAccountRotation(manager, runtimeFactory, client, "https://api.example.com");

    expect(response.status).toBe(200);
    expect(runtimeFactory.calls).toEqual(["acct-1", "acct-1", "acct-2"]);
    expect(manager.markAuthFailure).not.toHaveBeenCalled();
    expect(manager.markSuccess).toHaveBeenCalledTimes(1);
    expect(manager.markSuccess).toHaveBeenCalledWith("acct-2");
    expect(manager.markSuccess).not.toHaveBeenCalledWith("acct-1");
  });
});
