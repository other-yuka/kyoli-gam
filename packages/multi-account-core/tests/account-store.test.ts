import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccountStore } from "../src/account-store";
import { ACCOUNTS_FILENAME, setAccountsFilename } from "../src/constants";
import type { StoredAccount, TokenRefreshResult } from "../src/types";
import { setupTestEnv } from "./helpers";

const ACCOUNTS_FILE = "core-accounts.test.json";

let cleanup: (() => Promise<void>) | undefined;
let storagePath = "";

function createAccount(id: string, overrides: Partial<StoredAccount> = {}): StoredAccount {
  const now = Date.now();
  return {
    uuid: id,
    refreshToken: `refresh-${id}`,
    accessToken: `access-${id}`,
    expiresAt: now + 60_000,
    addedAt: now,
    lastUsed: now,
    enabled: true,
    planTier: "",
    consecutiveAuthFailures: 0,
    isAuthDisabled: false,
    ...overrides,
  };
}

describe("core/account-store", () => {
  beforeEach(async () => {
    const env = await setupTestEnv();
    cleanup = env.cleanup;
    setAccountsFilename(ACCOUNTS_FILE);
    storagePath = join(env.dir, ACCOUNTS_FILE);
  });

  afterEach(async () => {
    setAccountsFilename(ACCOUNTS_FILENAME);
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  test("adds and loads accounts", async () => {
    const store = new AccountStore();
    await store.addAccount(createAccount("a1"));

    const loaded = await store.load();
    expect(loaded.accounts).toHaveLength(1);
    expect(loaded.accounts[0]?.uuid).toBe("a1");
  });

  test("reads credentials including accountId", async () => {
    const store = new AccountStore();
    await store.addAccount(createAccount("a2", { accountId: "acct-id-2" }));

    const credentials = await store.readCredentials("a2");
    expect(credentials?.refreshToken).toBe("refresh-a2");
    expect(credentials?.accountId).toBe("acct-id-2");
  });

  test("mutates account and persists change", async () => {
    const store = new AccountStore();
    await store.addAccount(createAccount("a3"));
    await store.mutateAccount("a3", (account) => {
      account.accessToken = "updated-token";
    });

    const persisted = JSON.parse(await fs.readFile(storagePath, "utf-8")) as { accounts: Array<{ accessToken?: string }> };
    expect(persisted.accounts[0]?.accessToken).toBe("updated-token");
  });

  test("adopts a fresh winner when only the access token changed", async () => {
    const store = new AccountStore();
    const expiresAt = Date.now() + 60_000;
    await store.addAccount(createAccount("winner", { expiresAt }));
    const expected = await store.readCredentials("winner");
    if (!expected) throw new Error("Expected stored credentials");

    await store.mutateAccount("winner", (account) => {
      account.accessToken = "access-from-other-process";
    });
    const refresh = vi.fn(async (): Promise<TokenRefreshResult> => ({
      ok: false,
      permanent: true,
    }));

    const { result } = await store.refreshAccountCredentials("winner", expected, refresh);

    expect(refresh).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      patch: { accessToken: "access-from-other-process", expiresAt },
    });
  });

  test("does not adopt another account with the same added timestamp", async () => {
    const store = new AccountStore();
    const addedAt = Date.now();
    await store.addAccount(createAccount("removed", {
      addedAt,
      accessToken: "access-removed",
      expiresAt: 1,
    }));
    await store.addAccount(createAccount("remaining", {
      addedAt,
      accessToken: "access-remaining",
      expiresAt: Date.now() + 60_000,
    }));
    const expected = await store.readCredentials("removed");
    if (!expected) throw new Error("Expected stored credentials");
    await store.removeAccount("removed");
    const refresh = vi.fn(async (): Promise<TokenRefreshResult> => ({
      ok: false,
      permanent: true,
    }));

    const { result } = await store.refreshAccountCredentials("removed", expected, refresh);

    expect(refresh).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, permanent: true });
    expect((await store.load()).accounts).toMatchObject([{
      uuid: "remaining",
      accessToken: "access-remaining",
    }]);
  });

  test("removes active account and reassigns active uuid", async () => {
    const store = new AccountStore();
    await store.addAccount(createAccount("a4"));
    await store.addAccount(createAccount("a5"));
    await store.setActiveUuid("a4");

    const removed = await store.removeAccount("a4");
    expect(removed).toBe(true);

    const loaded = await store.load();
    expect(loaded.accounts).toHaveLength(1);
    expect(loaded.accounts[0]?.uuid).toBe("a5");
    expect(loaded.activeAccountUuid).toBe("a5");
  });
});
