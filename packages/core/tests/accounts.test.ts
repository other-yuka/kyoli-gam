import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryAccountStore,
  SQLiteAccountStore,
  SQLiteRequestLogStore,
  SQLiteStickySessionStore,
  createAccountRefreshUpdate,
} from "../src";

describe("AccountStore state reset", () => {
  it("merges credential and metadata patches into the latest SQLite account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyoli-account-patch-"));

    try {
      const store = new SQLiteAccountStore(join(dir, "kyoli.db"));
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
        credentials: { accessToken: "old-access", refreshToken: "keep-refresh" },
        metadata: { cachedUsageAt: 200, source: "usage-refresh" },
      });

      const updated = await store.update(account.id, {
        credentialsPatch: { accessToken: "fresh-access" },
        metadataPatch: { email: "fresh@example.test" },
      });

      expect(updated?.credentials).toEqual({
        accessToken: "fresh-access",
        refreshToken: "keep-refresh",
      });
      expect(updated?.metadata).toEqual({
        cachedUsageAt: 200,
        source: "usage-refresh",
        email: "fresh@example.test",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a stale refresh result after credentials are replaced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyoli-account-refresh-cas-"));

    try {
      const store = new SQLiteAccountStore(join(dir, "kyoli.db"));
      const stale = await store.create({
        provider: "codex",
        kind: "oauth",
        credentials: {
          accessToken: "generation-a-access",
          refreshToken: "generation-a-refresh",
          accountId: "generation-a-account",
        },
        metadata: { owner: "initial" },
      });
      await store.update(stale.id, {
        credentials: {
          accessToken: "generation-b-access",
          refreshToken: "generation-b-refresh",
          accountId: "generation-b-account",
        },
        metadataPatch: { owner: "reauthenticated" },
      });

      const updated = await store.update(stale.id, createAccountRefreshUpdate(stale, {
        credentials: {
          ...stale.credentials,
          accessToken: "generation-a-refreshed-access",
        },
        metadata: {
          ...stale.metadata,
          cachedUsageAt: 123,
        },
      }));

      expect(updated).toBeUndefined();
      await expect(store.get(stale.id)).resolves.toMatchObject({
        credentials: {
          accessToken: "generation-b-access",
          refreshToken: "generation-b-refresh",
          accountId: "generation-b-account",
        },
        metadata: { owner: "reauthenticated" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an idempotent refresh after the same credentials were already persisted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyoli-account-refresh-idempotent-"));

    try {
      const store = new SQLiteAccountStore(join(dir, "kyoli.db"));
      const account = await store.create({
        provider: "codex",
        kind: "oauth",
        credentials: {
          accessToken: "generation-a-access",
          refreshToken: "generation-a-refresh",
        },
        metadata: { owner: "initial" },
      });
      const refreshUpdate = createAccountRefreshUpdate(account, {
        credentials: {
          ...account.credentials,
          accessToken: "generation-a-refreshed-access",
          refreshToken: "generation-a-refreshed-refresh",
          accountId: undefined,
        },
        metadata: {
          ...account.metadata,
          cachedUsageAt: 123,
        },
      });
      await store.update(account.id, {
        credentials: refreshUpdate.refreshedCredentials,
      });

      const updated = await store.update(account.id, refreshUpdate);

      expect(updated).toMatchObject({
        credentials: {
          accessToken: "generation-a-refreshed-access",
          refreshToken: "generation-a-refreshed-refresh",
        },
        metadata: {
          owner: "initial",
          cachedUsageAt: 123,
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces refresh CAS in memory and keeps the expected snapshot immutable", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "generation-a-access",
        refreshToken: "generation-a-refresh",
      },
      metadata: { owner: "generation-a" },
    });
    const refreshUpdate = createAccountRefreshUpdate(account, {
      credentials: {
        ...account.credentials,
        accessToken: "generation-a-refreshed-access",
      },
      metadata: {
        ...account.metadata,
        cachedUsageAt: 123,
      },
    });

    account.credentials.accessToken = "mutated-out-of-band";

    await expect(store.update(account.id, refreshUpdate)).resolves.toBeUndefined();
  });

  it("puts transient 401/403 failures into auth cooldown without disabling the account", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: { accessToken: "secret" },
    });

    const first = await store.recordFailure(account.id, {
      status: 401,
      message: "upstream auth rejected",
    });

    expect(first).toMatchObject({
      enabled: true,
      failureCount: 1,
      consecutiveAuthFailures: 1,
      reauthRequiredReason: undefined,
    });
    expect(first?.authCooldownUntil).toBeDefined();
    expect(new Date(first!.authCooldownUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  it("clears transient failure state without changing credentials", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      enabled: false,
      credentials: { accessToken: "secret" },
    });
    await store.recordFailure(account.id, {
      status: 401,
      message: "bad token",
      reauthRequiredReason: "bad token",
    });

    const reset = await store.resetState(account.id, { enable: true });

    expect(reset).toMatchObject({
      enabled: true,
      failureCount: 0,
      credentials: { accessToken: "secret" },
    });
    expect(reset?.lastErrorAt).toBeUndefined();
    expect(reset?.rateLimitResetAt).toBeUndefined();
    expect(reset?.authCooldownUntil).toBeUndefined();
    expect(reset?.consecutiveAuthFailures).toBe(0);
    expect(reset?.reauthRequiredReason).toBeUndefined();
  });

  it("records transport success without clearing rate-limit state", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: { accessToken: "secret" },
    });
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    await store.recordFailure(account.id, {
      status: 429,
      message: "usage limit",
      rateLimitResetAt: resetAt,
      failureClass: "rate_limit",
      failureCode: "usage_limit_reached",
      failurePhase: "startup",
    });

    const updated = await store.recordSuccess(account.id, { kind: "transport" });

    expect(updated?.lastUsedAt).toBeDefined();
    expect(updated?.failureCount).toBe(1);
    expect(updated?.rateLimitResetAt).toBe(resetAt);
    expect(updated?.rateLimitBlockedAt).toBeDefined();
    expect(updated?.rateLimitCooldownUntil).toBe(resetAt);
    expect(updated?.lastFailureCode).toBe("usage_limit_reached");
  });

  it("still supports explicit reauth-required failures", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: { accessToken: "secret" },
    });

    const updated = await store.recordFailure(account.id, {
      status: 401,
      message: "refresh failed",
      reauthRequiredReason: "refresh failed",
    });

    expect(updated).toMatchObject({
      enabled: false,
      reauthRequiredReason: "refresh failed",
      authCooldownUntil: undefined,
      consecutiveAuthFailures: 1,
    });
  });

  it("preserves the original reauth failure details across later generic 401s", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: { accessToken: "secret" },
    });

    await store.recordFailure(account.id, {
      status: 400,
      message: "invalid_grant: refresh token expired",
      failureClass: "auth",
      failureCode: "invalid_grant",
      reauthRequiredReason: "Codex OAuth token refresh failed",
    });

    const updated = await store.recordFailure(account.id, {
      status: 401,
      message: "Codex compact upstream returned 401",
    });

    expect(updated).toMatchObject({
      enabled: false,
      failureCount: 2,
      reauthRequiredReason: "Codex OAuth token refresh failed",
      lastFailureClass: "auth",
      lastFailureCode: "invalid_grant",
      lastFailureMessage: "invalid_grant: refresh token expired",
    });
  });
});

describe("SQLiteRequestLogStore", () => {
  it("persists and filters request logs", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyoli-request-log-"));
    const dbPath = join(dir, "kyoli.db");

    try {
      const store = new SQLiteRequestLogStore(dbPath);
      store.createRequestLog({
        provider: "codex",
        route: "/v1/responses",
        model: "gpt-5.3-codex",
        sessionKey: "session-a",
        accountId: "account-a",
        eventType: "response",
        attempt: 1,
        status: 200,
        retryable: false,
      });
      store.createRequestLog({
        provider: "codex",
        route: "/v1/responses",
        model: "gpt-5.3-codex",
        sessionKey: "session-b",
        accountId: "account-b",
        eventType: "response",
        attempt: 1,
        status: 429,
        retryable: true,
      });

      expect(store.listRequestLogs({ status: 429 })).toEqual([
        expect.objectContaining({
          accountId: "account-b",
          status: 429,
          retryable: true,
        }),
      ]);
      expect(new SQLiteRequestLogStore(dbPath).listRequestLogs({ accountId: "account-a" })).toEqual([
        expect.objectContaining({
          accountId: "account-a",
          status: 200,
        }),
      ]);
      expect(store.clearRequestLogs()).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SQLiteStickySessionStore", () => {
  it("persists sticky mappings across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyoli-sticky-"));
    const dbPath = join(dir, "kyoli.db");

    try {
      const first = new SQLiteStickySessionStore(dbPath);
      first.upsertStickySession({
        key: "codex:oauth:session-a",
        provider: "codex",
        kind: "oauth",
        sessionKey: "session-a",
        accountId: "account-a",
      });

      const second = new SQLiteStickySessionStore(dbPath);
      expect(second.getStickySession("codex:oauth:session-a")).toMatchObject({
        key: "codex:oauth:session-a",
        provider: "codex",
        kind: "oauth",
        sessionKey: "session-a",
        accountId: "account-a",
      });

      second.upsertStickySession({
        key: "codex:oauth:session-a",
        provider: "codex",
        kind: "oauth",
        sessionKey: "session-a",
        accountId: "account-b",
      });
      expect(first.getStickySession("codex:oauth:session-a")?.accountId).toBe("account-b");
      expect(second.clearStickySessions()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("purges stale sticky mappings by age", () => {
    const dir = mkdtempSync(join(tmpdir(), "kyoli-sticky-"));
    const dbPath = join(dir, "kyoli.db");

    try {
      const store = new SQLiteStickySessionStore(dbPath);
      store.upsertStickySession({
        key: "codex:oauth:session-a",
        provider: "codex",
        kind: "oauth",
        sessionKey: "session-a",
        accountId: "account-a",
      });

      expect(store.purgeStickySessions({ maxAgeSeconds: 0 })).toBe(1);
      expect(store.listStickySessions()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
