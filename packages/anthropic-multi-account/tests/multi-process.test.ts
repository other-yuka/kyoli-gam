import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as v from "valibot";
import { ACCOUNTS_FILENAME } from "../src/constants";
import { AccountStore } from "../src/account-store";
import { loadAccounts } from "../src/storage";
import { AccountStorageSchema } from "../src/types";
import type { AccountStorage, StoredAccount } from "../src/types";
import { setupTestEnv } from "../tests/helpers";

const CLAIMS_FILENAME = "multiauth-claims.json";
const STORAGE_WORKER_PATH = join(process.cwd(), "tests/workers/storage-worker.ts");
const CLAIM_WORKER_PATH = join(process.cwd(), "tests/workers/claim-worker.ts");

type TestEnv = Awaited<ReturnType<typeof setupTestEnv>>;

type WorkerResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type ClaimsMap = Record<string, { pid: number; at: number }>;

let testEnv: TestEnv | null = null;

function getTestEnv(): TestEnv {
  if (!testEnv) {
    throw new Error("Test environment is not initialized");
  }
  return testEnv;
}

function createAccount(id: string, seed: number): StoredAccount {
  const timestamp = 1_800_000_000_000 + seed;
  return {
    uuid: id,
    email: `${id}@example.com`,
    planTier: "pro",
    refreshToken: `refresh-${id}`,
    addedAt: timestamp,
    lastUsed: timestamp,
    enabled: true,
    consecutiveAuthFailures: 0,
    isAuthDisabled: false,
  };
}

function createStorage(accounts: StoredAccount[]): AccountStorage {
  return { version: 1, accounts };
}

function runWorker(
  scriptPath: string,
  args: string[],
  env: Record<string, string>,
): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", scriptPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe("multi-process integration", () => {
  beforeEach(async () => {
    testEnv = await setupTestEnv();
  });

  afterEach(async () => {
    if (testEnv) {
      await testEnv.cleanup();
      testEnv = null;
    }
  });

  test("concurrent saveAccounts with 5 processes", { timeout: 15_000 }, async () => {
    const env = getTestEnv();
    const workers = Array.from({ length: 5 }, (_, index) => {
      const accountId = `save-${index}`;
      const storage = createStorage([createAccount(accountId, index)]);
      return runWorker(STORAGE_WORKER_PATH, [JSON.stringify(storage)], {
        OPENCODE_CONFIG_DIR: env.dir,
      });
    });

    const results = await Promise.all(workers);

    for (const result of results) {
      expect(result.code).toBe(0);
    }

    const raw = await fs.readFile(join(env.dir, ACCOUNTS_FILENAME), "utf-8");
    const parsed = JSON.parse(raw);
    const validation = v.safeParse(AccountStorageSchema, parsed);

    expect(validation.success).toBe(true);
    if (!validation.success) {
      throw new Error("Storage schema validation failed");
    }

    const uuids = new Set(validation.output.accounts.map((account) => account.uuid));
    expect(uuids.size).toBe(5);
    for (let index = 0; index < 5; index += 1) {
      expect(uuids.has(`save-${index}`)).toBe(true);
    }
  });

  test("concurrent claim racing with 3 processes", { timeout: 15_000 }, async () => {
    const env = getTestEnv();
    const accountIds = ["claim-a", "claim-b", "claim-c"];

    const results = await Promise.all(
      accountIds.map((accountId, index) => runWorker(CLAIM_WORKER_PATH, [accountId], {
        OPENCODE_CONFIG_DIR: env.dir,
        CLAIM_WRITE_DELAY_MS: String(index * 50),
        CLAIM_HOLD_MS: "500",
      })),
    );

    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.stdout.length > 0).toBe(true);
    }

    const rawClaims = await fs.readFile(join(env.dir, CLAIMS_FILENAME), "utf-8");
    const claims = JSON.parse(rawClaims) as ClaimsMap;
    const claimEntries = Object.entries(claims);

    expect(claimEntries.length).toBe(3);
    const pids = new Set(claimEntries.map(([, claim]) => claim.pid));
    expect(pids.size).toBe(3);

    for (const accountId of accountIds) {
      expect(claims[accountId] === undefined).toBe(false);
    }
  });

  test("save and load interleaving keeps all accounts", { timeout: 15_000 }, async () => {
    const env = getTestEnv();

    const storageA = createStorage([
      createAccount("interleave-1", 11),
      createAccount("interleave-2", 12),
    ]);
    const storageB = createStorage([
      createAccount("interleave-3", 13),
      createAccount("interleave-4", 14),
    ]);

    const [resultA, resultB] = await Promise.all([
      runWorker(STORAGE_WORKER_PATH, [JSON.stringify(storageA)], { OPENCODE_CONFIG_DIR: env.dir }),
      runWorker(STORAGE_WORKER_PATH, [JSON.stringify(storageB)], { OPENCODE_CONFIG_DIR: env.dir }),
    ]);

    expect(resultA.code).toBe(0);
    expect(resultB.code).toBe(0);

    const loaded = await loadAccounts();
    expect(loaded === null).toBe(false);
    if (!loaded) {
      throw new Error("Expected non-null storage");
    }

    const uuids = new Set(loaded.accounts.map((account) => account.uuid));
    expect(uuids.size).toBe(4);
    expect(uuids.has("interleave-1")).toBe(true);
    expect(uuids.has("interleave-2")).toBe(true);
    expect(uuids.has("interleave-3")).toBe(true);
    expect(uuids.has("interleave-4")).toBe(true);
  });

  test("no data loss under contention", { timeout: 15_000 }, async () => {
    const env = getTestEnv();

    await new AccountStore().addAccount(createAccount("base-a", 20));

    const resultSet = await Promise.all([
      runWorker(STORAGE_WORKER_PATH, [JSON.stringify(createStorage([createAccount("base-b", 21)]))], {
        OPENCODE_CONFIG_DIR: env.dir,
      }),
      runWorker(STORAGE_WORKER_PATH, [JSON.stringify(createStorage([createAccount("base-c", 22)]))], {
        OPENCODE_CONFIG_DIR: env.dir,
      }),
      runWorker(STORAGE_WORKER_PATH, [JSON.stringify(createStorage([createAccount("base-d", 23)]))], {
        OPENCODE_CONFIG_DIR: env.dir,
      }),
    ]);

    for (const result of resultSet) {
      expect(result.code).toBe(0);
    }

    const finalStorage = await loadAccounts();
    expect(finalStorage === null).toBe(false);
    if (!finalStorage) {
      throw new Error("Expected non-null storage");
    }

    const finalUuids = new Set(finalStorage.accounts.map((account) => account.uuid));
    expect(finalUuids.size).toBe(4);
    expect(finalUuids.has("base-a")).toBe(true);
    expect(finalUuids.has("base-b")).toBe(true);
    expect(finalUuids.has("base-c")).toBe(true);
    expect(finalUuids.has("base-d")).toBe(true);
  });
});
