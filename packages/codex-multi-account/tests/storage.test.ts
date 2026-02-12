import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ACCOUNTS_FILENAME } from "../src/constants";
import {
  deduplicateAccounts,
  loadAccounts,
} from "../src/storage";
import type { AccountStorage, StoredAccount } from "../src/types";
import { setupTestEnv } from "../tests/helpers";

type TestEnv = Awaited<ReturnType<typeof setupTestEnv>>;

let testEnv: TestEnv | null = null;

function getStoragePath(): string {
  if (!testEnv) {
    throw new Error("Test environment is not initialized");
  }
  return join(testEnv.dir, ACCOUNTS_FILENAME);
}

function createAccount(index: number, overrides: Partial<StoredAccount> = {}): StoredAccount {
  const baseTime = 1_700_000_000_000 + index;
  const base: StoredAccount = {
    uuid: `uuid-${index}`,
    email: `user${index}@example.com`,
    planTier: "",
    refreshToken: `refresh-${index}`,
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

describe("storage", () => {
  beforeEach(async () => {
    testEnv = await setupTestEnv();
  });

  afterEach(async () => {
    if (testEnv) {
      await testEnv.cleanup();
      testEnv = null;
    }
  });

  describe("loadAccounts", () => {
    test("returns null when file does not exist", async () => {
      const storage = await loadAccounts();
      expect(storage).toBe(null);
    });

    test("returns valid storage when file exists", async () => {
      const stored = createStorage([createAccount(1)]);
      await fs.writeFile(getStoragePath(), `${JSON.stringify(stored, null, 2)}\n`, "utf-8");

      const loaded = await loadAccounts();
      expect(loaded === null).toBe(false);
      expect(loaded?.version).toBe(1);
      expect((loaded?.accounts || []).length).toBe(1);
      expect(loaded?.accounts[0]?.uuid).toBe("uuid-1");
      expect(loaded?.accounts[0]?.refreshToken).toBe("refresh-1");
    });

    test("returns null and creates backup for corrupt JSON", async () => {
      await fs.writeFile(getStoragePath(), "{ this-is-not-valid-json", "utf-8");

      const loaded = await loadAccounts();
      expect(loaded).toBe(null);

      if (!testEnv) {
        throw new Error("Test environment is not initialized");
      }
      const files = await fs.readdir(testEnv.dir);
      const backups = files.filter(
        (name) => name.startsWith(`${ACCOUNTS_FILENAME}.corrupt.`) && name.endsWith(".bak"),
      );

      expect(backups.length).toBe(1);
    });

    test("returns null and creates backup for invalid schema", async () => {
      const invalidStorage = { version: 2, accounts: [] };
      await fs.writeFile(getStoragePath(), `${JSON.stringify(invalidStorage, null, 2)}\n`, "utf-8");

      const loaded = await loadAccounts();
      expect(loaded).toBe(null);

      if (!testEnv) {
        throw new Error("Test environment is not initialized");
      }
      const files = await fs.readdir(testEnv.dir);
      const backups = files.filter(
        (name) => name.startsWith(`${ACCOUNTS_FILENAME}.corrupt.`) && name.endsWith(".bak"),
      );

      expect(backups.length).toBe(1);
    });
  });

  describe("deduplicateAccounts", () => {
    test("removes duplicate uuids and keeps the newest by lastUsed", () => {
      const older = createAccount(40, { uuid: "dup", lastUsed: 100, refreshToken: "old-token" });
      const newer = createAccount(41, { uuid: "dup", lastUsed: 200, refreshToken: "new-token" });
      const unique = createAccount(42, { uuid: "unique" });

      const result = deduplicateAccounts([older, newer, unique]);

      expect(result.length).toBe(2);
      const deduped = result.find((account) => account.uuid === "dup");
      expect(deduped?.lastUsed).toBe(200);
      expect(deduped?.refreshToken).toBe("new-token");
    });

    test("keeps accounts without uuid", () => {
      const firstNoUuid = createAccount(50, { uuid: undefined, refreshToken: "no-uuid-1" });
      const secondNoUuid = createAccount(51, { uuid: undefined, refreshToken: "no-uuid-2" });

      const result = deduplicateAccounts([firstNoUuid, secondNoUuid]);

      expect(result.length).toBe(2);
      expect(result.map((account) => account.refreshToken)).toEqual(["no-uuid-1", "no-uuid-2"]);
    });

    test("returns empty array for empty input", () => {
      expect(deduplicateAccounts([])).toEqual([]);
    });
  });
});
