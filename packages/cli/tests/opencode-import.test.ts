import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAccountStore } from "@kyoli-gam/core";
import { importOpenCodeAccounts } from "../src/opencode-import";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("importOpenCodeAccounts", () => {
  it("imports enabled OpenCode multi-account OAuth accounts and skips disabled entries", async () => {
    const configDir = await createOpenCodeConfig();
    const store = new MemoryAccountStore();

    const result = await importOpenCodeAccounts(store, {
      configDir,
      claudeIdentity: {
        accountUuid: "local-claude-account",
        deviceId: "local-device",
      },
    });

    expect(result.created).toBe(2);
    expect(result.duplicates).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.sources).toMatchObject([
      { provider: "codex", total: 2, eligible: 1, created: 1, skipped: 1 },
      { provider: "claude-code", total: 2, eligible: 1, created: 1, skipped: 1 },
    ]);

    const accounts = await store.list();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((account) => account.provider).sort()).toEqual(["claude-code", "codex"]);
    expect(accounts.every((account) => account.kind === "oauth")).toBe(true);
    expect(accounts.every((account) => account.metadata.sourceUuid)).toBe(true);

    const claude = accounts.find((account) => account.provider === "claude-code");
    expect(claude?.credentials.accountId).toBe("claude-account-1");
    expect(claude?.metadata).toMatchObject({
      accountId: "claude-account-1",
      deviceId: "local-device",
      localAccountUuid: "local-claude-account",
    });
  });

  it("supports dry-run without writing to the store", async () => {
    const configDir = await createOpenCodeConfig();
    const store = new MemoryAccountStore();

    const result = await importOpenCodeAccounts(store, { configDir, dryRun: true });

    expect(result.created).toBe(2);
    expect(result.skipped).toBe(2);
    expect(await store.list()).toHaveLength(0);
  });

  it("deduplicates repeated imports by source uuid, account id, or email", async () => {
    const configDir = await createOpenCodeConfig();
    const store = new MemoryAccountStore();

    await importOpenCodeAccounts(store, { configDir });
    const result = await importOpenCodeAccounts(store, { configDir });

    expect(result.created).toBe(0);
    expect(result.duplicates).toBe(2);
    expect(result.skipped).toBe(2);
    expect(await store.list()).toHaveLength(2);
  });

  it("syncs changed OpenCode tokens into existing Kyoli accounts", async () => {
    const configDir = await createOpenCodeConfig();
    const store = new MemoryAccountStore();
    await importOpenCodeAccounts(store, { configDir });
    const [initial] = (await store.listByProvider("codex"));
    expect(initial).toBeDefined();
    await store.recordFailure(initial!.id, {
      status: 401,
      message: "stale token",
    });
    await writeFile(
      join(configDir, "openai-multi-account-accounts.json"),
      JSON.stringify({
        accounts: [
          createStoredAccount({
            uuid: "codex-1",
            accountId: "codex-account-1",
            email: "codex@example.test",
            accessToken: "rotated-access-token",
            refreshToken: "rotated-refresh-token",
            expiresAt: Date.now() + 2 * 60 * 60 * 1000,
            planTier: "pro",
            cachedUsage: {
              five_hour: { utilization: 10 },
            },
          }),
        ],
      }),
    );

    const result = await importOpenCodeAccounts(store, {
      configDir,
      provider: "codex",
      sync: true,
    });
    const synced = await store.get(initial!.id);

    expect(result).toMatchObject({
      created: 0,
      updated: 1,
      unchanged: 0,
      duplicates: 0,
      skipped: 0,
    });
    expect(await store.listByProvider("codex")).toHaveLength(1);
    expect(synced?.credentials).toMatchObject({
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
    });
    expect(synced?.metadata).toMatchObject({
      planTier: "pro",
      cachedUsage: {
        five_hour: { utilization: 10 },
      },
    });
    expect(synced?.failureCount).toBe(0);
    expect(synced?.authCooldownUntil).toBeUndefined();
    expect(synced?.consecutiveAuthFailures).toBe(0);
  });

  it("keeps unchanged synced duplicates out of the updated count", async () => {
    const configDir = await createOpenCodeConfig();
    const store = new MemoryAccountStore();
    await importOpenCodeAccounts(store, { configDir });

    const result = await importOpenCodeAccounts(store, {
      configDir,
      provider: "codex",
      sync: true,
    });

    expect(result).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 1,
      duplicates: 0,
      skipped: 1,
    });
  });

  it("can import a single provider", async () => {
    const configDir = await createOpenCodeConfig();
    const store = new MemoryAccountStore();

    const result = await importOpenCodeAccounts(store, { configDir, provider: "codex" });

    expect(result.created).toBe(1);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.provider).toBe("codex");
    expect((await store.list())[0]?.provider).toBe("codex");
  });

  it("uses the source uuid as Claude account id when the native account lacks accountId", async () => {
    const configDir = join(tmpdir(), `kyoli-opencode-import-${Date.now()}-${Math.random()}`);
    tempDirs.push(configDir);
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "anthropic-multi-account-accounts.json"),
      JSON.stringify({
        accounts: [
          createStoredAccount({
            uuid: "claude-source-uuid",
            accountId: undefined,
            email: "claude@example.test",
          }),
        ],
      }),
    );
    const store = new MemoryAccountStore();

    await importOpenCodeAccounts(store, {
      configDir,
      provider: "claude-code",
      claudeIdentity: { deviceId: "device-from-cc" },
    });

    const [account] = await store.list();
    expect(account?.credentials.accountId).toBe("claude-source-uuid");
    expect(account?.metadata.accountId).toBe("claude-source-uuid");
    expect(account?.metadata.deviceId).toBe("device-from-cc");
  });
});

async function createOpenCodeConfig(): Promise<string> {
  const configDir = join(tmpdir(), `kyoli-opencode-import-${Date.now()}-${Math.random()}`);
  tempDirs.push(configDir);
  await mkdir(configDir, { recursive: true });

  await writeFile(
    join(configDir, "openai-multi-account-accounts.json"),
    JSON.stringify({
      accounts: [
        createStoredAccount({
          uuid: "codex-1",
          accountId: "codex-account-1",
          email: "codex@example.test",
          planTier: "plus",
        }),
        createStoredAccount({
          uuid: "codex-disabled",
          email: "codex-disabled@example.test",
          enabled: false,
        }),
      ],
    }),
  );

  await writeFile(
    join(configDir, "anthropic-multi-account-accounts.json"),
    JSON.stringify({
      accounts: [
        createStoredAccount({
          uuid: "claude-1",
          accountId: "claude-account-1",
          email: "claude@example.test",
          planTier: "max",
          cachedUsage: {
            five_hour: { utilization: 25 },
          },
        }),
        createStoredAccount({
          uuid: "claude-dummy",
          email: "claude-dummy@example.test",
          isAuthDisabled: true,
        }),
      ],
    }),
  );

  return configDir;
}

function createStoredAccount(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uuid: "account-1",
    email: "account@example.test",
    accountId: "account-id",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
    enabled: true,
    addedAt: Date.now(),
    lastUsed: Date.now(),
    ...overrides,
  };
}
