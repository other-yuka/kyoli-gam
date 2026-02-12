import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AccountStore } from "../src/account-store";
import { ACCOUNTS_FILENAME } from "../src/constants";
import type { AccountStorage, StoredAccount } from "../src/types";
import { setupTestEnv } from "./helpers";

type TestEnv = Awaited<ReturnType<typeof setupTestEnv>>;

let testEnv: TestEnv | null = null;

function requireConfigDir(): string {
  if (!testEnv) {
    throw new Error("Test environment is not initialized");
  }
  return testEnv.dir;
}

function getStoragePath(): string {
  return join(requireConfigDir(), ACCOUNTS_FILENAME);
}

function createAccount(index: number, overrides: Partial<StoredAccount> = {}): StoredAccount {
  const baseTime = 1_700_000_000_000 + index;
  const base: StoredAccount = {
    uuid: `uuid-${index}`,
    email: `user${index}@example.com`,
    refreshToken: `refresh-${index}`,
    accessToken: `access-${index}`,
    expiresAt: baseTime + 3_600_000,
    addedAt: baseTime,
    lastUsed: baseTime,
    enabled: true,
    consecutiveAuthFailures: 0,
    isAuthDisabled: false,
  };
  return { ...base, ...overrides };
}

function createStorage(accounts: StoredAccount[], activeAccountUuid?: string): AccountStorage {
  return {
    version: 1,
    accounts,
    activeAccountUuid,
  };
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function writeStorage(storage: AccountStorage): Promise<void> {
  const storagePath = getStoragePath();
  await fs.writeFile(storagePath, JSON.stringify(storage), "utf-8");
}

async function readStorage(): Promise<AccountStorage> {
  const storagePath = getStoragePath();
  const raw = await fs.readFile(storagePath, "utf-8");
  return JSON.parse(raw) as AccountStorage;
}

describe("account-store", () => {
  beforeEach(async () => {
    testEnv = await setupTestEnv();
  });

  afterEach(async () => {
    if (testEnv) {
      await testEnv.cleanup();
      testEnv = null;
    }
  });

  describe("load", () => {
    test("loads from disk when file exists", async () => {
      const stored = createStorage([createAccount(1)], "uuid-1");
      await fs.writeFile(getStoragePath(), JSON.stringify(stored), "utf-8");

      const store = new AccountStore();
      const loaded = await store.load();

      expect(loaded.version).toBe(1);
      expect(loaded.accounts.length).toBe(1);
      expect(loaded.accounts[0]?.uuid).toBe("uuid-1");
      expect(loaded.activeAccountUuid).toBe("uuid-1");
    });

    test("returns empty storage when file does not exist", async () => {
      const store = new AccountStore();

      const loaded = await store.load();

      expect(loaded).toEqual({ version: 1, accounts: [] });
    });
  });

  describe("readCredentials", () => {
    test("returns credentials for matching uuid", async () => {
      const stored = createStorage([
        createAccount(2, {
          uuid: "target-uuid",
          refreshToken: "refresh-target",
          accessToken: "access-target",
          expiresAt: 1_700_000_000_222,
        }),
      ]);
      await fs.writeFile(getStoragePath(), JSON.stringify(stored), "utf-8");

      const store = new AccountStore();
      const credentials = await store.readCredentials("target-uuid");

      expect(credentials === null).toBe(false);
      expect(credentials?.refreshToken).toBe("refresh-target");
      expect(credentials?.accessToken).toBe("access-target");
      expect(credentials?.expiresAt).toBe(1_700_000_000_222);
    });

    test("returns null when uuid is not found", async () => {
      const stored = createStorage([createAccount(3)]);
      await fs.writeFile(getStoragePath(), JSON.stringify(stored), "utf-8");

      const store = new AccountStore();
      const credentials = await store.readCredentials("missing-uuid");

      expect(credentials).toBe(null);
    });

    test("returns null when file is missing", async () => {
      const store = new AccountStore();

      const credentials = await store.readCredentials("missing-uuid");

      expect(credentials).toBe(null);
    });
  });

  describe("mutateAccount", () => {
    test("mutates one account and persists to disk", async () => {
      await writeStorage(createStorage([createAccount(4, { uuid: "target-uuid" })]));
      const store = new AccountStore();

      const mutated = await store.mutateAccount("target-uuid", (account) => {
        account.accessToken = "updated-access";
        account.expiresAt = 1_700_000_001_444;
      });

      expect(mutated === null).toBe(false);
      expect(mutated?.accessToken).toBe("updated-access");
      expect(mutated?.expiresAt).toBe(1_700_000_001_444);

      const saved = await readStorage();
      const updated = saved.accounts.find((account) => account.uuid === "target-uuid");
      expect(updated === undefined).toBe(false);
      expect(updated?.accessToken).toBe("updated-access");
      expect(updated?.expiresAt).toBe(1_700_000_001_444);
    });

    test("returns null when uuid is not found", async () => {
      await writeStorage(createStorage([createAccount(5, { uuid: "existing-uuid" })]));
      const store = new AccountStore();

      const mutated = await store.mutateAccount("missing-uuid", (account) => {
        account.accessToken = "should-not-write";
      });

      expect(mutated).toBe(null);

      const saved = await readStorage();
      expect(saved.accounts.length).toBe(1);
      expect(saved.accounts[0]?.uuid).toBe("existing-uuid");
      expect(saved.accounts[0]?.accessToken).toBe("access-5");
    });

    test("returns null when file is missing", async () => {
      const store = new AccountStore();

      const mutated = await store.mutateAccount("missing-uuid", (account) => {
        account.accessToken = "should-not-write";
      });

      expect(mutated).toBe(null);

      const saved = await readStorage();
      expect(saved.version).toBe(1);
      expect(saved.accounts.length).toBe(0);
    });
  });

  describe("mutateStorage", () => {
    test("mutates full storage and persists", async () => {
      await writeStorage(createStorage([createAccount(6)], "uuid-6"));
      const store = new AccountStore();

      await store.mutateStorage((storage) => {
        storage.accounts.push(createAccount(7));
        storage.activeAccountUuid = "uuid-7";
      });

      const saved = await readStorage();
      expect(saved.version).toBe(1);
      expect(saved.accounts.length).toBe(2);
      expect(saved.accounts[0]?.uuid).toBe("uuid-6");
      expect(saved.accounts[1]?.uuid).toBe("uuid-7");
      expect(saved.activeAccountUuid).toBe("uuid-7");
    });
  });

  describe("addAccount", () => {
    test("adds a new account", async () => {
      await writeStorage(createStorage([createAccount(8)]));
      const store = new AccountStore();

      await store.addAccount(createAccount(9));

      const saved = await readStorage();
      expect(saved.accounts.length).toBe(2);
      expect(saved.accounts[0]?.uuid).toBe("uuid-8");
      expect(saved.accounts[1]?.uuid).toBe("uuid-9");
    });

    test("rejects duplicate uuid", async () => {
      await writeStorage(createStorage([createAccount(10, { uuid: "dup-uuid" })]));
      const store = new AccountStore();

      await store.addAccount(createAccount(11, {
        uuid: "dup-uuid",
        refreshToken: "new-refresh-token",
      }));

      const saved = await readStorage();
      expect(saved.accounts.length).toBe(1);
      expect(saved.accounts[0]?.uuid).toBe("dup-uuid");
      expect(saved.accounts[0]?.refreshToken).toBe("refresh-10");
    });

    test("rejects duplicate refreshToken", async () => {
      await writeStorage(createStorage([createAccount(12, { refreshToken: "dup-refresh" })]));
      const store = new AccountStore();

      await store.addAccount(createAccount(13, {
        uuid: "new-uuid",
        refreshToken: "dup-refresh",
      }));

      const saved = await readStorage();
      expect(saved.accounts.length).toBe(1);
      expect(saved.accounts[0]?.uuid).toBe("uuid-12");
      expect(saved.accounts[0]?.refreshToken).toBe("dup-refresh");
    });
  });

  describe("removeAccount", () => {
    test("removes account and resets activeAccountUuid when removing active", async () => {
      await writeStorage(createStorage([createAccount(14), createAccount(15)], "uuid-14"));
      const store = new AccountStore();

      const removed = await store.removeAccount("uuid-14");

      expect(removed).toBe(true);

      const saved = await readStorage();
      expect(saved.accounts.length).toBe(1);
      expect(saved.accounts[0]?.uuid).toBe("uuid-15");
      expect(saved.activeAccountUuid).toBe("uuid-15");
    });

    test("returns false when uuid not found", async () => {
      await writeStorage(createStorage([createAccount(16)], "uuid-16"));
      const store = new AccountStore();

      const removed = await store.removeAccount("missing-uuid");

      expect(removed).toBe(false);

      const saved = await readStorage();
      expect(saved.accounts.length).toBe(1);
      expect(saved.accounts[0]?.uuid).toBe("uuid-16");
      expect(saved.activeAccountUuid).toBe("uuid-16");
    });
  });

  describe("setActiveUuid", () => {
    test("sets and persists active uuid", async () => {
      await writeStorage(createStorage([createAccount(17), createAccount(18)], "uuid-17"));
      const store = new AccountStore();

      await store.setActiveUuid("uuid-18");

      const saved = await readStorage();
      expect(saved.accounts.length).toBe(2);
      expect(saved.activeAccountUuid).toBe("uuid-18");
    });
  });

  describe("clear", () => {
    test("resets to empty storage", async () => {
      await writeStorage(createStorage([createAccount(19), createAccount(20)], "uuid-19"));
      const store = new AccountStore();

      await store.clear();

      const saved = await readStorage();
      expect(saved.version).toBe(1);
      expect(saved.accounts.length).toBe(0);
      expect(saved.activeAccountUuid).toBe(undefined);
    });
  });

  describe("concurrency", () => {
    test("multiple parallel mutateAccount calls do not corrupt data", { timeout: 15_000 }, async () => {
      await writeStorage(createStorage([
        createAccount(21, { uuid: "concurrent-uuid", consecutiveAuthFailures: 0 }),
      ]));
      const store = new AccountStore();

      const mutateWithRetry = async (): Promise<StoredAccount | null> => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            return await store.mutateAccount("concurrent-uuid", (account) => {
              account.consecutiveAuthFailures += 1;
            });
          } catch (error) {
            const isLockError = getErrorCode(error) === "ELOCKED";
            if (!isLockError || attempt === 7) {
              throw error;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 30));
          }
        }
        return null;
      };

      const results = await Promise.all(
        Array.from({ length: 10 }, async () => mutateWithRetry()),
      );

      expect(results.length).toBe(10);
      expect(results.every((result) => result !== null)).toBe(true);

      const saved = await readStorage();
      const updated = saved.accounts.find((account) => account.uuid === "concurrent-uuid");
      expect(updated === undefined).toBe(false);
      expect(updated?.consecutiveAuthFailures).toBe(10);
    });
  });

  describe("file locking", () => {
    test("sequential mutations maintain data integrity", async () => {
      await writeStorage(createStorage([
        createAccount(22, { uuid: "locked-uuid", consecutiveAuthFailures: 0 }),
      ], "locked-uuid"));
      const store = new AccountStore();

      for (let i = 0; i < 12; i += 1) {
        await store.mutateAccount("locked-uuid", (account) => {
          account.consecutiveAuthFailures += 1;
        });
      }

      const raw = await fs.readFile(getStoragePath(), "utf-8");
      const parsed = JSON.parse(raw) as AccountStorage;

      expect(parsed.version).toBe(1);
      expect(parsed.accounts.length).toBe(1);
      expect(parsed.accounts[0]?.uuid).toBe("locked-uuid");
      expect(parsed.accounts[0]?.consecutiveAuthFailures).toBe(12);
      expect(parsed.activeAccountUuid).toBe("locked-uuid");
    });
  });
});
