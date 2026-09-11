import { beforeEach, describe, expect, test, vi } from "vitest";
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

  test("waits for every exhausted cached usage window", async () => {
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

    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 25_000);
    expect(fetchUsage).toHaveBeenCalledWith("access-1", "acct-id-1");
    expect(manager.applyUsageCache).toHaveBeenCalledWith(
      "acct-1",
      usage,
      { preserveActiveRateLimit: true },
    );
    expect(showToast).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  test("uses the matching Sonnet reset after a Sonnet rate-limit response", async () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const usage: UsageLimits = {
      five_hour: { utilization: 20, resets_at: null },
      seven_day: { utilization: 30, resets_at: null },
      seven_day_sonnet: { utilization: 40, resets_at: null },
    };
    const account = createAccount({
      cachedUsage: {
        five_hour: { utilization: 20, resets_at: null },
        seven_day: { utilization: 30, resets_at: null },
        seven_day_sonnet: {
          utilization: 100,
          resets_at: new Date(now + 3_600_000).toISOString(),
        },
      },
      cachedUsageAt: now - 60_000,
    });
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
      new Response("", {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-representative-claim": "seven_day_sonnet",
          "retry-after": "60",
        },
      }),
    );

    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 3_600_000);
    expect(manager.applyUsageCache).toHaveBeenCalledWith(
      "acct-1",
      usage,
      { preserveActiveRateLimit: true },
    );
    nowSpy.mockRestore();
  });

  test("parks the account before waiting for a usage refresh", async () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const usage: UsageLimits = {
      five_hour: { utilization: 20, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    };
    let resolveUsage: ((result: { ok: true; data: UsageLimits }) => void) | undefined;
    fetchUsage.mockImplementation(() => new Promise((resolve) => {
      resolveUsage = resolve;
    }));
    const account = createAccount({ cachedUsageAt: now - 60_000 });
    const manager = {
      markRateLimited: vi.fn(async () => {}),
      applyUsageCache: vi.fn(async () => {}),
      getAccountCount: vi.fn(() => 2),
    };

    const handling = handlers.handleRateLimitResponse(
      manager,
      createClient(),
      account,
      new Response("", { status: 429, headers: { "retry-after": "60" } }),
    );
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    const parkedBeforeRefreshResolved = manager.markRateLimited.mock.calls.length === 1;
    resolveUsage?.({ ok: true, data: usage });
    await handling;

    expect(parkedBeforeRefreshResolved).toBe(true);
    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 60_000);
    expect(manager.applyUsageCache).toHaveBeenCalledWith(
      "acct-1",
      usage,
      { preserveActiveRateLimit: true },
    );
    nowSpy.mockRestore();
  });

  test("ignores non-exhausted cached resets", async () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const account = createAccount({
      cachedUsage: {
        five_hour: { utilization: 92, resets_at: new Date(now + 3_600_000).toISOString() },
        seven_day: { utilization: 34, resets_at: new Date(now + 86_400_000).toISOString() },
        seven_day_sonnet: null,
      },
    });
    const manager = {
      markRateLimited: vi.fn(async () => {}),
      applyUsageCache: vi.fn(async () => {}),
      getAccountCount: vi.fn(() => 2),
    };

    await handlers.handleRateLimitResponse(
      manager,
      createClient(),
      account,
      new Response("", {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-representative-claim": "unknown",
          "retry-after": "60",
        },
      }),
    );

    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 60_000);
    nowSpy.mockRestore();
  });

  test("prefers a provider non-exhausted claim over a stale exhausted cache", async () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const account = createAccount({
      cachedUsage: {
        five_hour: { utilization: 100, resets_at: new Date(now + 12 * 60 * 60 * 1000).toISOString() },
        seven_day: { utilization: 40, resets_at: null },
        seven_day_sonnet: null,
      },
    });
    const manager = {
      markRateLimited: vi.fn(async () => {}),
      applyUsageCache: vi.fn(async () => {}),
      getAccountCount: vi.fn(() => 2),
    };
    fetchUsage.mockResolvedValue({
      ok: true,
      data: {
        five_hour: { utilization: 80, resets_at: new Date(now + 30_000).toISOString() },
        seven_day: null,
        seven_day_sonnet: null,
      },
    });

    await handlers.handleRateLimitResponse(
      manager,
      createClient(),
      account,
      new Response("", {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "0.92",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "retry-after": "60",
        },
      }),
    );

    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 60_000);
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(manager.applyUsageCache).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  test("preserves a provider reset for an exhausted unknown Claude claim", async () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const resetSeconds = Math.floor(now / 1000) + 3600;
    const account = createAccount({
      cachedUsage: {
        five_hour: { utilization: 100, resets_at: new Date(now + 12 * 60 * 60 * 1000).toISOString() },
        seven_day: { utilization: 40, resets_at: null },
        seven_day_sonnet: null,
      },
      cachedUsageAt: now - 60_000,
    });
    fetchUsage.mockResolvedValue({
      ok: true,
      data: {
        five_hour: { utilization: 20, resets_at: null },
        seven_day: null,
        seven_day_sonnet: null,
      },
    });
    const manager = {
      markRateLimited: vi.fn(async () => {}),
      applyUsageCache: vi.fn(async () => {}),
      getAccountCount: vi.fn(() => 2),
    };

    await handlers.handleRateLimitResponse(
      manager,
      createClient(),
      account,
      new Response("", {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "1.04",
          "anthropic-ratelimit-unified-7d-utilization": "0.42",
          "anthropic-ratelimit-unified-representative-claim": "mystery_window",
          "anthropic-ratelimit-unified-reset": String(resetSeconds),
          "retry-after": "60",
        },
      }),
    );

    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 3_600_000, {
      five_hour: { utilization: 100, resets_at: new Date(now + 3_600_000).toISOString() },
      seven_day: { utilization: 42, resets_at: null },
      seven_day_sonnet: null,
    });
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(manager.applyUsageCache).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  test("preserves a Retry-After boundary later than an exhausted provider reset", async () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const resetSeconds = Math.floor(now / 1000) + 60;
    const manager = {
      markRateLimited: vi.fn(async () => {}),
      applyUsageCache: vi.fn(async () => {}),
      getAccountCount: vi.fn(() => 1),
    };

    await handlers.handleRateLimitResponse(
      manager,
      createClient(),
      createAccount(),
      new Response("", {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "1",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-reset": String(resetSeconds),
          "retry-after": "120",
        },
      }),
    );

    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 120_000, {
      five_hour: { utilization: 100, resets_at: new Date(now + 60_000).toISOString() },
      seven_day: null,
      seven_day_sonnet: null,
    });
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(manager.applyUsageCache).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  test("keeps an exhausted cache when an unknown provider claim has malformed utilization", async () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const account = createAccount({
      cachedUsage: {
        five_hour: { utilization: 100, resets_at: new Date(now + 12 * 60 * 60 * 1000).toISOString() },
        seven_day: { utilization: 40, resets_at: null },
        seven_day_sonnet: null,
      },
    });
    const manager = {
      markRateLimited: vi.fn(async () => {}),
      applyUsageCache: vi.fn(async () => {}),
      getAccountCount: vi.fn(() => 2),
    };

    await handlers.handleRateLimitResponse(
      manager,
      createClient(),
      account,
      new Response("", {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "0.92junk",
          "anthropic-ratelimit-unified-7d-utilization": "-1",
          "anthropic-ratelimit-unified-representative-claim": "unknown",
          "retry-after": "60",
        },
      }),
    );

    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 12 * 60 * 60 * 1000);
    nowSpy.mockRestore();
  });

  test("quarantines non-subscription billing claims without refreshing usage", async () => {
    const account = createAccount({
      cachedUsageAt: Date.now() - 50_000,
    });
    const manager = {
      markRateLimited: vi.fn(async () => {}),
      applyUsageCache: vi.fn(async () => {}),
      getAccountCount: vi.fn(() => 2),
    };

    await handlers.handleRateLimitResponse(
      manager,
      createClient(),
      account,
      new Response(JSON.stringify({ error: { message: "blocked" } }), {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-representative-claim": "api",
          "retry-after-ms": "5000",
        },
      }),
    );

    expect(manager.markRateLimited).toHaveBeenCalledWith("acct-1", 24 * 60 * 60 * 1000);
    expect(fetchUsage).not.toHaveBeenCalled();
    expect(manager.applyUsageCache).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.anything(),
      "Account 1 blocked non-subscription billing claim (api). Switching...",
      "warning",
    );
  });
});
