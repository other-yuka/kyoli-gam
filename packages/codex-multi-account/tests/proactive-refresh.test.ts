import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test";
import { ACCOUNTS_FILENAME } from "../src/constants";
import type { AccountStorage, PluginClient, PluginConfig, StoredAccount, TokenRefreshResult } from "../src/types";
import { createMockClient, setupTestEnv } from "./helpers";

const originalTokenModule = await import("../src/token");
const originalConfigModule = await import("../src/config");

const refreshTokenMock = vi.fn();
const isTokenExpiredMock = vi.fn();
const getConfigMock = vi.fn();

mock.module("../src/token", () => ({
  refreshToken: refreshTokenMock,
  isTokenExpired: isTokenExpiredMock,
}));

mock.module("../src/config", () => ({
  getConfig: getConfigMock,
}));

afterAll(() => {
  mock.module("../src/token", () => originalTokenModule);
  mock.module("../src/config", () => originalConfigModule);
});

const { AccountStore } = await import("../src/account-store");

type TestEnv = Awaited<ReturnType<typeof setupTestEnv>>;

function createDefaultConfig(): PluginConfig {
  return {
    account_selection_strategy: "sticky",
    cross_process_claims: true,
    soft_quota_threshold_percent: 100,
    rate_limit_min_backoff_ms: 30_000,
    default_retry_after_ms: 60_000,
    max_consecutive_auth_failures: 3,
    token_failure_backoff_ms: 30_000,
    proactive_refresh: true,
    proactive_refresh_buffer_seconds: 1_800,
    proactive_refresh_interval_seconds: 300,
    quiet_mode: false,
    debug: false,
  };
}

function createAccount(index: number, overrides: Partial<StoredAccount> = {}): StoredAccount {
  const baseTime = 1_700_000_000_000 + index;
  const base: StoredAccount = {
    uuid: `uuid-${index}`,
    accountId: `account-id-${index}`,
    email: `user${index}@example.com`,
    planTier: "",
    refreshToken: `refresh-${index}`,
    accessToken: `access-${index}`,
    expiresAt: Date.now() + 60_000,
    addedAt: baseTime,
    lastUsed: baseTime,
    enabled: true,
    consecutiveAuthFailures: 0,
    isAuthDisabled: false,
  };

  return { ...base, ...overrides };
}

function createStorage(accounts: StoredAccount[]): AccountStorage {
  return { version: 1, accounts };
}

let testEnv: TestEnv | null = null;
let storagePath = "";
let client: ReturnType<typeof createMockClient>;
let queue: import("../src/proactive-refresh").ProactiveRefreshQueue | null = null;
let currentConfig: PluginConfig = createDefaultConfig();

let refreshTokenImpl: (
  currentRefreshToken: string,
  accountId: string,
  pluginClient: PluginClient,
) => Promise<TokenRefreshResult>;

function requireStoragePath(): string {
  if (!storagePath) {
    throw new Error("Storage path is not initialized");
  }
  return storagePath;
}

async function seedStorage(accounts: StoredAccount[]): Promise<void> {
  await fs.writeFile(requireStoragePath(), `${JSON.stringify(createStorage(accounts), null, 2)}\n`, "utf-8");
}

async function readStorage(): Promise<AccountStorage> {
  const raw = await fs.readFile(requireStoragePath(), "utf-8");
  return JSON.parse(raw) as AccountStorage;
}

describe("proactive-refresh", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    refreshTokenMock.mockReset();
    isTokenExpiredMock.mockReset();
    getConfigMock.mockReset();

    testEnv = await setupTestEnv();
    storagePath = join(testEnv.dir, ACCOUNTS_FILENAME);
    client = createMockClient();
    currentConfig = createDefaultConfig();

    getConfigMock.mockImplementation(() => currentConfig);
    isTokenExpiredMock.mockImplementation(() => false);

    refreshTokenImpl = async (_currentRefreshToken, accountId) => ({
      ok: true,
      patch: {
        accessToken: `new-access-${accountId}`,
        expiresAt: Date.now() + 3_600_000,
        refreshToken: `new-refresh-${accountId}`,
        accountId: `new-account-id-${accountId}`,
      },
    });

    refreshTokenMock.mockImplementation((currentRefreshToken: string, accountId: string, pluginClient: PluginClient) => {
      return refreshTokenImpl(currentRefreshToken, accountId, pluginClient);
    });

    const mod = await import("../src/proactive-refresh");
    queue = new mod.ProactiveRefreshQueue(client, new AccountStore());
  });

  afterEach(async () => {
    if (queue) {
      await queue.stop();
      queue = null;
    }

    if (testEnv) {
      await testEnv.cleanup();
      testEnv = null;
    }

    storagePath = "";
    vi.useRealTimers();
  });

  async function runCheckNow(): Promise<void> {
    if (!queue) {
      throw new Error("Queue not initialized");
    }
    const q = queue as unknown as {
      runToken: number;
      runCheck: (token: number) => Promise<void>;
    };
    q.runToken += 1;
    const token = q.runToken;
    await q.runCheck(token);
  }

  test("start() does nothing when proactive_refresh is false", async () => {
    currentConfig = {
      ...currentConfig,
      proactive_refresh: false,
    };

    queue?.start();
    vi.advanceTimersByTime(5_000);

    expect(refreshTokenMock).not.toHaveBeenCalled();
  });

  test("refreshes expiring account and persists patch including accountId", async () => {
    await seedStorage([
      createAccount(1, { uuid: "target-uuid", refreshToken: "target-refresh", expiresAt: Date.now() + 30_000 }),
    ]);

    await runCheckNow();

    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshTokenMock).toHaveBeenCalledWith("target-refresh", "target-uuid", client);

    const persisted = await readStorage();
    const updated = persisted.accounts.find((entry) => entry.uuid === "target-uuid");
    expect(updated?.accessToken).toBe("new-access-target-uuid");
    expect(updated?.refreshToken).toBe("new-refresh-target-uuid");
    expect(updated?.accountId).toBe("new-account-id-target-uuid");
    expect(updated?.isAuthDisabled).toBe(false);
  });

  test("skips disabled and auth-disabled accounts", async () => {
    await seedStorage([
      createAccount(2, { uuid: "disabled", enabled: false, expiresAt: Date.now() + 30_000 }),
      createAccount(3, { uuid: "auth-disabled", isAuthDisabled: true, expiresAt: Date.now() + 30_000 }),
      createAccount(4, { uuid: "usable", expiresAt: Date.now() + 30_000 }),
    ]);

    await runCheckNow();

    expect(refreshTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshTokenMock).toHaveBeenCalledWith("refresh-4", "usable", client);
  });

  test("transient refresh failure increments consecutiveAuthFailures", async () => {
    await seedStorage([
      createAccount(5, {
        uuid: "transient",
        consecutiveAuthFailures: 1,
        expiresAt: Date.now() + 30_000,
      }),
    ]);

    refreshTokenImpl = async () => ({ ok: false, permanent: false });

    await runCheckNow();

    const persisted = await readStorage();
    const updated = persisted.accounts.find((entry) => entry.uuid === "transient");
    expect(updated?.consecutiveAuthFailures).toBe(2);
    expect(updated?.isAuthDisabled).toBe(false);
  });

  test("permanent refresh failure disables account", async () => {
    await seedStorage([
      createAccount(6, { uuid: "permanent", expiresAt: Date.now() + 30_000 }),
    ]);

    refreshTokenImpl = async () => ({ ok: false, permanent: true });

    await runCheckNow();

    const persisted = await readStorage();
    const updated = persisted.accounts.find((entry) => entry.uuid === "permanent");
    expect(updated?.isAuthDisabled).toBe(true);
    expect(updated?.authDisabledReason).toBe("Token permanently rejected (proactive refresh)");
  });

  test("stop() cancels pending initial timer", async () => {
    queue?.start();
    await queue?.stop();
    vi.advanceTimersByTime(5_000);

    expect(refreshTokenMock).not.toHaveBeenCalled();
  });
});
