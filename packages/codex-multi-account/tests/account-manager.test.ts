import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { AccountManager } from "../src/account-manager";
import { AccountStore } from "../src/account-store";
import { ACCOUNTS_FILENAME } from "../src/constants";
import { loadConfig, resetConfigCache, updateConfigField } from "../src/config";
import type {
  AccountSelectionStrategy,
  AccountStorage,
  OAuthCredentials,
  PluginClient,
  UsageLimits,
} from "../src/types";
import { setupTestEnv, createMockClient, createTestStorage, buildFakeJwt } from "./helpers";

const originalFetch = globalThis.fetch;

let cleanup: (() => Promise<void>) | undefined;

function requireConfigDir(): string {
  const dir = process.env.OPENCODE_CONFIG_DIR;
  if (!dir) {
    throw new Error("OPENCODE_CONFIG_DIR is not set");
  }
  return dir;
}

function getStoragePath(): string {
  return join(requireConfigDir(), ACCOUNTS_FILENAME);
}

function getClaimsPath(): string {
  return join(requireConfigDir(), "multiauth-claims.json");
}

function createAuth(id: string): OAuthCredentials {
  return {
    type: "oauth",
    refresh: `refresh-${id}`,
    access: `access-${id}`,
    expires: Date.now() + 3_600_000,
  };
}

function createUsage(utilization: number): UsageLimits {
  return {
    five_hour: { utilization, resets_at: "2026-01-01T00:00:00Z" },
    seven_day: null,
    seven_day_sonnet: null,
  };
}

async function configureSelection(
  strategy: AccountSelectionStrategy,
  crossProcessClaims: boolean,
): Promise<void> {
  await updateConfigField("account_selection_strategy", strategy);
  await updateConfigField("cross_process_claims", crossProcessClaims);
}

async function writeClaims(claims: Record<string, { pid: number; at: number }>): Promise<void> {
  await fs.writeFile(getClaimsPath(), JSON.stringify(claims, null, 2), "utf-8");
}

async function writeStorage(storage: AccountStorage): Promise<void> {
  await fs.writeFile(getStoragePath(), `${JSON.stringify(storage, null, 2)}\n`, "utf-8");
}

async function readStorage(): Promise<AccountStorage> {
  const raw = await fs.readFile(getStoragePath(), "utf-8");
  return JSON.parse(raw) as AccountStorage;
}

async function drainBackgroundWrites(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

async function createManagerFromStorage(
  storage: AccountStorage,
  client?: PluginClient,
): Promise<AccountManager> {
  await writeStorage(storage);
  const store = new AccountStore();
  return AccountManager.create(store, createAuth("fallback"), client);
}

async function createEmptyManager(auth: OAuthCredentials, client?: PluginClient): Promise<AccountManager> {
  const store = new AccountStore();
  return AccountManager.create(store, auth, client);
}

describe("account-manager", () => {
  beforeEach(async () => {
    const env = await setupTestEnv();
    cleanup = env.cleanup;
    resetConfigCache();
    await loadConfig();
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ access_token: "test", expires_in: 3600 }),
      { status: 200 },
    )));
  });

  afterEach(async () => {
    await drainBackgroundWrites();
    globalThis.fetch = originalFetch;
    resetConfigCache();
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  test("create() loads persisted accounts and preserves accountId", async () => {
    const stored = createTestStorage(2);
    stored.accounts[0]!.accountId = "account-id-111";
    stored.activeAccountUuid = stored.accounts[1]?.uuid;

    const manager = await createManagerFromStorage(stored);

    const accounts = manager.getAccounts();
    expect(accounts.length).toBe(2);
    expect(accounts[0]?.accountId).toBe("account-id-111");
    expect(manager.getActiveAccount()?.uuid).toBe(stored.accounts[1]?.uuid);
  });

  test("create() seeds one account from current auth when storage is empty", async () => {
    const auth = createAuth("single");
    const manager = await createEmptyManager(auth);

    const accounts = manager.getAccounts();
    expect(accounts.length).toBe(1);
    expect(accounts[0]?.refreshToken).toBe(auth.refresh);
    expect(manager.getActiveAccount()?.uuid).toBe(accounts[0]?.uuid);
  });

  test("sticky selection returns active account when usable", async () => {
    await configureSelection("sticky", false);
    const stored = createTestStorage(2);
    const manager = await createManagerFromStorage(stored);

    const selected = await manager.selectAccount();
    expect(selected?.uuid).toBe(stored.activeAccountUuid);
  });

  test("sticky selection prefers unclaimed account", async () => {
    await configureSelection("sticky", true);
    const stored = createTestStorage(3);
    const manager = await createManagerFromStorage(stored);

    const current = manager.getActiveAccount();
    if (!current?.uuid) {
      throw new Error("Expected current account");
    }
    await manager.markRateLimited(current.uuid, 60_000);

    const claimedUuid = stored.accounts[1]?.uuid;
    if (!claimedUuid) {
      throw new Error("Expected claimed account uuid");
    }
    const otherPid = process.ppid > 0 ? process.ppid : 1;
    await writeClaims({
      [claimedUuid]: { pid: otherPid, at: Date.now() },
    });

    const selected = await manager.selectAccount();
    expect(selected?.uuid).toBe(stored.accounts[2]?.uuid);
  });

  test("round-robin rotates and skips rate-limited accounts", async () => {
    await configureSelection("round-robin", false);
    const stored = createTestStorage(3);
    const manager = await createManagerFromStorage(stored);

    const first = await manager.selectAccount();
    const second = await manager.selectAccount();

    const toLimit = manager.getAccounts()[2];
    if (!toLimit?.uuid) {
      throw new Error("Expected account to rate limit");
    }
    await manager.markRateLimited(toLimit.uuid, 60_000);

    const third = await manager.selectAccount();

    expect(first?.uuid).toBe(stored.accounts[0]?.uuid);
    expect(second?.uuid).toBe(stored.accounts[1]?.uuid);
    expect(third?.uuid).toBe(stored.accounts[0]?.uuid);
  });

  test("hybrid selection prefers lower usage", async () => {
    await configureSelection("hybrid", false);
    const stored = createTestStorage(2);
    const manager = await createManagerFromStorage(stored);
    const accounts = manager.getAccounts();
    const first = accounts[0];
    const second = accounts[1];
    if (!first?.uuid || !second?.uuid) {
      throw new Error("Expected two accounts");
    }

    await manager.applyUsageCache(first.uuid, createUsage(95));
    await manager.applyUsageCache(second.uuid, createUsage(10));

    const selected = await manager.selectAccount();
    expect(selected?.uuid).toBe(second.uuid);
  });

  test("markAuthFailure does not disable the last usable account", async () => {
    await updateConfigField("max_consecutive_auth_failures", 2);
    const manager = await createManagerFromStorage(createTestStorage(1));
    const account = manager.getAccounts()[0];
    if (!account?.uuid) {
      throw new Error("Expected account");
    }

    await manager.markAuthFailure(account.uuid, { ok: false, permanent: false });
    await manager.markAuthFailure(account.uuid, { ok: false, permanent: false });

    const saved = await readStorage();
    const savedAccount = saved.accounts.find((entry) => entry.uuid === account.uuid);
    expect(savedAccount?.consecutiveAuthFailures).toBe(2);
    expect(savedAccount?.isAuthDisabled).toBe(false);
  });

  test("markAuthFailure disables non-last account at threshold", async () => {
    await updateConfigField("max_consecutive_auth_failures", 2);
    const manager = await createManagerFromStorage(createTestStorage(2));
    const account = manager.getAccounts()[0];
    if (!account?.uuid) {
      throw new Error("Expected account");
    }

    await manager.markAuthFailure(account.uuid, { ok: false, permanent: false });
    await manager.markAuthFailure(account.uuid, { ok: false, permanent: false });

    const saved = await readStorage();
    const savedAccount = saved.accounts.find((entry) => entry.uuid === account.uuid);
    expect(savedAccount?.isAuthDisabled).toBe(true);
    expect(savedAccount?.authDisabledReason).toBe("2 consecutive auth failures");
  });

  test("markRateLimited persists and getMinWaitTime follows earliest reset", async () => {
    const manager = await createManagerFromStorage(createTestStorage(2));
    const accounts = manager.getAccounts();
    const first = accounts[0];
    const second = accounts[1];
    if (!first?.uuid || !second?.uuid) {
      throw new Error("Expected two accounts");
    }

    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    await manager.markRateLimited(first.uuid, 5_000);
    await manager.markRateLimited(second.uuid, 2_000);
    await manager.refresh();

    expect(manager.getMinWaitTime()).toBe(2_000);
    now = 12_100;
    manager.clearExpiredRateLimits();
    expect(manager.getMinWaitTime()).toBe(0);

    nowSpy.mockRestore();
  });

  test("addAccount ignores duplicate refresh token", async () => {
    const manager = await createManagerFromStorage(createTestStorage(1));
    const newAuth = createAuth("new");
    await manager.addAccount(newAuth);
    expect(manager.getAccounts().length).toBe(2);

    await manager.addAccount({
      type: "oauth",
      refresh: newAuth.refresh,
      access: "another-access",
      expires: Date.now() + 10_000,
    });

    expect(manager.getAccounts().length).toBe(2);
  });

  test("replaceAccountCredentials persists new access/refresh values", async () => {
    const manager = await createManagerFromStorage(createTestStorage(1));
    const account = manager.getAccounts()[0];
    if (!account?.uuid) {
      throw new Error("Expected account");
    }

    await manager.replaceAccountCredentials(account.uuid, {
      type: "oauth",
      refresh: "brand-new-refresh-token",
      access: "brand-new-access",
      expires: Date.now() + 10_000,
    });

    const saved = await readStorage();
    const savedAccount = saved.accounts.find((entry) => entry.uuid === account.uuid);
    expect(savedAccount?.refreshToken).toBe("brand-new-refresh-token");
    expect(savedAccount?.accessToken).toBe("brand-new-access");
  });

  test("ensureValidToken stores refreshed accountId from token response", async () => {
    const manager = await createManagerFromStorage(createTestStorage(1), createMockClient());
    const account = manager.getAccounts()[0];
    if (!account?.uuid) {
      throw new Error("Expected account");
    }

    const idToken = buildFakeJwt({
      chatgpt_account_id: "account-from-id-token",
    });

    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      id_token: idToken,
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 3600,
    }), { status: 200 })));

    const result = await manager.ensureValidToken(account.uuid, createMockClient());
    expect(result.ok).toBe(true);

    const saved = await readStorage();
    const savedAccount = saved.accounts.find((entry) => entry.uuid === account.uuid);
    expect(savedAccount?.accessToken).toBe("fresh-access");
    expect(savedAccount?.refreshToken).toBe("fresh-refresh");
    expect(savedAccount?.accountId).toBe("account-from-id-token");
  });
});
