import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { syncBootstrapAuth, __bootstrapAuthTestUtils } from "../../src/oauth/bootstrap";
import { AccountStore } from "../../src/accounts/store";
import { setupTestEnv, createMockClient } from "../helpers";

describe("bootstrap-auth", () => {
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

  test("syncs active stored account when auth.json is missing", async () => {
    const now = Date.now();
    const client = createMockClient();
    const authSetSpy = vi.spyOn(client.auth, "set");

    await store.addAccount({
      uuid: "active-account",
      refreshToken: "refresh-1",
      accessToken: "access-1",
      expiresAt: now + 60_000,
      addedAt: now,
      lastUsed: now,
      enabled: true,
      planTier: "",
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
    });
    await store.setActiveUuid("active-account");

    const synced = await syncBootstrapAuth(client, store);

    expect(synced).toBe(true);
    expect(authSetSpy).toHaveBeenCalledWith({
      path: { id: "anthropic" },
      body: {
        type: "oauth",
        refresh: "refresh-1",
        access: "access-1",
        expires: now + 60_000,
      },
    });
  });

  test("does not sync when storage has no complete oauth account", async () => {
    const now = Date.now();
    const client = createMockClient();
    const authSetSpy = vi.spyOn(client.auth, "set");

    await store.addAccount({
      uuid: "incomplete-account",
      refreshToken: "refresh-only",
      addedAt: now,
      lastUsed: now,
      enabled: true,
      planTier: "",
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
    });

    const synced = await syncBootstrapAuth(client, store);

    expect(synced).toBe(false);
    expect(authSetSpy).not.toHaveBeenCalled();
  });

  test("does not overwrite newer auth.json credentials", async () => {
    const now = Date.now();
    const client = createMockClient();
    const authSetSpy = vi.spyOn(client.auth, "set");

    await fs.writeFile(join(dir, "auth.json"), JSON.stringify({
      anthropic: {
        type: "oauth",
        refresh: "refresh-newer",
        access: "access-newer",
        expires: now + 120_000,
      },
    }), "utf-8");

    await store.addAccount({
      uuid: "older-account",
      refreshToken: "refresh-older",
      accessToken: "access-older",
      expiresAt: now + 60_000,
      addedAt: now,
      lastUsed: now,
      enabled: true,
      planTier: "",
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
    });

    const synced = await syncBootstrapAuth(client, store);

    expect(synced).toBe(false);
    expect(authSetSpy).not.toHaveBeenCalled();
  });

  test("prefers active account over another usable account", () => {
    const selected = __bootstrapAuthTestUtils.selectBootstrapAccount(
      [
        {
          uuid: "other",
          refreshToken: "refresh-other",
          accessToken: "access-other",
          expiresAt: 100,
          addedAt: 1,
          lastUsed: 1,
          enabled: true,
          planTier: "",
          consecutiveAuthFailures: 0,
          isAuthDisabled: false,
        },
        {
          uuid: "active",
          refreshToken: "refresh-active",
          accessToken: "access-active",
          expiresAt: 200,
          addedAt: 1,
          lastUsed: 1,
          enabled: true,
          planTier: "",
          consecutiveAuthFailures: 0,
          isAuthDisabled: false,
        },
      ],
      "active",
    );

    expect(selected?.uuid).toBe("active");
  });
});
