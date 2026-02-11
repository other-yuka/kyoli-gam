import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ManagedAccount, UsageLimits } from "../src/types";

const { fetchUsageMock, getConfigMock, showToastMock } = vi.hoisted(() => ({
  fetchUsageMock: vi.fn(),
  getConfigMock: vi.fn(),
  showToastMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("../src/usage", () => ({
  fetchUsage: fetchUsageMock,
}));

vi.mock("../src/config", () => ({
  getConfig: getConfigMock,
}));

vi.mock("../src/utils", () => ({
  formatWaitTime: (ms: number) => `${Math.ceil(ms / 1000)}s`,
  getAccountLabel: () => "Account 1",
  showToast: showToastMock,
}));

import {
  retryAfterMsFromResponse,
  fetchUsageLimits,
  getResetMsFromUsage,
  handleRateLimitResponse,
} from "../src/rate-limit";

function createAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    index: 0,
    uuid: "acct-1",
    accountId: "account-id-1",
    email: "user@example.com",
    planTier: "",
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

describe("rate-limit", () => {
  beforeEach(() => {
    getConfigMock.mockReturnValue({ default_retry_after_ms: 60_000 });
    fetchUsageMock.mockReset();
    showToastMock.mockClear();
  });

  test("retryAfterMsFromResponse parses retry-after-ms first", () => {
    const response = new Response("", { status: 429, headers: { "retry-after-ms": "1234", "retry-after": "2" } });
    expect(retryAfterMsFromResponse(response)).toBe(1234);
  });

  test("retryAfterMsFromResponse parses retry-after seconds", () => {
    const response = new Response("", { status: 429, headers: { "retry-after": "7" } });
    expect(retryAfterMsFromResponse(response)).toBe(7000);
  });

  test("retryAfterMsFromResponse falls back to config default", () => {
    const response = new Response("", { status: 429 });
    expect(retryAfterMsFromResponse(response)).toBe(60_000);
  });

  test("getResetMsFromUsage returns minimum positive reset from usage", () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const account = createAccount({
      cachedUsage: {
        five_hour: { utilization: 100, resets_at: new Date(now + 15_000).toISOString() },
        seven_day: { utilization: 100, resets_at: new Date(now + 30_000).toISOString() },
        seven_day_sonnet: null,
      },
    });

    expect(getResetMsFromUsage(account)).toBe(15_000);
    nowSpy.mockRestore();
  });

  test("fetchUsageLimits forwards accountId to usage API", async () => {
    const usage: UsageLimits = {
      five_hour: { utilization: 50, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    };
    fetchUsageMock.mockResolvedValue({ ok: true, data: usage });

    const result = await fetchUsageLimits("access-1", "account-id-7");

    expect(result).toEqual(usage);
    expect(fetchUsageMock).toHaveBeenCalledWith("access-1", "account-id-7");
  });

  test("fetchUsageLimits returns null when usage fetch throws", async () => {
    fetchUsageMock.mockRejectedValue(new Error("network"));
    const result = await fetchUsageLimits("access-1", "account-id-7");
    expect(result).toBeNull();
  });

  test("handleRateLimitResponse marks account and applies usage cache with accountId", async () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    const usageFromApi: UsageLimits = {
      five_hour: { utilization: 80, resets_at: new Date(now + 40_000).toISOString() },
      seven_day: null,
      seven_day_sonnet: null,
    };
    fetchUsageMock.mockResolvedValue({ ok: true, data: usageFromApi });

    const account = createAccount({
      cachedUsage: {
        five_hour: { utilization: 100, resets_at: new Date(now + 45_000).toISOString() },
        seven_day: null,
        seven_day_sonnet: null,
      },
      cachedUsageAt: now - 60_000,
    });

    const manager = {
      markRateLimited: vi.fn(async () => {}),
      applyUsageCache: vi.fn(async () => {}),
      getAccountCount: vi.fn(() => 2),
    };

    await handleRateLimitResponse(
      manager as any,
      { tui: { showToast: vi.fn(async () => {}) } } as any,
      account,
      new Response("", { status: 429, headers: { "retry-after-ms": "5000" } }),
    );

    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 45_000);
    expect(fetchUsageMock).toHaveBeenCalledWith("access-1", "account-id-1");
    expect(manager.applyUsageCache).toHaveBeenCalledWith("acct-1", usageFromApi);
    expect(showToastMock).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  test("handleRateLimitResponse uses header backoff and respects usage fetch cooldown", async () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    const account = createAccount({
      cachedUsage: undefined,
      cachedUsageAt: now - 10_000,
    });

    const manager = {
      markRateLimited: vi.fn(async () => {}),
      applyUsageCache: vi.fn(async () => {}),
      getAccountCount: vi.fn(() => 1),
    };

    await handleRateLimitResponse(
      manager as any,
      { tui: { showToast: vi.fn(async () => {}) } } as any,
      account,
      new Response("", { status: 429, headers: { "retry-after-ms": "7000" } }),
    );

    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 7000);
    expect(fetchUsageMock).not.toHaveBeenCalled();
    expect(manager.applyUsageCache).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  test("handleRateLimitResponse is a no-op when account uuid is missing", async () => {
    const manager = {
      markRateLimited: vi.fn(async () => {}),
      applyUsageCache: vi.fn(async () => {}),
      getAccountCount: vi.fn(() => 2),
    };

    await handleRateLimitResponse(
      manager as any,
      { tui: { showToast: vi.fn(async () => {}) } } as any,
      createAccount({ uuid: undefined }),
      new Response("", { status: 429, headers: { "retry-after-ms": "1000" } }),
    );

    expect(manager.markRateLimited).not.toHaveBeenCalled();
    expect(fetchUsageMock).not.toHaveBeenCalled();
  });
});
