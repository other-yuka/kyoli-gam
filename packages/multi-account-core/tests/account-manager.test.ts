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
    const active = manager.getActiveAccount();
    if (!active?.uuid) {
      throw new Error("Expected active account uuid");
    }

    const client = createMockClient() as PluginClient;
    const authSetSpy = vi.spyOn(client.auth, "set");
    manager.setClient(client);

    const result = await manager.ensureValidToken(active.uuid, client);
    expect(result.ok).toBe(true);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(authSetSpy).toHaveBeenCalledTimes(1);
  });
});
