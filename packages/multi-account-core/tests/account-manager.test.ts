import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAccountManagerForProvider } from "../src/account-manager";
import { AccountStore } from "../src/account-store";
import { ACCOUNTS_FILENAME, setAccountsFilename } from "../src/constants";
import { initCoreConfig, loadConfig, resetConfigCache, updateConfigField } from "../src/config";
import type { OAuthCredentials, PluginClient, TokenRefreshResult } from "../src/types";
import { createMockClient, setupTestEnv } from "./helpers";

const CONFIG_FILE = "core-account-manager-config.test.json";
const ACCOUNTS_FILE = "core-account-manager-accounts.test.json";

let cleanup: (() => Promise<void>) | undefined;

function getUuid(value: string | undefined): string {
  expect(value).toBeDefined();
  return value as string;
}

function createAuth(id: string): OAuthCredentials {
  return {
    type: "oauth",
    refresh: `refresh-${id}`,
    access: `access-${id}`,
    expires: Date.now() + 60_000,
  };
}

describe("core/account-manager", () => {
  beforeEach(async () => {
    const env = await setupTestEnv();
    cleanup = env.cleanup;
    setAccountsFilename(ACCOUNTS_FILE);
    initCoreConfig(CONFIG_FILE);
    resetConfigCache();
    await loadConfig();
    await updateConfigField("cross_process_claims", false);
  });

  afterEach(async () => {
    setAccountsFilename(ACCOUNTS_FILENAME);
    resetConfigCache();
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  test("creates manager from current auth when storage is empty", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "openai",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    expect(manager.getAccounts()).toHaveLength(1);
    expect(manager.getActiveAccount()?.refreshToken).toBe("refresh-seed");
  });

  test("selects according to sticky strategy", async () => {
    const refreshToken = vi.fn(async () => ({ ok: false, permanent: false } as TokenRefreshResult));
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "openai",
      isTokenExpired: () => false,
      refreshToken,
    });

    const store = new AccountStore();
    const manager = await AccountManager.create(store, createAuth("a1"));
    await manager.addAccount(createAuth("a2"));

    const selected = await manager.selectAccount();
    expect(selected?.uuid).toBe(manager.getActiveAccount()?.uuid);
    expect(refreshToken).not.toHaveBeenCalled();
  });

  test("persists provider identity metadata when adding an account", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const store = new AccountStore();
    const manager = await AccountManager.create(store, createAuth("a1"));
    await manager.addAccount(createAuth("a2"), "a2@example.com", {
      accountId: "provider-account-2",
      accountUuid: "claude-account-2",
      deviceId: "claude-device-2",
    });

    const added = manager.getAccounts().find((account) => account.email === "a2@example.com");
    expect(added).toMatchObject({
      accountId: "provider-account-2",
      accountUuid: "claude-account-2",
      deviceId: "claude-device-2",
    });

    const storage = await store.load();
    const stored = storage.accounts.find((account) => account.email === "a2@example.com");
    expect(stored).toMatchObject({
      accountId: "provider-account-2",
      accountUuid: "claude-account-2",
      deviceId: "claude-device-2",
    });
  });

  test("keeps sticky bindings per session key", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "openai",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const store = new AccountStore();
    const manager = await AccountManager.create(store, createAuth("a1"));
    await manager.addAccount(createAuth("a2"));
    await manager.addAccount(createAuth("a3"));

    const first = await manager.selectAccount("session-a");
    const firstUuid = getUuid(first?.uuid);

    await manager.markRateLimited(firstUuid, 60_000);
    const rebound = await manager.selectAccount("session-a");
    const reboundUuid = getUuid(rebound?.uuid);

    await manager.markRateLimited(reboundUuid, 60_000);
    const otherSession = await manager.selectAccount("session-b");
    const otherSessionUuid = getUuid(otherSession?.uuid);

    await manager.markSuccess(reboundUuid);
    const stickyAgain = await manager.selectAccount("session-a");

    expect(reboundUuid).not.toBe(firstUuid);
    expect(otherSessionUuid).not.toBe(reboundUuid);
    expect(stickyAgain?.uuid).toBe(reboundUuid);
  });

  test("hybrid selection prefers accounts under pace for their reset window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T00:00:00.000Z"));
    try {
      await updateConfigField("account_selection_strategy", "hybrid");
      const AccountManager = createAccountManagerForProvider({
        providerAuthId: "openai",
        isTokenExpired: () => false,
        refreshToken: async () => ({ ok: false, permanent: false }),
      });
      const manager = await AccountManager.create(new AccountStore(), createAuth("a1"));
      await manager.addAccount(createAuth("a2"));
      const accounts = manager.getAccounts();
      const overPace = accounts[0];
      const underPace = accounts[1];
      if (!overPace?.uuid || !underPace?.uuid) {
        throw new Error("Expected two accounts");
      }

      await manager.applyUsageCache(overPace.uuid, {
        five_hour: null,
        seven_day: { utilization: 80, resets_at: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString() },
        seven_day_sonnet: null,
      });
      await manager.applyUsageCache(underPace.uuid, {
        five_hour: null,
        seven_day: { utilization: 60, resets_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() },
        seven_day_sonnet: null,
      });

      const selected = await manager.selectAccount();

      expect(selected?.uuid).toBe(underPace.uuid);
    } finally {
      vi.useRealTimers();
    }
  });

  test("ensureValidToken refreshes expired token and syncs active account", async () => {
    const refreshToken = vi.fn(async () => ({
      ok: true,
      patch: {
        accessToken: "new-access",
        expiresAt: Date.now() + 120_000,
        refreshToken: "new-refresh",
      },
    }) as TokenRefreshResult);

    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "openai",
      isTokenExpired: () => true,
      refreshToken,
    });

    const store = new AccountStore();
    const manager = await AccountManager.create(store, createAuth("expiring"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);

    const client = createMockClient() as PluginClient;
    const authSetSpy = vi.spyOn(client.auth, "set");
    manager.setClient(client);

    const result = await manager.ensureValidToken(activeUuid, client);
    expect(result.ok).toBe(true);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(authSetSpy).toHaveBeenCalledTimes(1);
  });

  test("markAuthFailure disables account on permanent failure instead of removing it", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: true }),
    });

    const client = createMockClient() as PluginClient;
    const authSetSpy = vi.spyOn(client.auth, "set");
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"), client);
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);

    await manager.markAuthFailure(activeUuid, { ok: false, permanent: true });
    await manager.refresh();

    expect(manager.getAccounts()).toHaveLength(1);
    expect(manager.getAccounts()[0]).toMatchObject({
      uuid: activeUuid,
      isAuthDisabled: true,
      authDisabledReason: "refresh failed permanently",
    });
    expect(authSetSpy).not.toHaveBeenCalled();
  });

  test("does not persist a late refresh failure over winner credentials", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: true }),
    });

    const store = new AccountStore();
    const manager = await AccountManager.create(store, createAuth("seed"));
    const initial = manager.getActiveAccount();
    const activeUuid = getUuid(initial?.uuid);
    if (!initial) throw new Error("Expected active account");

    await store.mutateAccount(activeUuid, (account) => {
      account.refreshToken = "refresh-winner";
      account.accessToken = "access-winner";
      account.expiresAt = Date.now() + 120_000;
      account.consecutiveAuthFailures = 0;
      account.isAuthDisabled = false;
      account.authDisabledReason = undefined;
    });
    await manager.markAuthFailure(activeUuid, { ok: false, permanent: true }, initial);

    const persisted = (await store.load()).accounts.find((account) => account.uuid === activeUuid);
    expect(persisted).toMatchObject({
      refreshToken: "refresh-winner",
      accessToken: "access-winner",
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
    });
  });

  test("markRevoked removes account and clears provider auth when last", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const client = createMockClient() as PluginClient;
    const authSetSpy = vi.spyOn(client.auth, "set");
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"), client);
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);

    await manager.markRevoked(activeUuid);
    await manager.refresh();

    expect(manager.getAccounts()).toHaveLength(0);
    expect(authSetSpy).toHaveBeenCalledWith({
      path: { id: "anthropic" },
      body: { type: "oauth", refresh: "", access: "", expires: 0 },
    });
  });

  test("applyUsageCache clears stale rateLimitResetAt when usage is no longer exhausted", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "openai",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);

    await manager.markRateLimited(activeUuid, 60_000);
    await manager.applyUsageCache(activeUuid, {
      five_hour: { utilization: 0, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: { utilization: 40, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
      seven_day_sonnet: null,
    });
    await manager.refresh();

    expect(manager.getActiveAccount()?.rateLimitResetAt).toBe(undefined);
  });

  test("applyUsageCache waits for every exhausted usage window", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);

    await manager.applyUsageCache(activeUuid, {
      five_hour: { utilization: 100, resets_at: new Date(now + 10_000).toISOString() },
      seven_day: { utilization: 100, resets_at: new Date(now + 25_000).toISOString() },
      seven_day_sonnet: null,
    });
    await manager.refresh();

    expect(manager.getActiveAccount()?.rateLimitResetAt).toBe(now + 25_000);
    expect(manager.getMinWaitTime()).toBe(25_000);
    nowSpy.mockRestore();
  });

  test("persists a rate-limit usage snapshot in the cooldown mutation", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const store = new AccountStore();
    const manager = await AccountManager.create(store, createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const mutateAccount = vi.spyOn(store, "mutateAccount");
    const usage = {
      five_hour: { utilization: 100, resets_at: new Date(Date.now() + 60_000).toISOString() },
      seven_day: null,
      seven_day_sonnet: null,
    };

    await manager.markRateLimited(activeUuid, 60_000, usage);
    await manager.refresh();

    expect(mutateAccount).toHaveBeenCalledTimes(1);
    expect(manager.getActiveAccount()).toMatchObject({
      cachedUsage: usage,
      cachedUsageAt: expect.any(Number),
      rateLimitResetAt: expect.any(Number),
    });
  });

  test("keeps Sonnet-only exhaustion out of account-wide availability", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);

    await manager.applyUsageCache(activeUuid, {
      five_hour: { utilization: 20, resets_at: null },
      seven_day: { utilization: 30, resets_at: null },
      seven_day_sonnet: {
        utilization: 100,
        resets_at: new Date(now + 3_600_000).toISOString(),
      },
    });
    await manager.refresh();

    const account = manager.getActiveAccount();
    expect(account?.rateLimitResetAt).toBeUndefined();
    expect(account && manager.isRateLimited(account)).toBe(false);
    expect((await manager.selectAccount())?.uuid).toBe(activeUuid);
    nowSpy.mockRestore();
  });

  test("treats fractional OAuth usage values as percentages", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      getConfig: () => ({
        soft_quota_threshold_percent: 1,
        cross_process_claims: false,
        account_selection_strategy: "sticky",
        max_consecutive_auth_failures: 3,
        rate_limit_min_backoff_ms: 60_000,
      }),
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const manager = await AccountManager.create(new AccountStore(), createAuth("over-threshold"));
    await manager.addAccount(createAuth("fractional-percent"));
    const [overThreshold, fractionalPercent] = manager.getAccounts();
    if (!overThreshold?.uuid || !fractionalPercent?.uuid) {
      throw new Error("Expected two accounts");
    }

    await manager.applyUsageCache(overThreshold.uuid, {
      five_hour: { utilization: 2, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    });
    await manager.applyUsageCache(fractionalPercent.uuid, {
      five_hour: { utilization: 0.96, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    });

    expect((await manager.selectAccount())?.uuid).toBe(fractionalPercent.uuid);
  });

  test("computes the earliest recovery across per-account blocking boundaries", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("first"));
    await manager.addAccount(createAuth("second"));
    const [first, second] = manager.getAccounts();
    if (!first?.uuid || !second?.uuid) throw new Error("Expected two accounts");

    await manager.applyUsageCache(first.uuid, {
      five_hour: { utilization: 100, resets_at: new Date(now + 60 * 60 * 1000).toISOString() },
      seven_day: null,
      seven_day_sonnet: null,
    });
    await manager.markRateLimited(first.uuid, 60_000);
    await manager.markRateLimited(second.uuid, 5 * 60_000);
    await manager.refresh();

    expect(manager.getMinWaitTime()).toBe(5 * 60_000);
    nowSpy.mockRestore();
  });
});
