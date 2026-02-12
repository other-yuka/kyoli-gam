import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test";
import { ACCOUNTS_FILENAME } from "../src/constants";
import type {
  AccountStorage,
  PluginClient,
  PluginConfig,
  StoredAccount,
  TokenRefreshResult,
} from "../src/types";
import { createMockClient, setupTestEnv } from "../tests/helpers";

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
type QueueType = import("../src/proactive-refresh").ProactiveRefreshQueue;
type TimeoutHandle = ReturnType<typeof setTimeout>;

interface ScheduledTimer {
  handle: TimeoutHandle;
  delayMs: number;
  callback: () => void;
  cleared: boolean;
  fired: boolean;
}

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
    email: `user${index}@example.com`,
    planTier: "",
    refreshToken: `refresh-${index}`,
    accessToken: `access-${index}`,
    expiresAt: Date.now() + 600_000,
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForAsyncWork(): Promise<void> {
  await flushPromises();
  await new Promise<void>((resolve) => {
    originalSetTimeout(() => resolve(), 0);
  });
  await flushPromises();
}

async function waitForRefreshCalls(expectedCount: number, timeoutMs = 2_500): Promise<void> {
  const start = Date.now();
  while (refreshTokenCalls.length < expectedCount && Date.now() - start < timeoutMs) {
    await new Promise<void>((resolve) => {
      originalSetTimeout(() => resolve(), 10);
    });
  }
}

let testEnv: TestEnv | null = null;
let storagePath = "";
let client: ReturnType<typeof createMockClient>;
let activeQueue: QueueType | null = null;

let currentConfig: PluginConfig = createDefaultConfig();
let refreshTokenImpl: (
  currentRefreshToken: string,
  accountId: string,
  pluginClient: PluginClient,
) => Promise<TokenRefreshResult>;
let isTokenExpiredImpl: (account: Pick<StoredAccount, "accessToken" | "expiresAt">) => boolean;

const getConfigCalls: Array<[]> = [];
const refreshTokenCalls: Array<[string, string, PluginClient]> = [];
const isTokenExpiredCalls: Array<[Pick<StoredAccount, "accessToken" | "expiresAt">]> = [];

let originalSetTimeout: typeof setTimeout;
let originalClearTimeout: typeof clearTimeout;
let scheduledTimers: ScheduledTimer[] = [];
let timerSeed = 0;

function shouldCaptureTimer(delayMs: number): boolean {
  return delayMs === 5_000 || delayMs === currentConfig.proactive_refresh_interval_seconds * 1000;
}

function installTimerSpies(): void {
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  scheduledTimers = [];
  timerSeed = 0;

  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof handler !== "function") {
      throw new Error("Expected function timeout handler");
    }
    const delayMs = Number(timeout ?? 0);
    if (!shouldCaptureTimer(delayMs)) {
      return originalSetTimeout(handler, timeout, ...args);
    }

    timerSeed += 1;
    const timerHandle = {
      __timerId: timerSeed,
      ref: () => timerHandle,
      unref: () => timerHandle,
      hasRef: () => false,
      refresh: () => timerHandle,
    };
    const handle = timerHandle as unknown as TimeoutHandle;
    const callback = () => {
      handler(...args);
    };
    scheduledTimers.push({
      handle,
      delayMs,
      callback,
      cleared: false,
      fired: false,
    });
    return handle;
  }) as unknown as typeof setTimeout;

  globalThis.clearTimeout = ((handle?: TimeoutHandle) => {
    if (!handle) return;
    const timer = scheduledTimers.find((entry) => entry.handle === handle);
    if (timer) {
      timer.cleared = true;
      return;
    }
    originalClearTimeout(handle);
  }) as typeof clearTimeout;
}

function restoreTimerSpies(): void {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  scheduledTimers = [];
}

function requirePendingTimerByDelay(delayMs: number): ScheduledTimer {
  const timer = [...scheduledTimers]
    .reverse()
    .find((entry) => !entry.cleared && !entry.fired && entry.delayMs === delayMs);
  if (!timer) {
    throw new Error(`Expected pending timer with delay ${delayMs}`);
  }
  return timer;
}

async function firePendingTimerByDelay(
  delayMs: number,
  options: { awaitInFlight?: boolean } = {},
): Promise<void> {
  const timer = requirePendingTimerByDelay(delayMs);
  timer.fired = true;
  timer.callback();
  await flushPromises();
  if (options.awaitInFlight !== false) {
    const inFlight = activeQueue
      ? (activeQueue as unknown as { inFlight: Promise<void> | null }).inFlight
      : null;
    if (inFlight) {
      await inFlight;
    }
  }
  await waitForAsyncWork();
}

function requireStoragePath(): string {
  if (!storagePath) {
    throw new Error("Storage path is not initialized");
  }
  return storagePath;
}

async function readStorageFromDisk(path: string): Promise<AccountStorage | null> {
  try {
    const raw = await fs.readFile(path, "utf-8");
    return JSON.parse(raw) as AccountStorage;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeStorageToDisk(path: string, storage: AccountStorage): Promise<void> {
  await fs.writeFile(path, `${JSON.stringify(storage, null, 2)}\n`, "utf-8");
}

async function seedStorage(accounts: StoredAccount[]): Promise<void> {
  const storage = createStorage(accounts);
  await writeStorageToDisk(requireStoragePath(), storage);
}

async function readPersistedStorage(): Promise<AccountStorage> {
  const loaded = await readStorageFromDisk(requireStoragePath());
  if (!loaded) {
    throw new Error("Expected non-null storage");
  }
  return loaded;
}

async function createQueue(): Promise<QueueType> {
  const { ProactiveRefreshQueue } = await import("../src/proactive-refresh");
  const queue = new ProactiveRefreshQueue(client, new AccountStore());
  activeQueue = queue;
  return queue;
}

describe("proactive-refresh", () => {
  beforeEach(async () => {
    installTimerSpies();

    testEnv = await setupTestEnv();
    storagePath = join(testEnv.dir, ACCOUNTS_FILENAME);
    client = createMockClient();
    currentConfig = createDefaultConfig();

    getConfigCalls.length = 0;
    refreshTokenCalls.length = 0;
    isTokenExpiredCalls.length = 0;

    isTokenExpiredImpl = () => false;
    refreshTokenImpl = async (_currentRefreshToken, accountId) => ({
      ok: true,
      patch: {
        accessToken: `new-access-${accountId}`,
        expiresAt: Date.now() + 3_600_000,
      },
    });

    getConfigMock.mockImplementation(() => {
      getConfigCalls.push([]);
      return currentConfig;
    });

    refreshTokenMock.mockImplementation((
      currentRefreshToken: string,
      accountId: string,
      pluginClient: PluginClient,
    ) => {
      refreshTokenCalls.push([currentRefreshToken, accountId, pluginClient]);
      return refreshTokenImpl(currentRefreshToken, accountId, pluginClient);
    });

    isTokenExpiredMock.mockImplementation((account: Pick<StoredAccount, "accessToken" | "expiresAt">) => {
      isTokenExpiredCalls.push([account]);
      return isTokenExpiredImpl(account);
    });
  });

  afterEach(async () => {
    if (activeQueue) {
      await activeQueue.stop();
      activeQueue = null;
    }

    if (testEnv) {
      await testEnv.cleanup();
      testEnv = null;
    }

    storagePath = "";
    restoreTimerSpies();
  });

  test("start() does nothing when config.proactive_refresh is false", async () => {
    currentConfig = {
      ...currentConfig,
      proactive_refresh: false,
    };

    const queue = await createQueue();
    queue.start();

    expect(scheduledTimers.length).toBe(0);
    expect(refreshTokenCalls.length).toBe(0);
  });

  test("start() schedules the initial check after INITIAL_DELAY_MS (5000ms)", async () => {
    await seedStorage([
      createAccount(1, { expiresAt: Date.now() + 15_000 }),
    ]);

    const queue = await createQueue();
    queue.start();

    const firstTimer = requirePendingTimerByDelay(5_000);
    expect(firstTimer.delayMs).toBe(5_000);
    await firePendingTimerByDelay(5_000);
    expect(refreshTokenCalls.length).toBe(1);
  });

  test("stop() clears scheduled timeout and increments runToken", async () => {
    const queue = await createQueue();
    queue.start();

    const firstTimer = requirePendingTimerByDelay(5_000);
    await queue.stop();

    expect(firstTimer.cleared).toBe(true);

    firstTimer.callback();
    await flushPromises();

    expect(refreshTokenCalls.length).toBe(0);
  });

  test("stop() waits for in-flight refresh to complete before resolving", async () => {
    await seedStorage([
      createAccount(2, { expiresAt: Date.now() + 120_000 }),
    ]);

    const deferred = createDeferred<TokenRefreshResult>();
    refreshTokenImpl = async () => deferred.promise;

    const queue = await createQueue();
    queue.start();
    await firePendingTimerByDelay(5_000, { awaitInFlight: false });
    await waitForRefreshCalls(1);

    expect(refreshTokenCalls.length).toBe(1);

    let stopResolved = false;
    const stopPromise = queue.stop().then(() => {
      stopResolved = true;
    });

    await flushPromises();
    expect(stopResolved).toBe(false);

    deferred.resolve({
      ok: true,
      patch: {
        accessToken: "resolved-after-stop",
        expiresAt: Date.now() + 3_600_000,
      },
    });

    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  test("needsProactiveRefresh returns false for accounts without accessToken/expiresAt", async () => {
    await seedStorage([
      createAccount(3, {
        accessToken: undefined,
        expiresAt: undefined,
      }),
    ]);

    const queue = await createQueue();
    queue.start();
    await firePendingTimerByDelay(5_000);

    expect(refreshTokenCalls.length).toBe(0);
  });

  test("needsProactiveRefresh returns false for already-expired tokens", async () => {
    await seedStorage([
      createAccount(4, {
        expiresAt: Date.now() + 1_000,
      }),
    ]);

    isTokenExpiredImpl = () => true;

    const queue = await createQueue();
    queue.start();
    await firePendingTimerByDelay(5_000);

    expect(refreshTokenCalls.length).toBe(0);
  });

  test("needsProactiveRefresh returns true for tokens expiring within buffer window", async () => {
    currentConfig = {
      ...currentConfig,
      proactive_refresh_buffer_seconds: 300,
    };

    await seedStorage([
      createAccount(5, {
        expiresAt: Date.now() + 120_000,
      }),
    ]);

    const queue = await createQueue();
    queue.start();
    await firePendingTimerByDelay(5_000);

    expect(refreshTokenCalls.length).toBe(1);
  });

  test("needsProactiveRefresh returns false for tokens with plenty of time left", async () => {
    currentConfig = {
      ...currentConfig,
      proactive_refresh_buffer_seconds: 60,
    };

    await seedStorage([
      createAccount(6, {
        expiresAt: Date.now() + 300_000,
      }),
    ]);

    const queue = await createQueue();
    queue.start();
    await firePendingTimerByDelay(5_000);

    expect(refreshTokenCalls.length).toBe(0);
  });

  test("runCheck skips disabled/auth-disabled accounts", async () => {
    const disabledAccount = createAccount(7, {
      uuid: "disabled-account",
      enabled: false,
      expiresAt: Date.now() + 120_000,
    });
    const authDisabledAccount = createAccount(8, {
      uuid: "auth-disabled-account",
      isAuthDisabled: true,
      expiresAt: Date.now() + 120_000,
    });
    const validAccount = createAccount(9, {
      uuid: "valid-account",
      expiresAt: Date.now() + 120_000,
    });

    await seedStorage([disabledAccount, authDisabledAccount, validAccount]);

    const queue = await createQueue();
    queue.start();
    await firePendingTimerByDelay(5_000);

    expect(refreshTokenCalls.length).toBe(1);
    expect(refreshTokenCalls[0]?.[1]).toBe("valid-account");
  });

  test("runCheck calls refreshToken and persists new credentials on success", async () => {
    const account = createAccount(10, {
      uuid: "success-account",
      refreshToken: "success-refresh-token",
      expiresAt: Date.now() + 120_000,
    });

    await seedStorage([account]);

    refreshTokenImpl = async () => ({
      ok: true,
      patch: {
        accessToken: "updated-access-token",
        expiresAt: Date.now() + 7_200_000,
        refreshToken: "updated-refresh-token",
        email: "updated@example.com",
      },
    });

    const queue = await createQueue();
    queue.start();
    await firePendingTimerByDelay(5_000);

    expect(refreshTokenCalls.length).toBe(1);
    expect(refreshTokenCalls[0]?.[0]).toBe("success-refresh-token");
    expect(refreshTokenCalls[0]?.[1]).toBe("success-account");
    expect(refreshTokenCalls[0]?.[2]).toBe(client);

    const persisted = await readPersistedStorage();
    const updated = persisted.accounts.find((entry) => entry.uuid === "success-account");
    expect(updated?.accessToken).toBe("updated-access-token");
    expect(updated?.refreshToken).toBe("updated-refresh-token");
    expect(updated?.email).toBe("updated@example.com");
    expect(updated?.isAuthDisabled).toBe(false);
  });

  test("runCheck calls persistFailure on refresh failure", async () => {
    await seedStorage([
      createAccount(11, {
        uuid: "failure-account",
        consecutiveAuthFailures: 1,
        expiresAt: Date.now() + 120_000,
      }),
    ]);

    refreshTokenImpl = async () => ({ ok: false, permanent: false });

    const queue = await createQueue();
    queue.start();
    await firePendingTimerByDelay(5_000);

    const persisted = await readPersistedStorage();
    const updated = persisted.accounts.find((entry) => entry.uuid === "failure-account");
    expect(updated?.consecutiveAuthFailures).toBe(2);
  });

  test("runCheck respects runToken cancellation between account iterations", async () => {
    await seedStorage([
      createAccount(12, {
        uuid: "first-account",
        refreshToken: "first-refresh",
        expiresAt: Date.now() + 120_000,
      }),
      createAccount(13, {
        uuid: "second-account",
        refreshToken: "second-refresh",
        expiresAt: Date.now() + 120_000,
      }),
    ]);

    const deferred = createDeferred<TokenRefreshResult>();
    let refreshCallCount = 0;
    refreshTokenImpl = async () => {
      refreshCallCount += 1;
      if (refreshCallCount === 1) {
        return deferred.promise;
      }
      return {
        ok: true,
        patch: {
          accessToken: "second-call-token",
          expiresAt: Date.now() + 3_600_000,
        },
      };
    };

    const queue = await createQueue();
    queue.start();
    await firePendingTimerByDelay(5_000, { awaitInFlight: false });
    await waitForRefreshCalls(1);

    expect(refreshTokenCalls.length).toBe(1);

    const stopPromise = queue.stop();
    deferred.resolve({
      ok: true,
      patch: {
        accessToken: "first-call-token",
        expiresAt: Date.now() + 3_600_000,
      },
    });

    await stopPromise;
    await flushPromises();

    expect(refreshTokenCalls.length).toBe(1);
  });

  test("persistFailure sets isAuthDisabled for permanent failures", async () => {
    await seedStorage([
      createAccount(14, {
        uuid: "permanent-failure-account",
        expiresAt: Date.now() + 120_000,
      }),
    ]);

    refreshTokenImpl = async () => ({ ok: false, permanent: true });

    const queue = await createQueue();
    queue.start();
    await firePendingTimerByDelay(5_000);

    const persisted = await readPersistedStorage();
    const updated = persisted.accounts.find((account) => account.uuid === "permanent-failure-account");
    expect(updated?.isAuthDisabled).toBe(true);
    expect(updated?.authDisabledReason).toBe("Token permanently rejected (proactive refresh)");
  });

  test("persistFailure increments consecutiveAuthFailures for transient failures", async () => {
    currentConfig = {
      ...currentConfig,
      max_consecutive_auth_failures: 5,
    };

    await seedStorage([
      createAccount(15, {
        uuid: "transient-failure-account",
        consecutiveAuthFailures: 1,
        expiresAt: Date.now() + 120_000,
      }),
    ]);

    refreshTokenImpl = async () => ({ ok: false, permanent: false });

    const queue = await createQueue();
    queue.start();
    await firePendingTimerByDelay(5_000);

    const persisted = await readPersistedStorage();
    const updated = persisted.accounts.find((account) => account.uuid === "transient-failure-account");
    expect(updated?.consecutiveAuthFailures).toBe(2);
    expect(updated?.isAuthDisabled).toBe(false);
  });

  test("self-rescheduling schedules next check after completing current one", async () => {
    currentConfig = {
      ...currentConfig,
      proactive_refresh_interval_seconds: 42,
    };

    await seedStorage([
      createAccount(16, {
        uuid: "reschedule-account",
        expiresAt: Date.now() + 120_000,
      }),
    ]);

    const queue = await createQueue();
    queue.start();
    expect(scheduledTimers.some((timer) => timer.delayMs === 5_000)).toBe(true);

    await firePendingTimerByDelay(5_000);

    const nextTimer = requirePendingTimerByDelay(42_000);
    expect(nextTimer.delayMs).toBe(42_000);
  });
});
