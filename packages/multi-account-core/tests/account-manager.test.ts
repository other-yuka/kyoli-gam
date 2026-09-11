import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  captureRateLimitRevision,
  createAccountManagerForProvider,
} from "../src/account-manager";
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

  test("keeps healthy usage cached after a successful request", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const usage = {
      five_hour: { utilization: 25, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    };

    await manager.applyUsageCache(activeUuid, usage, {
      observedAt: now,
      expectedRateLimitObservedAt: null,
    });
    await manager.markSuccessAtRevision(activeUuid, captureRateLimitRevision(manager.getActiveAccount()!));
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      cachedUsage: usage,
      cachedUsageAt: now,
    });
    expect(manager.getActiveAccount()?.rateLimitObservedAt).toBeUndefined();
    nowSpy.mockRestore();
  });

  test("preserves guardless legacy rate-limit writes", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    await manager.markRateLimited(activeUuid, 60_000);

    await manager.applyUsageCache(activeUuid, {
      five_hour: { utilization: 20, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    });
    await manager.markSuccess(activeUuid);
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      cachedUsage: {
        five_hour: { utilization: 20, resets_at: null },
      },
      rateLimitObservedAt: now,
    });
    expect(manager.getActiveAccount()?.rateLimitCooldownUntil).toBeUndefined();
    expect(manager.getActiveAccount()?.rateLimitResetAt).toBeUndefined();
    nowSpy.mockRestore();
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

    const reboundRevision = await manager.markRateLimitedAtRevision!(reboundUuid, 60_000);
    const otherSession = await manager.selectAccount("session-b");
    const otherSessionUuid = getUuid(otherSession?.uuid);

    await manager.markSuccessAtRevision(reboundUuid, reboundRevision ?? null);
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

      await manager.applyUsageCacheAtRevision(overPace.uuid, {
        five_hour: null,
        seven_day: { utilization: 80, resets_at: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString() },
        seven_day_sonnet: null,
      }, { expectedRateLimitRevision: captureRateLimitRevision(overPace) });
      await manager.applyUsageCacheAtRevision(underPace.uuid, {
        five_hour: null,
        seven_day: { utilization: 60, resets_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() },
        seven_day_sonnet: null,
      }, { expectedRateLimitRevision: captureRateLimitRevision(underPace) });

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
    const firstObservedAt = Date.now();

    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 100, resets_at: new Date(Date.now() + 60_000).toISOString() },
      seven_day: null,
      seven_day_sonnet: null,
    }, {
      observedAt: firstObservedAt,
      expectedRateLimitRevision: captureRateLimitRevision(manager.getActiveAccount()!),
    });
    await manager.refresh();
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 0, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
      seven_day: { utilization: 40, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
      seven_day_sonnet: null,
    }, {
      observedAt: firstObservedAt + 1,
      expectedRateLimitRevision: captureRateLimitRevision(manager.getActiveAccount()!),
    });
    await manager.refresh();

    expect(manager.getActiveAccount()?.rateLimitResetAt).toBe(undefined);
  });

  test("applyUsageCache cannot clear an active provider cooldown", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    await manager.markRateLimited(activeUuid, 60_000);
    const rateLimitRevision = await manager.markRateLimitedAtRevision!(activeUuid, 60_000);

    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 20, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    }, { expectedRateLimitRevision: rateLimitRevision ?? null });
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      rateLimitCooldownUntil: now + 60_000,
      rateLimitResetAt: now + 60_000,
    });
    nowSpy.mockRestore();
  });

  test("applyUsageCache migrates a legacy provider cooldown before replacing usage", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = new AccountStore();
    const manager = await AccountManager.create(store, createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    await store.mutateAccount(activeUuid, (account) => {
      account.rateLimitResetAt = now + 60_000;
      account.cachedUsage = {
        five_hour: { utilization: 20, resets_at: null },
        seven_day: null,
        seven_day_sonnet: null,
      };
      account.cachedUsageAt = now - 1_000;
    });

    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 30, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    }, { expectedRateLimitRevision: captureRateLimitRevision(manager.getActiveAccount()!) });
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      rateLimitCooldownUntil: now + 60_000,
      rateLimitResetAt: now + 60_000,
    });
    nowSpy.mockRestore();
  });

  test("recognizes any legacy exhausted window reset as quota-owned", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = new AccountStore();
    const manager = await AccountManager.create(store, createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const fiveHourResetAt = now + 5 * 60 * 60 * 1000;
    const sevenDayResetAt = now + 7 * 24 * 60 * 60 * 1000;
    await store.mutateAccount(activeUuid, (account) => {
      account.rateLimitResetAt = fiveHourResetAt;
      account.cachedUsage = {
        five_hour: {
          utilization: 100,
          resets_at: new Date(fiveHourResetAt).toISOString(),
        },
        seven_day: {
          utilization: 100,
          resets_at: new Date(sevenDayResetAt).toISOString(),
        },
        seven_day_sonnet: null,
      };
      account.cachedUsageAt = now;
    });

    now += 60 * 60 * 1000;
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 20, resets_at: null },
      seven_day: { utilization: 30, resets_at: null },
      seven_day_sonnet: null,
    }, { expectedRateLimitRevision: null });
    await manager.refresh();

    expect(manager.getActiveAccount()?.rateLimitCooldownUntil).toBeUndefined();
    expect(manager.getActiveAccount()?.rateLimitResetAt).toBeUndefined();
    nowSpy.mockRestore();
  });

  test("a non-exhausted provider snapshot replaces a stale exhausted usage window", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 100, resets_at: new Date(now + 12 * 60 * 60 * 1000).toISOString() },
      seven_day: null,
      seven_day_sonnet: null,
    }, { expectedRateLimitRevision: captureRateLimitRevision(manager.getActiveAccount()!) });

    await manager.markRateLimited(activeUuid, 60_000, {
      usage: {
        five_hour: { utilization: 92, resets_at: null },
        seven_day: null,
        seven_day_sonnet: null,
      },
    });
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      rateLimitCooldownUntil: now + 60_000,
      rateLimitResetAt: now + 60_000,
      cachedUsage: {
        five_hour: { utilization: 92, resets_at: null },
      },
    });

    now += 60_001;
    manager.clearExpiredRateLimits();
    expect(manager.isRateLimited(manager.getActiveAccount()!)).toBe(false);
    nowSpy.mockRestore();
  });

  test("keeps exhausted usage without a reset blocked until a fresh snapshot arrives", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const rateLimitRevision = await manager.markRateLimitedAtRevision!(activeUuid, 60_000, {
      usage: {
        five_hour: {
          utilization: 100,
          resets_at: new Date(now + 60_000).toISOString(),
        },
        seven_day: { utilization: 100, resets_at: null },
        seven_day_sonnet: null,
      },
    });
    if (rateLimitRevision === undefined) throw new Error("Expected a rate-limit revision");

    now += 60_001;
    await expect(manager.selectAccount()).resolves.toBeNull();
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 20, resets_at: null },
      seven_day: { utilization: 30, resets_at: null },
      seven_day_sonnet: null,
    }, { observedAt: now, expectedRateLimitRevision: rateLimitRevision });

    await expect(manager.selectAccount()).resolves.toMatchObject({ uuid: activeUuid });
    nowSpy.mockRestore();
  });

  test("fresh non-exhausted usage clears a claimed reset after the provider cooldown", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const rateLimitRevision = await manager.markRateLimitedAtRevision!(
      activeUuid,
      60_000,
      { rateLimitResetMs: 60 * 60_000 },
    );

    now += 60_001;
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 25, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    }, { expectedRateLimitRevision: rateLimitRevision ?? null });
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      cachedUsage: {
        five_hour: { utilization: 25, resets_at: null },
      },
    });
    expect(manager.getActiveAccount()?.rateLimitCooldownUntil).toBeUndefined();
    expect(manager.getActiveAccount()?.rateLimitResetAt).toBeUndefined();
    nowSpy.mockRestore();
  });

  test("does not migrate a modern quota reset as a legacy provider cooldown", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = new AccountStore();
    const manager = await AccountManager.create(store, createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const rateLimitRevision = await manager.markRateLimitedAtRevision!(
      activeUuid,
      60_000,
      { rateLimitResetMs: 60 * 60_000 },
    );
    if (rateLimitRevision === undefined) throw new Error("Expected a rate-limit revision");
    await store.mutateAccount(activeUuid, (account) => {
      account.rateLimitCooldownUntil = undefined;
    });

    now += 60_001;
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 25, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    }, { expectedRateLimitRevision: rateLimitRevision });
    await manager.refresh();

    expect(manager.getActiveAccount()?.rateLimitCooldownUntil).toBeUndefined();
    expect(manager.getActiveAccount()?.rateLimitResetAt).toBeUndefined();
    expect(manager.getActiveAccount()?.rateLimitObservedAt).toBeGreaterThan(rateLimitRevision);
    nowSpy.mockRestore();
  });

  test("ignores an older usage fetch that completes after a rate-limit snapshot", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const staleFetchObservedAt = now;
    const staleRateLimitRevision = captureRateLimitRevision(manager.getActiveAccount()!);
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 20, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    }, {
      observedAt: staleFetchObservedAt,
      expectedRateLimitRevision: staleRateLimitRevision,
    });

    now += 100;
    await manager.markRateLimited(activeUuid, 60_000);
    now += 100;
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 100, resets_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString() },
      seven_day: null,
      seven_day_sonnet: null,
    }, {
      observedAt: staleFetchObservedAt,
      expectedRateLimitRevision: staleRateLimitRevision,
    });
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      cachedUsage: {
        five_hour: { utilization: 20, resets_at: null },
      },
      cachedUsageAt: 1_700_000_000_000,
      rateLimitCooldownUntil: 1_700_000_060_100,
      rateLimitResetAt: 1_700_000_060_100,
    });
    nowSpy.mockRestore();
  });

  test("rejects a usage fetch when a newer rate limit is observed in the same millisecond", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const expectedRateLimitRevision = captureRateLimitRevision(manager.getActiveAccount()!);
    const rateLimitUsage = {
      five_hour: {
        utilization: 100,
        resets_at: new Date(now + 60 * 60 * 1000).toISOString(),
      },
      seven_day: null,
      seven_day_sonnet: null,
    };

    const observedToken = await manager.markRateLimitedAtRevision!(activeUuid, 60_000, {
      usage: rateLimitUsage,
    });
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 10, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    }, { observedAt: now, expectedRateLimitRevision });
    await manager.refresh();

    expect(observedToken).toBe(now);
    expect(manager.getActiveAccount()).toMatchObject({
      cachedUsage: rateLimitUsage,
      cachedUsageAt: now,
      rateLimitCooldownUntil: now + 60_000,
      rateLimitResetAt: now + 60 * 60 * 1000,
      rateLimitObservedAt: now,
    });
    nowSpy.mockRestore();
  });

  test("accepts a usage refresh guarded by the current rate-limit token", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);

    const firstToken = await manager.markRateLimitedAtRevision!(activeUuid, 60_000);
    const secondToken = await manager.markRateLimitedAtRevision!(activeUuid, 60_000);
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 25, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    }, {
      observedAt: now,
      expectedRateLimitRevision: secondToken ?? null,
    });
    await manager.refresh();

    expect(firstToken).toBe(now);
    expect(secondToken).toBe(now + 1);
    expect(manager.getActiveAccount()).toMatchObject({
      cachedUsage: {
        five_hour: { utilization: 25, resets_at: null },
      },
      cachedUsageAt: now,
      rateLimitCooldownUntil: now + 60_000,
      rateLimitObservedAt: now + 1,
    });
    nowSpy.mockRestore();
  });

  test("keeps the rate observation token after recovery to reject a pre-rate-limit snapshot", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const staleRateLimitRevision = captureRateLimitRevision(manager.getActiveAccount()!);

    const rateLimitRevision = await manager.markRateLimitedAtRevision!(activeUuid, 60_000);
    await manager.markSuccessAtRevision(activeUuid, rateLimitRevision ?? null);
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: {
        utilization: 100,
        resets_at: new Date(now + 60 * 60 * 1000).toISOString(),
      },
      seven_day: null,
      seven_day_sonnet: null,
    }, { observedAt: now, expectedRateLimitRevision: staleRateLimitRevision });
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      rateLimitObservedAt: now + 1,
    });
    expect(manager.getActiveAccount()?.cachedUsage).toBeUndefined();
    expect(manager.getActiveAccount()?.rateLimitResetAt).toBeUndefined();
    expect(manager.getActiveAccount()?.rateLimitCooldownUntil).toBeUndefined();
    nowSpy.mockRestore();
  });

  test("rejects an exhausted usage snapshot captured before request success", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const rateLimitRevision = await manager.markRateLimitedAtRevision!(activeUuid, 60_000);

    await manager.markSuccessAtRevision(activeUuid, rateLimitRevision ?? null);
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: {
        utilization: 100,
        resets_at: new Date(now + 60 * 60 * 1000).toISOString(),
      },
      seven_day: null,
      seven_day_sonnet: null,
    }, { observedAt: now, expectedRateLimitRevision: rateLimitRevision ?? null });
    await manager.refresh();

    const recovered = manager.getActiveAccount();
    expect(recovered?.cachedUsage).toBeUndefined();
    expect(recovered?.rateLimitResetAt).toBeUndefined();
    expect(recovered?.rateLimitCooldownUntil).toBeUndefined();
    expect(recovered?.rateLimitObservedAt).toBeGreaterThan(rateLimitRevision ?? 0);
    nowSpy.mockRestore();
  });

  test("rejects a second usage result after the first changes the quota boundary", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const rateLimitRevision = await manager.markRateLimitedAtRevision!(activeUuid, 0);
    if (rateLimitRevision === undefined) throw new Error("Expected a rate-limit revision");

    const availableUsage = {
      five_hour: { utilization: 20, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    };
    await manager.applyUsageCacheAtRevision(activeUuid, availableUsage, {
      observedAt: now,
      expectedRateLimitRevision: rateLimitRevision,
    });
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: {
        utilization: 100,
        resets_at: new Date(now + 60 * 60 * 1000).toISOString(),
      },
      seven_day: null,
      seven_day_sonnet: null,
    }, {
      observedAt: now + 1,
      expectedRateLimitRevision: rateLimitRevision,
    });
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      cachedUsage: availableUsage,
      rateLimitObservedAt: now + 1,
    });
    expect(manager.getActiveAccount()?.rateLimitResetAt).toBeUndefined();
    expect(manager.getActiveAccount()?.rateLimitCooldownUntil).toBeUndefined();
    nowSpy.mockRestore();
  });

  test("accepts only the first usage result observed in the same millisecond", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const expectedRateLimitRevision = captureRateLimitRevision(manager.getActiveAccount()!);
    const availableUsage = {
      five_hour: { utilization: 20, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    };

    await manager.applyUsageCacheAtRevision(activeUuid, availableUsage, {
      observedAt: now,
      expectedRateLimitRevision,
    });
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: {
        utilization: 100,
        resets_at: new Date(now + 60 * 60 * 1000).toISOString(),
      },
      seven_day: null,
      seven_day_sonnet: null,
    }, {
      observedAt: now,
      expectedRateLimitRevision,
    });
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      cachedUsage: availableUsage,
      cachedUsageAt: now,
    });
    expect(manager.getActiveAccount()?.rateLimitResetAt).toBeUndefined();
    nowSpy.mockRestore();
  });

  test("rejects usage captured before credentials are replaced", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const rateLimitRevision = await manager.markRateLimitedAtRevision!(activeUuid, 60_000, {
      usage: {
        five_hour: {
          utilization: 100,
          resets_at: new Date(now + 60 * 60 * 1000).toISOString(),
        },
        seven_day: null,
        seven_day_sonnet: null,
      },
    });
    if (rateLimitRevision === undefined) throw new Error("Expected a rate-limit revision");

    await manager.replaceAccountCredentials(activeUuid, {
      type: "oauth",
      refresh: "replacement-refresh",
      access: "replacement-access",
      expires: now + 60_000,
    }, { email: "replacement@example.test" });
    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: {
        utilization: 100,
        resets_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      },
      seven_day: null,
      seven_day_sonnet: null,
    }, {
      observedAt: now + 1,
      expectedRateLimitRevision: rateLimitRevision,
    });
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      refreshToken: "replacement-refresh",
      accessToken: "replacement-access",
      email: "replacement@example.test",
    });
    expect(manager.getActiveAccount()?.cachedUsage).toBeUndefined();
    expect(manager.getActiveAccount()?.rateLimitResetAt).toBeUndefined();
    expect(manager.getActiveAccount()?.rateLimitCooldownUntil).toBeUndefined();
    expect(manager.getActiveAccount()?.rateLimitObservedAt).toBeGreaterThan(rateLimitRevision);
    nowSpy.mockRestore();
  });

  test("an older request success cannot clear a newer rate limit", async () => {
    const AccountManager = createAccountManagerForProvider({
      providerAuthId: "anthropic",
      isTokenExpired: () => false,
      refreshToken: async () => ({ ok: false, permanent: false }),
    });

    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const manager = await AccountManager.create(new AccountStore(), createAuth("seed"));
    const activeUuid = getUuid(manager.getActiveAccount()?.uuid);
    const requestRateLimitRevision = captureRateLimitRevision(manager.getActiveAccount()!);

    now += 100;
    await manager.markRateLimited(activeUuid, 60_000);
    now += 100;
    await manager.markSuccessAtRevision(activeUuid, requestRateLimitRevision);
    await manager.refresh();

    expect(manager.getActiveAccount()).toMatchObject({
      rateLimitCooldownUntil: 1_700_000_060_100,
      rateLimitObservedAt: 1_700_000_000_100,
      rateLimitResetAt: 1_700_000_060_100,
    });
    nowSpy.mockRestore();
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

    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 100, resets_at: new Date(now + 10_000).toISOString() },
      seven_day: { utilization: 100, resets_at: new Date(now + 25_000).toISOString() },
      seven_day_sonnet: null,
    }, { expectedRateLimitRevision: captureRateLimitRevision(manager.getActiveAccount()!) });
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

    await manager.markRateLimited(activeUuid, 60_000, { usage });
    await manager.refresh();

    expect(mutateAccount).toHaveBeenCalledTimes(1);
    expect(manager.getActiveAccount()).toMatchObject({
      cachedUsage: usage,
      cachedUsageAt: expect.any(Number),
      rateLimitCooldownUntil: expect.any(Number),
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

    await manager.applyUsageCacheAtRevision(activeUuid, {
      five_hour: { utilization: 20, resets_at: null },
      seven_day: { utilization: 30, resets_at: null },
      seven_day_sonnet: {
        utilization: 100,
        resets_at: new Date(now + 3_600_000).toISOString(),
      },
    }, { expectedRateLimitRevision: captureRateLimitRevision(manager.getActiveAccount()!) });
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

    await manager.applyUsageCacheAtRevision(overThreshold.uuid, {
      five_hour: { utilization: 2, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    }, { expectedRateLimitRevision: captureRateLimitRevision(overThreshold) });
    await manager.applyUsageCacheAtRevision(fractionalPercent.uuid, {
      five_hour: { utilization: 0.96, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
    }, { expectedRateLimitRevision: captureRateLimitRevision(fractionalPercent) });

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

    await manager.applyUsageCacheAtRevision(first.uuid, {
      five_hour: { utilization: 100, resets_at: new Date(now + 60 * 60 * 1000).toISOString() },
      seven_day: null,
      seven_day_sonnet: null,
    }, { expectedRateLimitRevision: captureRateLimitRevision(first) });
    await manager.markRateLimited(first.uuid, 60_000);
    await manager.markRateLimited(second.uuid, 5 * 60_000);
    await manager.refresh();

    expect(manager.getMinWaitTime()).toBe(5 * 60_000);
    nowSpy.mockRestore();
  });

  test("uses the latest boundary per account before choosing the earliest account", async () => {
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

    await manager.markRateLimited(first.uuid, 5 * 60_000, { rateLimitResetMs: 60_000 });
    await manager.markRateLimited(second.uuid, 2 * 60_000, { rateLimitResetMs: 10 * 60_000 });
    await manager.refresh();

    expect(manager.getMinWaitTime()).toBe(5 * 60_000);
    nowSpy.mockRestore();
  });
});
