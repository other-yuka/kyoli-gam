import { beforeEach, describe, expect, test, vi } from "bun:test";
import { CascadeStateManager, PoolManager, type PoolChainConfig } from "opencode-multi-account-core";
import { executeWithAccountRotation } from "../src/executor";
import { executeWithPoolChainRotation, type PoolChainAccountManager } from "../src/pool-chain-executor";
import { createMockClient } from "./helpers";
import type { ManagedAccount, PluginClient } from "../src/types";
import type { ExecutorRuntimeFactory } from "opencode-multi-account-core";

function createAccount(uuid: string): ManagedAccount {
  return {
    index: Number(uuid.replace("acct-", "")) || 0,
    uuid,
    email: `${uuid}@example.com`,
    refreshToken: `rt-${uuid}`,
    addedAt: Date.now(),
    lastUsed: Date.now(),
    enabled: true,
    consecutiveAuthFailures: 0,
    isAuthDisabled: false,
  };
}

type MockPoolChainManager = PoolChainAccountManager & {
  getAccountCount: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  selectAccount: ReturnType<typeof vi.fn>;
  markSuccess: ReturnType<typeof vi.fn>;
  markAuthFailure: ReturnType<typeof vi.fn>;
  markRevoked: ReturnType<typeof vi.fn>;
  hasAnyUsableAccount: ReturnType<typeof vi.fn>;
  getMinWaitTime: ReturnType<typeof vi.fn>;
  markRateLimited: ReturnType<typeof vi.fn>;
  applyUsageCache: ReturnType<typeof vi.fn>;
  getAccounts: ReturnType<typeof vi.fn>;
  isRateLimited: ReturnType<typeof vi.fn>;
  getActiveAccount: ReturnType<typeof vi.fn>;
};

function createMockPoolChainManager(accounts: ManagedAccount[]): MockPoolChainManager {
  let activeUuid = accounts[0]?.uuid;
  const rateLimitedUntil = new Map<string, number>();

  const isRateLimited = (uuid: string | undefined): boolean => {
    if (!uuid) return true;
    const resetAt = rateLimitedUntil.get(uuid);
    return typeof resetAt === "number" && resetAt > Date.now();
  };

  const manager: MockPoolChainManager = {
    getAccountCount: vi.fn(() => accounts.length),
    refresh: vi.fn(async () => {}),
    selectAccount: vi.fn(async () => {
      const active = accounts.find((account) => account.uuid === activeUuid);
      if (active && !isRateLimited(active.uuid) && active.enabled && !active.isAuthDisabled) {
        return active;
      }

      return accounts.find((account) => !isRateLimited(account.uuid) && account.enabled && !account.isAuthDisabled) ?? null;
    }),
    markSuccess: vi.fn(async (uuid: string) => {
      activeUuid = uuid;
      rateLimitedUntil.delete(uuid);
    }),
    markAuthFailure: vi.fn(async () => {}),
    markRevoked: vi.fn(async () => {}),
    hasAnyUsableAccount: vi.fn(() => true),
    getMinWaitTime: vi.fn(() => 0),
    markRateLimited: vi.fn(async (uuid: string, backoffMs?: number) => {
      rateLimitedUntil.set(uuid, Date.now() + (backoffMs ?? 60_000));
    }),
    applyUsageCache: vi.fn(async () => {}),
    getAccounts: vi.fn(() => accounts),
    isRateLimited: vi.fn((account: ManagedAccount) => isRateLimited(account.uuid)),
    getActiveAccount: vi.fn(() => accounts.find((account) => account.uuid === activeUuid) ?? null),
  };

  return manager;
}

function createRuntimeFactoryByUuid(
  handlers: Record<string, () => Promise<Response>>,
): ExecutorRuntimeFactory & {
  getRuntime: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
  calls: string[];
} {
  const calls: string[] = [];
  const getRuntime = vi.fn(async (uuid: string) => ({
    fetch: async () => {
      calls.push(uuid);
      const handler = handlers[uuid];
      if (!handler) throw new Error(`Missing runtime handler for ${uuid}`);
      return handler();
    },
  }));

  return {
    getRuntime,
    invalidate: vi.fn(() => {}),
    calls,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "retry-after-ms": "10" },
  });
}

describe("pool-chain executor integration", () => {
  let client: PluginClient;

  beforeEach(() => {
    client = createMockClient();
  });

  test("keeps no-config fallback path untouched", async () => {
    const manager = createMockPoolChainManager([createAccount("acct-1")]);
    const runtimeFactory = createRuntimeFactoryByUuid({
      "acct-1": async () => jsonResponse({ ok: true }, 200),
    });

    const cascadeStateManager = new CascadeStateManager();
    const startTurnSpy = vi.spyOn(cascadeStateManager, "startTurn");

    const response = await executeWithAccountRotation(
      manager,
      runtimeFactory,
      client,
      "https://api.example.com/v1/messages",
      { method: "POST", body: JSON.stringify({ prompt: "hello" }) },
      {
        poolManager: new PoolManager(),
        cascadeStateManager,
        poolChainConfig: { pools: [], chains: [] },
      },
    );

    expect(response.status).toBe(200);
    expect(startTurnSpy).not.toHaveBeenCalled();
    expect(manager.selectAccount).toHaveBeenCalledTimes(1);
  });

  test("on 429 marks exhausted account and rotates to pool candidate", async () => {
    const manager = createMockPoolChainManager([
      createAccount("acct-1"),
      createAccount("acct-2"),
    ]);

    let firstAccountCalls = 0;
    const runtimeFactory = createRuntimeFactoryByUuid({
      "acct-1": async () => {
        firstAccountCalls += 1;
        return firstAccountCalls === 1
          ? jsonResponse({ error: "rate_limited" }, 429)
          : jsonResponse({ ok: true, account: "acct-1" }, 200);
      },
      "acct-2": async () => jsonResponse({ ok: true, account: "acct-2" }, 200),
    });

    const poolManager = new PoolManager();
    const cascadeStateManager = new CascadeStateManager();
    const poolChainConfig: PoolChainConfig = {
      pools: [
        { name: "primary", baseProvider: "anthropic", members: ["acct-1", "acct-2"], enabled: true },
      ],
      chains: [],
    };

    const response = await executeWithPoolChainRotation(
      manager,
      runtimeFactory,
      poolManager,
      cascadeStateManager,
      poolChainConfig,
      client,
      "https://api.example.com/v1/messages",
      { method: "POST", body: JSON.stringify({ prompt: "pool-rotate" }) },
    );

    expect(response.status).toBe(200);
    expect(runtimeFactory.calls[0]).toBe("acct-1");
    expect(runtimeFactory.calls[1]).toBe("acct-2");
    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", expect.any(Number));
    expect(cascadeStateManager.getSnapshot()).toBeNull();
  });

  test("threads attempted accounts so prior failures are skipped", async () => {
    const manager = createMockPoolChainManager([
      createAccount("acct-1"),
      createAccount("acct-2"),
      createAccount("acct-3"),
    ]);

    let acct1Calls = 0;
    let acct2Calls = 0;
    const runtimeFactory = createRuntimeFactoryByUuid({
      "acct-1": async () => {
        acct1Calls += 1;
        return acct1Calls === 1
          ? jsonResponse({ error: "rate_limited" }, 429)
          : jsonResponse({ ok: true, account: "acct-1" }, 200);
      },
      "acct-2": async () => {
        acct2Calls += 1;
        return acct2Calls === 1
          ? jsonResponse({ error: "rate_limited" }, 429)
          : jsonResponse({ ok: true, account: "acct-2" }, 200);
      },
      "acct-3": async () => jsonResponse({ ok: true, account: "acct-3" }, 200),
    });

    const poolManager = new PoolManager();
    const cascadeStateManager = new CascadeStateManager();
    const poolChainConfig: PoolChainConfig = {
      pools: [
        { name: "primary", baseProvider: "anthropic", members: ["acct-1", "acct-2", "acct-3"], enabled: true },
      ],
      chains: [],
    };

    const response = await executeWithPoolChainRotation(
      manager,
      runtimeFactory,
      poolManager,
      cascadeStateManager,
      poolChainConfig,
      client,
      "https://api.example.com/v1/messages",
      { method: "POST", body: JSON.stringify({ prompt: "cascade-preserve" }) },
    );

    expect(response.status).toBe(200);
    expect(runtimeFactory.calls).toEqual(["acct-1", "acct-2", "acct-3"]);
    expect(manager.markRateLimited).toHaveBeenCalledTimes(2);
    expect(cascadeStateManager.getSnapshot()).toBeNull();
  });
});
