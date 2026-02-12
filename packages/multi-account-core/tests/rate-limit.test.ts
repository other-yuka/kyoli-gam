import { beforeEach, describe, expect, test, vi } from "bun:test";
import { createRateLimitHandlers } from "../src/rate-limit";
import type { ManagedAccount, PluginClient, UsageLimits } from "../src/types";

function createAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    index: 0,
    uuid: "acct-1",
    accountId: "acct-id-1",
    refreshToken: "refresh-1",
    accessToken: "access-1",
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

describe("core/rate-limit", () => {
  const fetchUsage = vi.fn();
  const showToast = vi.fn(async () => {});

  const handlers = createRateLimitHandlers({
    fetchUsage,
    getConfig: () => ({ default_retry_after_ms: 60_000 }),
    formatWaitTime: (ms) => `${Math.ceil(ms / 1000)}s`,
    getAccountLabel: () => "Account 1",
    showToast,
  });

  beforeEach(() => {
    fetchUsage.mockReset();
    showToast.mockClear();
  });

  test("parses retry-after-ms with highest priority", () => {
    const response = new Response("", { status: 429, headers: { "retry-after-ms": "2345", "retry-after": "7" } });
    expect(handlers.retryAfterMsFromResponse(response)).toBe(2345);
  });

  test("uses usage reset time when available", async () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    const account = createAccount({
      cachedUsage: {
        five_hour: { utilization: 100, resets_at: new Date(now + 10_000).toISOString() },
        seven_day: { utilization: 100, resets_at: new Date(now + 25_000).toISOString() },
        seven_day_sonnet: null,
      },
      cachedUsageAt: now - 50_000,
    });

    const usage: UsageLimits = {
      five_hour: { utilization: 80, resets_at: new Date(now + 30_000).toISOString() },
      seven_day: null,
      seven_day_sonnet: null,
    };
    fetchUsage.mockResolvedValue({ ok: true, data: usage });

    const manager = {
      markRateLimited: vi.fn(async () => {}),
      applyUsageCache: vi.fn(async () => {}),
      getAccountCount: vi.fn(() => 2),
    };

    await handlers.handleRateLimitResponse(
      manager,
      createClient(),
      account,
      new Response("", { status: 429, headers: { "retry-after-ms": "5000" } }),
    );

    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 10_000);
    expect(fetchUsage).toHaveBeenCalledWith("access-1", "acct-id-1");
    expect(manager.applyUsageCache).toHaveBeenCalledWith("acct-1", usage);
    expect(showToast).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });
});
