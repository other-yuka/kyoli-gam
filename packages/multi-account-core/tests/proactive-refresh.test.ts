import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createProactiveRefreshQueueForProvider } from "../src/proactive-refresh";
import type { AccountStore } from "../src/account-store";
import type { PluginClient, PluginConfig, StoredAccount, TokenRefreshResult } from "../src/types";

function createConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    account_selection_strategy: "sticky",
    cross_process_claims: true,
    soft_quota_threshold_percent: 100,
    rate_limit_min_backoff_ms: 30_000,
    default_retry_after_ms: 60_000,
    max_consecutive_auth_failures: 3,
    token_failure_backoff_ms: 30_000,
    proactive_refresh: true,
    proactive_refresh_buffer_seconds: 1800,
    proactive_refresh_interval_seconds: 300,
    quiet_mode: false,
    debug: false,
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

function createStore(accounts: StoredAccount[]): AccountStore {
  const storage = { version: 1 as const, accounts };
  const store = {
    load: async () => storage,
    readCredentials: async (uuid: string) => {
      const account = storage.accounts.find((entry) => entry.uuid === uuid);
      if (!account) return null;
      return {
        refreshToken: account.refreshToken,
        accessToken: account.accessToken,
        expiresAt: account.expiresAt,
      };
    },
    mutateAccount: async (uuid: string, fn: (account: StoredAccount) => void) => {
      const account = storage.accounts.find((entry) => entry.uuid === uuid);
      if (!account) return null;
      fn(account);
      return { ...account };
    },
  };

  return store as unknown as AccountStore;
}

describe("core/proactive-refresh", () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  test("start does nothing when proactive refresh is disabled", () => {
    const setTimeoutSpy = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>);
    globalThis.setTimeout = setTimeoutSpy as unknown as typeof setTimeout;

    const ProactiveRefreshQueue = createProactiveRefreshQueueForProvider({
      getConfig: () => createConfig({ proactive_refresh: false }),
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false } as TokenRefreshResult),
      debugLog: () => {},
    });

    const queue = new ProactiveRefreshQueue(createClient(), createStore([]));
    queue.start();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  test("start schedules initial check and stop clears it", async () => {
    const handle = 123 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.fn(() => handle);
    const clearTimeoutSpy = vi.fn();

    globalThis.setTimeout = setTimeoutSpy as unknown as typeof setTimeout;
    globalThis.clearTimeout = clearTimeoutSpy as unknown as typeof clearTimeout;

    const ProactiveRefreshQueue = createProactiveRefreshQueueForProvider({
      getConfig: () => createConfig({ proactive_refresh: true }),
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false } as TokenRefreshResult),
      debugLog: () => {},
    });

    const queue = new ProactiveRefreshQueue(createClient(), createStore([]));
    queue.start();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);

    await queue.stop();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);
  });
});
