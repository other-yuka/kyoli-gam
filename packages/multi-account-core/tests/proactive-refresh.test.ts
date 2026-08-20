import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createProactiveRefreshQueueForProvider } from "../src/proactive-refresh";
import type { AccountStore, DiskCredentials } from "../src/account-store";
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
        credentialOwnerId: account.credentialOwnerId,
        accountId: account.accountId,
        accountUuid: account.accountUuid,
        deviceId: account.deviceId,
      };
    },
    refreshAccountCredentials: async (
      uuid: string,
      _expected: DiskCredentials,
      refresh: (refreshToken: string) => Promise<TokenRefreshResult>,
    ) => {
      const account = storage.accounts.find((entry) => entry.uuid === uuid);
      if (!account) return { result: { ok: false as const, permanent: true }, account: null };
      const result = await refresh(account.refreshToken);
      if (result.ok) {
        account.accessToken = result.patch.accessToken;
        account.expiresAt = result.patch.expiresAt;
        if (result.patch.refreshToken) account.refreshToken = result.patch.refreshToken;
      }
      return { result, account: { ...account } };
    },
    mutateAccount: async (uuid: string, fn: (account: StoredAccount) => void) => {
      const account = storage.accounts.find((entry) => entry.uuid === uuid);
      if (!account) return null;
      fn(account);
      return { ...account };
    },
    mutateStorage: async (fn: (storage: { version: 1; accounts: StoredAccount[] }) => void) => {
      fn(storage);
    },
    mutateStorageIfCredentialsMatch: async (
      uuid: string,
      expected: DiskCredentials,
      fn: (account: StoredAccount, current: { version: 1; accounts: StoredAccount[] }) => void,
    ) => {
      const account = storage.accounts.find((entry) => entry.uuid === uuid);
      if (!account
        || account.refreshToken !== expected.refreshToken
        || account.accessToken !== expected.accessToken
        || account.expiresAt !== expected.expiresAt) {
        return false;
      }
      fn(account, storage);
      return true;
    },
    removeAccount: async (uuid: string) => {
      const initialLength = storage.accounts.length;
      storage.accounts = storage.accounts.filter((entry) => entry.uuid !== uuid);
      return storage.accounts.length !== initialLength;
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
      providerAuthId: "openai",
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
      providerAuthId: "openai",
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

  test("permanent proactive refresh failure disables account and keeps provider auth", async () => {
    let scheduledCallback: (() => void) | null = null;
    globalThis.setTimeout = ((handler: TimerHandler) => {
      if (typeof handler !== "function") {
        throw new Error("Expected timeout function");
      }
      scheduledCallback = () => {
        handler();
      };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const authSetSpy = vi.fn(async () => {});
    const client: PluginClient = {
      auth: { set: authSetSpy },
      tui: { showToast: async () => {} },
      app: { log: async () => {} },
    };

    const account: StoredAccount = {
      uuid: "acct-1",
      planTier: "",
      refreshToken: "refresh-1",
      accessToken: "access-1",
      expiresAt: Date.now() + 60_000,
      addedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
    };

    const store = createStore([account]);
    const ProactiveRefreshQueue = createProactiveRefreshQueueForProvider({
      providerAuthId: "anthropic",
      getConfig: () => createConfig({ proactive_refresh: true }),
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: true } as TokenRefreshResult),
      debugLog: () => {},
    });

    const queue = new ProactiveRefreshQueue(client, store);
    queue.start();
    if (!scheduledCallback) {
      throw new Error("Expected scheduled callback");
    }

    const callback = scheduledCallback as () => void;
    callback();
    const inFlight = (queue as unknown as { inFlight: Promise<void> | null }).inFlight;
    if (inFlight) {
      await inFlight;
    }

    const persisted = await store.load();
    expect(persisted.accounts).toHaveLength(1);
    expect(persisted.accounts[0]).toMatchObject({
      uuid: "acct-1",
      isAuthDisabled: true,
      authDisabledReason: "refresh failed permanently (proactive refresh)",
    });
    expect(authSetSpy).not.toHaveBeenCalled();
  });

  test("does not persist a proactive failure after another process wins", async () => {
    let scheduledCallback: (() => void) | null = null;
    globalThis.setTimeout = ((handler: TimerHandler) => {
      if (typeof handler !== "function") throw new Error("Expected timeout function");
      scheduledCallback = () => handler();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    const account: StoredAccount = {
      uuid: "acct-race",
      planTier: "",
      refreshToken: "refresh-old",
      accessToken: "access-old",
      expiresAt: Date.now() + 60_000,
      addedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
    };
    const store = createStore([account]);
    vi.spyOn(store, "refreshAccountCredentials").mockImplementation(async () => {
      account.refreshToken = "refresh-winner";
      account.accessToken = "access-winner";
      account.expiresAt = Date.now() + 120_000;
      return { result: { ok: false, permanent: true }, account: { ...account } };
    });
    const ProactiveRefreshQueue = createProactiveRefreshQueueForProvider({
      providerAuthId: "anthropic",
      getConfig: () => createConfig({ proactive_refresh: true }),
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: true }),
      debugLog: () => {},
    });

    const queue = new ProactiveRefreshQueue(createClient(), store);
    queue.start();
    if (!scheduledCallback) throw new Error("Expected scheduled callback");
    (scheduledCallback as () => void)();
    const inFlight = (queue as unknown as { inFlight: Promise<void> | null }).inFlight;
    if (inFlight) await inFlight;

    expect(account).toMatchObject({
      refreshToken: "refresh-winner",
      accessToken: "access-winner",
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
    });
  });
});
