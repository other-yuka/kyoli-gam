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
import { setupTestEnv, createMockClient, createTestStorage } from "../tests/helpers";

const originalFetch = globalThis.fetch;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

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
    process.env.XDG_CONFIG_HOME = env.dir;
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
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  describe("constructor / create", () => {
    test("creates manager with stored accounts and keeps stored active account", async () => {
      const stored = createTestStorage(3);
      stored.activeAccountUuid = stored.accounts[1]?.uuid;

      const manager = await createManagerFromStorage(stored);

      expect(manager.getAccounts().length).toBe(3);
      expect(manager.getActiveAccount()?.uuid).toBe(stored.accounts[1]?.uuid);
    });

    test("creates one account from currentAuth when storage is empty", async () => {
      const auth = createAuth("single");
      const manager = await createEmptyManager(auth);

      const accounts = manager.getAccounts();
      expect(accounts.length).toBe(1);
      expect(accounts[0]?.refreshToken).toBe(auth.refresh);
      expect(manager.getActiveAccount()?.uuid).toBe(accounts[0]?.uuid);
    });

    test("reads persisted storage from disk via AccountStore", async () => {
      const stored = createTestStorage(2);
      stored.activeAccountUuid = stored.accounts[1]?.uuid;

      const manager = await createManagerFromStorage(stored, createMockClient());

      expect(manager.getAccounts().length).toBe(2);
      expect(manager.getActiveAccount()?.uuid).toBe(stored.accounts[1]?.uuid);
    });
  });

  describe("account selection — sticky", () => {
    test("returns current active account when usable", async () => {
      await configureSelection("sticky", false);
      const stored = createTestStorage(2);
      const manager = await createManagerFromStorage(stored);

      const selected = await manager.selectAccount();

      expect(selected?.uuid).toBe(stored.activeAccountUuid);
    });

    test("switches to next usable account when current is rate-limited", async () => {
      await configureSelection("sticky", false);
      const stored = createTestStorage(2);
      const manager = await createManagerFromStorage(stored);

      const current = manager.getActiveAccount();
      if (!current?.uuid) {
        throw new Error("Expected current account");
      }
      await manager.markRateLimited(current.uuid, 60_000);

      const selected = await manager.selectAccount();

      expect(selected?.uuid).toBe(stored.accounts[1]?.uuid);
    });

    test("prefers unclaimed accounts over claimed ones", async () => {
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
  });

  describe("account selection — round-robin", () => {
    test("rotates, skips rate-limited accounts, and wraps around", async () => {
      await configureSelection("round-robin", false);
      const stored = createTestStorage(3);
      const manager = await createManagerFromStorage(stored);

      const first = await manager.selectAccount();
      const second = await manager.selectAccount();

      const accountToRateLimit = manager.getAccounts()[2];
      if (!accountToRateLimit?.uuid) {
        throw new Error("Expected account to rate limit");
      }
      await manager.markRateLimited(accountToRateLimit.uuid, 60_000);

      const third = await manager.selectAccount();

      expect(first?.uuid).toBe(stored.accounts[0]?.uuid);
      expect(second?.uuid).toBe(stored.accounts[1]?.uuid);
      expect(third?.uuid).toBe(stored.accounts[0]?.uuid);
    });
  });

  describe("account selection — hybrid", () => {
    test("prefers account with lower usage", async () => {
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

    test("gives stickiness bonus to current account", async () => {
      await configureSelection("hybrid", false);
      const stored = createTestStorage(2);
      const manager = await createManagerFromStorage(stored);
      const accounts = manager.getAccounts();

      const current = accounts[0];
      const challenger = accounts[1];
      if (!current?.uuid || !challenger?.uuid) {
        throw new Error("Expected two accounts");
      }

      await manager.applyUsageCache(current.uuid, createUsage(60));
      await manager.applyUsageCache(challenger.uuid, createUsage(40));

      const selected = await manager.selectAccount();

      expect(selected?.uuid).toBe(current.uuid);
    });

    test("penalizes claimed accounts by score", async () => {
      await configureSelection("hybrid", true);
      const stored = createTestStorage(2);
      stored.activeAccountUuid = undefined;
      const manager = await createManagerFromStorage(stored);
      const accounts = manager.getAccounts();

      const first = accounts[0];
      const second = accounts[1];
      if (!first?.uuid || !second?.uuid) {
        throw new Error("Expected two accounts with uuid");
      }

      await manager.applyUsageCache(first.uuid, createUsage(40));
      await manager.applyUsageCache(second.uuid, createUsage(20));

      const otherPid = process.ppid > 0 ? process.ppid : 1;
      await writeClaims({
        [second.uuid]: { pid: otherPid, at: Date.now() },
      });

      const selected = await manager.selectAccount();

      expect(selected?.uuid).toBe(first.uuid);
    });
  });

  describe("circuit breaker", () => {
    test("does not disable the last usable account at max failures", async () => {
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

    test("disables non-last account after max consecutive failures", async () => {
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

    test("permanent auth failure disables account regardless of usability", async () => {
      const manager = await createManagerFromStorage(createTestStorage(1));
      const account = manager.getAccounts()[0];
      if (!account?.uuid) {
        throw new Error("Expected account");
      }

      await manager.markAuthFailure(account.uuid, { ok: false, permanent: true });

      const saved = await readStorage();
      const savedAccount = saved.accounts.find((entry) => entry.uuid === account.uuid);
      expect(savedAccount?.isAuthDisabled).toBe(true);
      expect(savedAccount?.authDisabledReason).toBe("Token permanently rejected (400/401/403)");
    });
  });

  describe("rate limit management", () => {
    test("marks, clears, computes min wait, and reports rate-limit state", async () => {
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

      let refreshed = manager.getAccounts();
      expect(refreshed[0]?.rateLimitResetAt).toBe(15_000);
      expect(refreshed[1]?.rateLimitResetAt).toBe(12_000);
      expect(manager.isRateLimited(refreshed[0]!)).toBe(true);
      expect(manager.isRateLimited(refreshed[1]!)).toBe(true);
      expect(manager.getMinWaitTime()).toBe(2_000);

      now = 12_100;
      manager.clearExpiredRateLimits();
      refreshed = manager.getAccounts();
      expect(refreshed[1]?.rateLimitResetAt).toBe(undefined);
      expect(manager.isRateLimited(refreshed[1]!)).toBe(false);
      expect(manager.isRateLimited(refreshed[0]!)).toBe(true);
      expect(manager.getMinWaitTime()).toBe(0);

      now = 16_000;
      manager.clearExpiredRateLimits();
      refreshed = manager.getAccounts();
      expect(refreshed[0]?.rateLimitResetAt).toBe(undefined);
      expect(manager.isRateLimited(refreshed[0]!)).toBe(false);
      expect(manager.getMinWaitTime()).toBe(0);

      nowSpy.mockRestore();
    });

    test("markRateLimited persists to disk immediately", async () => {
      const manager = await createManagerFromStorage(createTestStorage(1));
      const account = manager.getAccounts()[0];
      if (!account?.uuid) {
        throw new Error("Expected account");
      }

      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => 1_000);
      await manager.markRateLimited(account.uuid, 500);
      nowSpy.mockRestore();

      const saved = await readStorage();
      expect(saved.accounts[0]?.rateLimitResetAt).toBe(1_500);
    });
  });

  describe("account CRUD", () => {
    test("addAccount adds new account and rejects duplicate refresh token", async () => {
      const manager = await createManagerFromStorage(createTestStorage(1));

      const newAuth = createAuth("new");
      await manager.addAccount(newAuth);
      expect(manager.getAccounts().length).toBe(2);
      expect(manager.getActiveAccount()?.refreshToken).toBe(newAuth.refresh);

      await manager.addAccount({
        type: "oauth",
        refresh: newAuth.refresh,
        access: "another-access",
        expires: Date.now() + 10_000,
      });
      expect(manager.getAccounts().length).toBe(2);
    });

    test("removeAccount removes by index and persists to disk", async () => {
      const manager = await createManagerFromStorage(createTestStorage(3));

      const removed = await manager.removeAccount(1);
      const accounts = manager.getAccounts();

      expect(removed).toBe(true);
      expect(accounts.length).toBe(2);
      expect(accounts.map((account) => account.index)).toEqual([0, 1]);
      expect(accounts[0]?.uuid).toBe("test-uuid-0");
      expect(accounts[1]?.uuid).toBe("test-uuid-2");

      const saved = await readStorage();
      expect(saved.accounts.map((account) => account.uuid)).toEqual(["test-uuid-0", "test-uuid-2"]);
    });

    test("toggleEnabled flips state and clears auth failures when re-enabled", async () => {
      const manager = await createManagerFromStorage(createTestStorage(1));
      const account = manager.getAccounts()[0];
      if (!account?.uuid) {
        throw new Error("Expected account");
      }

      await manager.toggleEnabled(account.uuid);
      let saved = await readStorage();
      expect(saved.accounts[0]?.enabled).toBe(false);

      saved.accounts[0]!.consecutiveAuthFailures = 3;
      saved.accounts[0]!.isAuthDisabled = true;
      saved.accounts[0]!.authDisabledReason = "disabled";
      await writeStorage(saved);
      await manager.refresh();

      await manager.toggleEnabled(account.uuid);
      saved = await readStorage();
      expect(saved.accounts[0]?.enabled).toBe(true);
      expect(saved.accounts[0]?.consecutiveAuthFailures).toBe(0);
      expect(saved.accounts[0]?.isAuthDisabled).toBe(false);
      expect(saved.accounts[0]?.authDisabledReason).toBe(undefined);

      await manager.clearAllAccounts();
      expect(manager.getAccounts().length).toBe(0);
      expect(manager.getActiveAccount()).toBe(null);
      const cleared = await readStorage();
      expect(cleared.accounts.length).toBe(0);
    });
  });

  describe("markSuccess", () => {
    test("resets rate-limit/auth-failure fields and updates lastUsed", async () => {
      const manager = await createManagerFromStorage(createTestStorage(1));
      const account = manager.getAccounts()[0];
      if (!account?.uuid) {
        throw new Error("Expected account");
      }

      await manager.markRateLimited(account.uuid, 30_000);
      await manager.markAuthFailure(account.uuid, { ok: false, permanent: false });

      const client = createMockClient();
      manager.setClient(client);
      const setSpy = vi.spyOn(client.auth, "set");
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => 123_456);

      await manager.markSuccess(account.uuid);
      await manager.refresh();

      const updated = manager.getAccounts()[0]!;
      expect(updated.rateLimitResetAt).toBe(undefined);
      expect(updated.last429At).toBe(undefined);
      expect(updated.consecutiveAuthFailures).toBe(0);
      expect(updated.lastUsed).toBe(123_456);
      expect(setSpy.mock.calls.length).toBe(0);

      nowSpy.mockRestore();
    });
  });

  describe("persistence via AccountStore mutations", () => {
    test("replaceAccountCredentials persists immediately without saveToDisk", async () => {
      const manager = await createManagerFromStorage(createTestStorage(2));
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

    test("ensureValidToken refreshes credentials and persists patch to disk", async () => {
      const manager = await createManagerFromStorage(createTestStorage(1));
      const account = manager.getAccounts()[0];
      if (!account?.uuid) {
        throw new Error("Expected account");
      }

      const result = await manager.ensureValidToken(account.uuid, createMockClient());
      expect(result.ok).toBe(true);

      const saved = await readStorage();
      const savedAccount = saved.accounts.find((entry) => entry.uuid === account.uuid);
      expect(savedAccount?.accessToken).toBe("test");
      expect(typeof savedAccount?.expiresAt).toBe("number");
    });
  });

  describe("syncToOpenCode — lifecycle events only", () => {
    test("markSuccess does not call syncToOpenCode", async () => {
      const manager = await createManagerFromStorage(createTestStorage(1));
      const client = createMockClient();
      manager.setClient(client);
      const setSpy = vi.spyOn(client.auth, "set");

      const account = manager.getAccounts()[0]!;
      await manager.markSuccess(account.uuid!);

      expect(setSpy.mock.calls.length).toBe(0);
    });

    test("replaceAccountCredentials calls syncToOpenCode for active account", async () => {
      const manager = await createManagerFromStorage(createTestStorage(1));
      const client = createMockClient();
      manager.setClient(client);
      const setSpy = vi.spyOn(client.auth, "set");

      const account = manager.getAccounts()[0]!;
      await manager.replaceAccountCredentials(account.uuid!, {
        type: "oauth",
        refresh: "re-auth-refresh",
        access: "re-auth-access",
        expires: Date.now() + 10_000,
      });

      expect(setSpy.mock.calls.length).toBe(1);
    });

    test("ensureValidToken calls syncToOpenCode only for active account", async () => {
      const manager = await createManagerFromStorage(createTestStorage(2));
      const client = createMockClient();
      manager.setClient(client);
      const setSpy = vi.spyOn(client.auth, "set");

      const activeAccount = manager.getActiveAccount();
      if (!activeAccount?.uuid) {
        throw new Error("Expected active account");
      }
      const otherAccount = manager.getAccounts().find((account) => account.uuid !== activeAccount.uuid);
      if (!otherAccount?.uuid) {
        throw new Error("Expected non-active account");
      }

      const otherResult = await manager.ensureValidToken(otherAccount.uuid, client);
      expect(otherResult.ok).toBe(true);
      expect(setSpy.mock.calls.length).toBe(0);

      const activeResult = await manager.ensureValidToken(activeAccount.uuid, client);
      expect(activeResult.ok).toBe(true);
      expect(setSpy.mock.calls.length).toBe(1);
    });
  });
});
