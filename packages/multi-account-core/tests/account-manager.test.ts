import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
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
});
