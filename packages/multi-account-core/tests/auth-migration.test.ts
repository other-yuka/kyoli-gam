import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { setupTestEnv, createTestStorage } from "./helpers";
import { AccountStore } from "../src/account-store";
import { migrateFromAuthJson } from "../src/auth-migration";

describe("migrateFromAuthJson", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let store: AccountStore;

  beforeEach(async () => {
    const env = await setupTestEnv();
    dir = env.dir;
    cleanup = env.cleanup;
    store = new AccountStore();
  });

  afterEach(async () => {
    await cleanup();
  });

  function writeAuthJson(data: Record<string, unknown>): Promise<void> {
    return fs.writeFile(join(dir, "auth.json"), JSON.stringify(data), "utf-8");
  }

  async function writeStorageFile(data: object): Promise<void> {
    const storagePath = join(dir, "multiauth-accounts.json");
    await fs.writeFile(storagePath, JSON.stringify(data), "utf-8");
  }

  it("returns false when storage already has accounts", async () => {
    await writeStorageFile(createTestStorage(2));
    await writeAuthJson({
      anthropic: { type: "oauth", refresh: "rt_existing", access: "at_existing", expires: 9999999999 },
    });

    const result = await migrateFromAuthJson("anthropic", store);

    expect(result).toBe(false);
  });

  it("returns false when auth.json does not exist", async () => {
    const result = await migrateFromAuthJson("anthropic", store);

    expect(result).toBe(false);
  });

  it("returns false when auth.json has no matching provider key", async () => {
    await writeAuthJson({ openai: { type: "oauth", refresh: "rt_openai", access: "at_openai", expires: 9999999999 } });

    const result = await migrateFromAuthJson("anthropic", store);

    expect(result).toBe(false);
  });

  it("returns false when credential is not oauth type", async () => {
    await writeAuthJson({ anthropic: { type: "api_key", key: "sk-ant-xxx" } });

    const result = await migrateFromAuthJson("anthropic", store);

    expect(result).toBe(false);
  });

  it("returns false when credential has no refresh token", async () => {
    await writeAuthJson({ anthropic: { type: "oauth", access: "at_only", expires: 9999999999 } });

    const result = await migrateFromAuthJson("anthropic", store);

    expect(result).toBe(false);
  });

  it("returns false when credential has empty refresh token", async () => {
    await writeAuthJson({ anthropic: { type: "oauth", refresh: "", access: "at_empty", expires: 9999999999 } });

    const result = await migrateFromAuthJson("anthropic", store);

    expect(result).toBe(false);
  });

  it("returns false when auth.json contains invalid JSON", async () => {
    await fs.writeFile(join(dir, "auth.json"), "not valid json {{{", "utf-8");

    const result = await migrateFromAuthJson("anthropic", store);

    expect(result).toBe(false);
  });

  it("imports credential when storage is empty and auth.json has valid cred", async () => {
    await writeAuthJson({
      anthropic: { type: "oauth", refresh: "rt_migrate", access: "at_migrate", expires: 1700000000000 },
    });

    const result = await migrateFromAuthJson("anthropic", store);

    expect(result).toBe(true);

    const storage = await store.load();
    expect(storage.accounts).toHaveLength(1);
  });

  it("imported account has correct fields", async () => {
    await writeAuthJson({
      anthropic: { type: "oauth", refresh: "rt_fields", access: "at_fields", expires: 1700000000000 },
    });

    await migrateFromAuthJson("anthropic", store);

    const storage = await store.load();
    const account = storage.accounts[0]!;

    expect(account.refreshToken).toBe("rt_fields");
    expect(account.accessToken).toBe("at_fields");
    expect(account.expiresAt).toBe(1700000000000);
    expect(account.uuid).toBeDefined();
    expect(account.enabled).toBe(true);
    expect(account.consecutiveAuthFailures).toBe(0);
    expect(account.isAuthDisabled).toBe(false);
  });

  it("imported account is set as active", async () => {
    await writeAuthJson({
      anthropic: { type: "oauth", refresh: "rt_active", access: "at_active", expires: 1700000000000 },
    });

    await migrateFromAuthJson("anthropic", store);

    const storage = await store.load();
    const account = storage.accounts[0]!;

    expect(storage.activeAccountUuid).toBe(account.uuid);
  });

  it("works with openai provider key", async () => {
    await writeAuthJson({
      openai: { type: "oauth", refresh: "rt_openai", access: "at_openai", expires: 1700000000000 },
    });

    const result = await migrateFromAuthJson("openai", store);

    expect(result).toBe(true);

    const storage = await store.load();
    expect(storage.accounts).toHaveLength(1);
    expect(storage.accounts[0]!.refreshToken).toBe("rt_openai");
  });

  it("handles credential without optional access and expires fields", async () => {
    await writeAuthJson({
      anthropic: { type: "oauth", refresh: "rt_minimal" },
    });

    const result = await migrateFromAuthJson("anthropic", store);

    expect(result).toBe(true);

    const storage = await store.load();
    const account = storage.accounts[0]!;

    expect(account.refreshToken).toBe("rt_minimal");
    expect(account.accessToken).toBeUndefined();
    expect(account.expiresAt).toBeUndefined();
  });
});
