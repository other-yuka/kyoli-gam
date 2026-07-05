import { describe, expect, it } from "vitest";
import { MemoryAccountStore } from "@kyoli-gam/core";
import { reconcileCodexOAuthAccount } from "../src/auth-reconcile";

describe("reconcileCodexOAuthAccount", () => {
  it("updates a targeted reauth-required codex account and preserves its row id", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      name: "Codex stale@example.test",
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 60_000,
        accountId: "chatgpt-account-1",
      },
      metadata: {
        source: "opencode-openai-multi-account",
        sourceUuid: "source-account-1",
        email: "stale@example.test",
        accountId: "chatgpt-account-1",
        planTier: "pro",
        cachedUsage: { five_hour: { utilization: 100 } },
        cachedUsageAt: 1_700_000_000_000,
      },
    });
    await store.recordFailure(account.id, {
      status: 401,
      message: "refresh failed",
      reauthRequiredReason: "Codex OAuth token refresh failed",
    });

    const result = await reconcileCodexOAuthAccount(store, createTokens(), {
      accountId: account.id,
    });

    expect(result).toMatchObject({
      action: "updated",
      matchedBy: "account",
      account: {
        id: account.id,
        enabled: true,
        failureCount: 0,
        consecutiveAuthFailures: 0,
        reauthRequiredReason: undefined,
      },
    });
    expect(result.account.credentials).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 2_000_000,
      accountId: "chatgpt-account-1",
    });
    expect(result.account.metadata).toMatchObject({
      source: "opencode-openai-multi-account",
      sourceUuid: "source-account-1",
      email: "stale@example.test",
      accountId: "chatgpt-account-1",
      planTier: "plus",
    });
    expect(result.account.metadata.cachedUsage).toBeUndefined();
    expect(result.account.metadata.cachedUsageAt).toBeUndefined();
    expect(await store.listByProvider("codex")).toHaveLength(1);
  });

  it("auto-upserts by ChatGPT account id without creating duplicates", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 1,
        accountId: "chatgpt-account-1",
      },
      metadata: {
        email: "stale@example.test",
        accountId: "chatgpt-account-1",
      },
    });

    const result = await reconcileCodexOAuthAccount(store, createTokens());

    expect(result.action).toBe("updated");
    expect(result.matchedBy).toBe("accountId");
    expect(result.account.id).toBe(account.id);
    expect(result.account.credentials.accessToken).toBe("new-access");
    expect(await store.listByProvider("codex")).toHaveLength(1);
  });

  it("does not re-enable a manually disabled account during auto-upsert", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      enabled: false,
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 1,
        accountId: "chatgpt-account-1",
      },
      metadata: {
        email: "stale@example.test",
        accountId: "chatgpt-account-1",
      },
    });

    const result = await reconcileCodexOAuthAccount(store, createTokens());

    expect(result.action).toBe("updated");
    expect(result.account.id).toBe(account.id);
    expect(result.account.enabled).toBe(false);
    expect(result.account.credentials.accessToken).toBe("new-access");
  });

  it("creates a new account when no existing identity matches", async () => {
    const store = new MemoryAccountStore();

    const result = await reconcileCodexOAuthAccount(store, createTokens());

    expect(result.action).toBe("created");
    expect(result.account).toMatchObject({
      provider: "codex",
      kind: "oauth",
      name: "Codex stale@example.test",
      enabled: true,
    });
    expect(result.account.credentials).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      accountId: "chatgpt-account-1",
    });
    expect(await store.listByProvider("codex")).toHaveLength(1);
  });

  it("rejects targeted reauth when OAuth identity conflicts with the stored account", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: { accountId: "stored-chatgpt-account" },
      metadata: { email: "stored@example.test", accountId: "stored-chatgpt-account" },
    });

    await expect(
      reconcileCodexOAuthAccount(store, createTokens(), { accountId: account.id }),
    ).rejects.toThrow("does not match stored account id");
  });

  it("requires an explicit account when auto-match finds duplicate emails", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      metadata: { email: "stale@example.test" },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      metadata: { email: "stale@example.test" },
    });

    await expect(reconcileCodexOAuthAccount(store, {
      ...createTokens(),
      accountId: undefined,
    })).rejects.toThrow("Multiple codex accounts match email stale@example.test");
  });
});

function createTokens() {
  return {
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: 2_000_000,
    accountId: "chatgpt-account-1",
    email: "stale@example.test",
    planTier: "plus",
  };
}
