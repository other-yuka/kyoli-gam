import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryAccountStore,
  SQLiteAccountStore,
  SQLiteRequestLogStore,
  SQLiteStickySessionStore,
  captureRateLimitRevision,
  createAccountRefreshUpdate,
} from "../src";
import { Database } from "../src/sqlite";

describe("AccountStore state reset", () => {
  it.each(["memory", "sqlite"] as const)(
    "invalidates rate-limit snapshots when a raw credential patch changes tokens in the %s store",
    async (kind) => {
      const dir = kind === "sqlite" ? mkdtempSync(join(tmpdir(), "kyoli-account-patch-")) : undefined;

      try {
        const store = kind === "sqlite"
          ? new SQLiteAccountStore(join(dir!, "kyoli.db"))
          : new MemoryAccountStore();
        const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const account = await store.create({
          provider: "claude-code",
          kind: "oauth",
          credentials: { accessToken: "old-access", refreshToken: "keep-refresh" },
          metadata: {
            cachedUsage: {
              format: "percent-v1",
              five_hour: { utilization: 100, resets_at: resetAt },
            },
            cachedUsageAt: 200,
            source: "usage-refresh",
          },
        });
        const blocked = await store.recordFailure(account.id, {
          status: 429,
          message: "rate limited",
          rateLimitResetAt: resetAt,
          rateLimitCooldownUntil: resetAt,
        });
        if (!blocked?.rateLimitObservedAt) throw new Error("Expected a rate-limit revision");

        const updated = await store.update(account.id, {
          credentialsPatch: { accessToken: "fresh-access" },
          metadataPatch: { email: "fresh@example.test" },
        });

        expect(updated?.credentials).toEqual({
          accessToken: "fresh-access",
          refreshToken: "keep-refresh",
        });
        expect(updated?.metadata).toEqual({
          source: "usage-refresh",
          email: "fresh@example.test",
        });
        expect(updated?.rateLimitResetAt).toBeUndefined();
        expect(updated?.rateLimitBlockedAt).toBeUndefined();
        expect(updated?.rateLimitCooldownUntil).toBeUndefined();
        expect(updated?.rateLimitObservedAt).toBeGreaterThan(blocked.rateLimitObservedAt);
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("sanitizes a pre-upgrade ambiguous Claude usage snapshot when SQLite reloads it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyoli-legacy-claude-reload-"));

    try {
      const databasePath = join(dir, "kyoli.db");
      const store = new SQLiteAccountStore(databasePath);
      const account = await store.create({ provider: "claude-code", kind: "oauth" });
      const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const legacyMetadata = {
        planTier: "max",
        cachedUsage: {
          five_hour: { utilization: 1, resets_at: resetAt },
          seven_day: { utilization: 0.92, resets_at: resetAt },
          seven_day_sonnet: { utilization: 1.04, resets_at: resetAt },
        },
        cachedUsageAt: Date.now(),
        rateLimitClaim: "five_hour",
        rateLimitStatus: "rejected",
      };
      const database = new Database(databasePath);
      database
        .query("update accounts set metadata_json = ? where id = ?")
        .run(JSON.stringify(legacyMetadata), account.id);
      database.close();

      const reloaded = await new SQLiteAccountStore(databasePath).get(account.id);

      expect(reloaded?.metadata).toEqual({
        planTier: "max",
        rateLimitClaim: "five_hour",
        rateLimitStatus: "rejected",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["memory", "sqlite"] as const)(
    "discards ambiguous legacy Claude header usage without clearing rate-limit state in the %s store",
    async (kind) => {
      const dir = kind === "sqlite" ? mkdtempSync(join(tmpdir(), "kyoli-legacy-claude-usage-")) : undefined;

      try {
        const databasePath = dir ? join(dir, "kyoli.db") : undefined;
        const store = kind === "sqlite"
          ? new SQLiteAccountStore(databasePath!)
          : new MemoryAccountStore();
        const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const cooldownUntil = new Date(Date.now() + 60_000).toISOString();
        const account = await store.create({
          provider: "claude-code",
          kind: "oauth",
          metadata: {
            cachedUsage: {
              format: "percent-v1",
              five_hour: { utilization: 20, resets_at: null },
            },
            cachedUsageAt: Date.now() - 1,
          },
        });

        const blocked = await store.recordFailure(account.id, {
          status: 429,
          message: "legacy rate limit",
          failureClass: "quota",
          rateLimitResetAt: resetAt,
          rateLimitCooldownUntil: cooldownUntil,
          metadata: {
            cachedUsage: {
              five_hour: { utilization: 1, resets_at: resetAt },
              seven_day: { utilization: 0.92, resets_at: resetAt },
              seven_day_sonnet: { utilization: 1.04, resets_at: resetAt },
            },
            cachedUsageAt: Date.now(),
            rateLimitClaim: "five_hour",
            rateLimitStatus: "rejected",
          },
        });

        expect(blocked?.metadata).toMatchObject({
          rateLimitClaim: "five_hour",
          rateLimitStatus: "rejected",
        });
        expect(blocked?.metadata.cachedUsage).toBeUndefined();
        expect(blocked?.metadata.cachedUsageAt).toBeUndefined();
        expect(blocked?.rateLimitResetAt).toBe(resetAt);
        expect(blocked?.rateLimitCooldownUntil).toBe(cooldownUntil);

        if (databasePath) {
          const reloaded = new SQLiteAccountStore(databasePath);
          const persisted = await reloaded.get(account.id);
          expect(persisted?.metadata.cachedUsage).toBeUndefined();
          expect(persisted?.metadata.cachedUsageAt).toBeUndefined();
          expect(persisted?.rateLimitResetAt).toBe(resetAt);
          expect(persisted?.rateLimitCooldownUntil).toBe(cooldownUntil);
        }
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["memory", "sqlite"] as const)(
    "preserves unambiguous legacy Claude OAuth percentages without rescaling them in the %s store",
    async (kind) => {
      const dir = kind === "sqlite" ? mkdtempSync(join(tmpdir(), "kyoli-legacy-claude-oauth-")) : undefined;

      try {
        const store = kind === "sqlite"
          ? new SQLiteAccountStore(join(dir!, "kyoli.db"))
          : new MemoryAccountStore();
        const cachedUsage = {
          five_hour: { utilization: 1, resets_at: null },
          seven_day: { utilization: 0.5, resets_at: null },
        };

        const account = await store.create({
          provider: "claude-code",
          kind: "oauth",
          metadata: { cachedUsage, cachedUsageAt: 123 },
        });

        expect(account.metadata.cachedUsage).toEqual(cachedUsage);
        expect(account.metadata.cachedUsageAt).toBe(123);
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["memory", "sqlite"] as const)(
    "preserves rate-limit state while a managed token refresh invalidates old requests in the %s store",
    async (kind) => {
      const dir = kind === "sqlite" ? mkdtempSync(join(tmpdir(), "kyoli-account-refresh-")) : undefined;

      try {
        const store = kind === "sqlite"
          ? new SQLiteAccountStore(join(dir!, "kyoli.db"))
          : new MemoryAccountStore();
        const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const usageObservedAt = Date.now();
        const cachedUsage = {
          five_hour: { utilization: 20, resets_at: resetAt },
        };
        const account = await store.create({
          provider: "codex",
          kind: "oauth",
          credentials: { accessToken: "old-access", refreshToken: "old-refresh" },
          metadata: { cachedUsage, cachedUsageAt: usageObservedAt },
        });
        const blocked = await store.recordFailure(account.id, {
          status: 429,
          message: "rate limited",
          rateLimitResetAt: resetAt,
          rateLimitCooldownUntil: resetAt,
        });
        if (!blocked?.rateLimitObservedAt) throw new Error("Expected a rate-limit revision");

        const refreshedCredentials = {
          ...blocked.credentials,
          accessToken: "fresh-access",
          refreshToken: "fresh-refresh",
        };
        const credentialRefresh = createAccountRefreshUpdate(blocked, {
          credentials: refreshedCredentials,
        });
        const staleUsage = createAccountRefreshUpdate(blocked, {
          credentials: refreshedCredentials,
          metadata: {
            ...blocked.metadata,
            cachedUsage: {
              five_hour: { utilization: 100, resets_at: resetAt },
            },
            cachedUsageAt: usageObservedAt + 1,
          },
        }, {
          usageObservedAt: usageObservedAt + 1,
          recoverRateLimitState: true,
        });

        const refreshed = await store.update(account.id, credentialRefresh);

        expect(refreshed?.credentials).toMatchObject({
          accessToken: "fresh-access",
          refreshToken: "fresh-refresh",
        });
        expect(refreshed?.metadata.cachedUsage).toEqual(cachedUsage);
        expect(refreshed?.rateLimitResetAt).toBe(resetAt);
        expect(refreshed?.rateLimitCooldownUntil).toBe(resetAt);
        expect(refreshed?.rateLimitObservedAt).toBeGreaterThan(blocked.rateLimitObservedAt);

        await store.update(account.id, staleUsage);
        await store.recordSuccess(account.id, {
          kind: "request",
          expectedRateLimitRevision: captureRateLimitRevision(blocked),
        });

        const persisted = await store.get(account.id);
        expect(persisted?.metadata.cachedUsage).toEqual(cachedUsage);
        expect(persisted?.rateLimitResetAt).toBe(resetAt);
        expect(persisted?.rateLimitCooldownUntil).toBe(resetAt);
        expect(persisted?.rateLimitObservedAt).toBe(refreshed?.rateLimitObservedAt);
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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

  it("keeps rate-limit state when only credential metadata is corrected", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access",
        refreshToken: "refresh",
        accountId: "old-account-id",
      },
      metadata: {
        cachedUsage: {
          five_hour: {
            utilization: 100,
            resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        },
      },
    });
    const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const blocked = await store.recordFailure(account.id, {
      status: 429,
      message: "rate limited",
      rateLimitResetAt: resetAt,
    });

    const corrected = await store.update(account.id, {
      credentialsPatch: { accountId: "corrected-account-id" },
    });

    expect(corrected?.credentials.accountId).toBe("corrected-account-id");
    expect(corrected?.metadata.cachedUsage).toEqual(account.metadata.cachedUsage);
    expect(corrected?.rateLimitResetAt).toBe(resetAt);
    expect(corrected?.rateLimitObservedAt).toBe(blocked?.rateLimitObservedAt);
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

  it("persists rate-limit response metadata with SQLite failure state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyoli-account-rate-metadata-"));

    try {
      const databasePath = join(dir, "kyoli.db");
      const store = new SQLiteAccountStore(databasePath);
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
        metadata: { planTier: "max" },
      });
      const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const cooldownUntil = new Date(Date.now() + 60_000).toISOString();
      const cachedUsageAt = Date.now();
      await store.recordFailure(account.id, {
        status: 429,
        message: "rate limited",
        failureClass: "rate_limit",
        failureCode: "rate_limit",
        failurePhase: "startup",
        rateLimitResetAt: resetAt,
        rateLimitCooldownUntil: cooldownUntil,
        metadata: {
          cachedUsage: {
            format: "percent-v1",
            five_hour: { utilization: 100, resets_at: resetAt },
          },
          cachedUsageAt,
          rateLimitClaim: "five_hour",
          rateLimitStatus: "rejected",
        },
      });

      const reloaded = new SQLiteAccountStore(databasePath);
      await expect(reloaded.get(account.id)).resolves.toMatchObject({
        metadata: {
          planTier: "max",
          cachedUsage: {
            five_hour: { utilization: 100, resets_at: resetAt },
          },
          cachedUsageAt,
          rateLimitClaim: "five_hour",
          rateLimitStatus: "rejected",
        },
        rateLimitResetAt: resetAt,
        rateLimitCooldownUntil: cooldownUntil,
        rateLimitObservedAt: expect.any(Number),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists usage-based rate-limit recovery through SQLite updates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyoli-account-rate-recovery-"));

    try {
      const databasePath = join(dir, "kyoli.db");
      const store = new SQLiteAccountStore(databasePath);
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
        metadata: { planTier: "max" },
      });
      const blocked = await store.recordFailure(account.id, {
        status: 429,
        message: "rate limited",
        failureClass: "rate_limit",
        rateLimitResetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        rateLimitCooldownUntil: new Date(Date.now() - 1).toISOString(),
      });
      const usageObservedAt = Date.now();
      const refreshed = {
        metadata: {
          ...blocked!.metadata,
          cachedUsageAt: usageObservedAt,
          cachedUsage: {
            five_hour: { utilization: 20, resets_at: null },
            seven_day: { utilization: 30, resets_at: null },
          },
        },
      };

      const updated = await store.update(account.id, createAccountRefreshUpdate(blocked!, refreshed, {
        usageObservedAt,
        recoverRateLimitState: true,
      }));

      expect(updated).toMatchObject({
        failureCount: 0,
        metadata: refreshed.metadata,
      });
      expect(updated?.rateLimitResetAt).toBeUndefined();
      expect(updated?.rateLimitObservedAt).toBeGreaterThan(blocked?.rateLimitObservedAt ?? 0);

      const reloaded = new SQLiteAccountStore(databasePath);
      const persisted = await reloaded.get(account.id);
      expect(persisted).toMatchObject({
        failureCount: 0,
        metadata: refreshed.metadata,
      });
      expect(persisted?.rateLimitResetAt).toBeUndefined();
      expect(persisted?.rateLimitBlockedAt).toBeUndefined();
      expect(persisted?.rateLimitCooldownUntil).toBeUndefined();
      expect(persisted?.rateLimitObservedAt).toBe(updated?.rateLimitObservedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(reset?.rateLimitObservedAt).toEqual(expect.any(Number));
    expect(reset?.authCooldownUntil).toBeUndefined();
    expect(reset?.consecutiveAuthFailures).toBe(0);
    expect(reset?.reauthRequiredReason).toBeUndefined();
  });

  it("keeps the rate observation token across reset to reject an older usage snapshot", async () => {
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const store = new MemoryAccountStore();
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
        metadata: { planTier: "max" },
      });
      const staleUpdate = createAccountRefreshUpdate(account, {
        metadata: {
          ...account.metadata,
          cachedUsageAt: now,
          cachedUsage: {
            five_hour: { utilization: 100, resets_at: new Date(now + 60 * 60 * 1000).toISOString() },
          },
        },
      }, {
        usageObservedAt: now,
        recoverRateLimitState: true,
      });

      await store.recordFailure(account.id, {
        status: 429,
        message: "rate limited",
        failureClass: "rate_limit",
        rateLimitCooldownUntil: new Date(now + 60_000).toISOString(),
      });
      await store.resetState(account.id);
      await store.update(account.id, staleUpdate);

      await expect(store.get(account.id)).resolves.toMatchObject({
        failureCount: 0,
        metadata: { planTier: "max" },
        rateLimitObservedAt: now + 1,
      });
      expect((await store.get(account.id))?.metadata.cachedUsage).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["memory", "sqlite"] as const)(
    "rejects usage captured before request success in the %s store",
    async (kind) => {
      const now = new Date("2026-09-11T00:00:00.000Z").getTime();
      const dir = kind === "sqlite" ? mkdtempSync(join(tmpdir(), "kyoli-account-success-aba-")) : undefined;
      vi.useFakeTimers();
      vi.setSystemTime(now);

      try {
        const store = kind === "sqlite"
          ? new SQLiteAccountStore(join(dir!, "kyoli.db"))
          : new MemoryAccountStore();
        const account = await store.create({
          provider: "claude-code",
          kind: "oauth",
          credentials: { accessToken: "secret" },
          metadata: { planTier: "max" },
        });
        const blocked = await store.recordFailure(account.id, {
          status: 429,
          message: "rate limited",
          failureClass: "rate_limit",
          rateLimitResetAt: new Date(now + 60 * 60 * 1000).toISOString(),
          rateLimitCooldownUntil: new Date(now + 60_000).toISOString(),
        });
        if (!blocked?.rateLimitObservedAt) throw new Error("Expected a rate-limit revision");

        const staleUsage = createAccountRefreshUpdate(blocked, {
          credentials: {
            ...blocked.credentials,
            accessToken: "refreshed-access",
          },
          metadata: {
            ...blocked.metadata,
            owner: "refreshed-profile",
            cachedUsageAt: now,
            cachedUsage: {
              five_hour: {
                utilization: 100,
                resets_at: new Date(now + 60 * 60 * 1000).toISOString(),
              },
            },
          },
        }, {
          usageObservedAt: now,
          recoverRateLimitState: true,
        });

        await store.recordSuccess(account.id, {
          kind: "request",
          expectedRateLimitRevision: captureRateLimitRevision(blocked),
        });
        await store.update(account.id, staleUsage);

        const recovered = await store.get(account.id);
        expect(recovered?.credentials.accessToken).toBe("refreshed-access");
        expect(recovered?.metadata.owner).toBe("refreshed-profile");
        expect(recovered?.metadata.cachedUsage).toBeUndefined();
        expect(recovered?.rateLimitResetAt).toBeUndefined();
        expect(recovered?.rateLimitCooldownUntil).toBeUndefined();
        expect(recovered?.rateLimitObservedAt).toBeGreaterThan(blocked.rateLimitObservedAt);
      } finally {
        vi.useRealTimers();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["memory", "sqlite"] as const)(
    "keeps reset authoritative over post-rate-limit usage in the %s store",
    async (kind) => {
      const now = new Date("2026-09-11T00:00:00.000Z").getTime();
      const dir = kind === "sqlite" ? mkdtempSync(join(tmpdir(), "kyoli-account-reset-aba-")) : undefined;
      vi.useFakeTimers();
      vi.setSystemTime(now);

      try {
        const store = kind === "sqlite"
          ? new SQLiteAccountStore(join(dir!, "kyoli.db"))
          : new MemoryAccountStore();
        const account = await store.create({
          provider: "codex",
          kind: "oauth",
          credentials: { accessToken: "secret" },
        });
        const blocked = await store.recordFailure(account.id, {
          status: 429,
          message: "rate limited",
          failureClass: "rate_limit",
          rateLimitCooldownUntil: new Date(now + 60_000).toISOString(),
        });
        if (!blocked?.rateLimitObservedAt) throw new Error("Expected a rate-limit revision");
        const staleUsage = createAccountRefreshUpdate(blocked, {
          metadata: {
            cachedUsageAt: now,
            cachedUsage: {
              five_hour: {
                utilization: 100,
                resets_at: new Date(now + 60 * 60 * 1000).toISOString(),
              },
            },
          },
        }, { usageObservedAt: now, recoverRateLimitState: true });

        await store.resetState(account.id);
        await store.update(account.id, staleUsage);

        const recovered = await store.get(account.id);
        expect(recovered?.metadata.cachedUsage).toBeUndefined();
        expect(recovered?.rateLimitResetAt).toBeUndefined();
        expect(recovered?.rateLimitBlockedAt).toBeUndefined();
        expect(recovered?.rateLimitCooldownUntil).toBeUndefined();
        expect(recovered?.rateLimitObservedAt).toBeGreaterThan(blocked.rateLimitObservedAt);
      } finally {
        vi.useRealTimers();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["memory", "sqlite"] as const)(
    "lets the first quota-boundary update win in the %s store",
    async (kind) => {
      const now = new Date("2026-09-11T00:00:00.000Z").getTime();
      const dir = kind === "sqlite" ? mkdtempSync(join(tmpdir(), "kyoli-account-usage-aba-")) : undefined;
      vi.useFakeTimers();
      vi.setSystemTime(now);

      try {
        const store = kind === "sqlite"
          ? new SQLiteAccountStore(join(dir!, "kyoli.db"))
          : new MemoryAccountStore();
        const account = await store.create({
          provider: "claude-code",
          kind: "oauth",
        });
        const blocked = await store.recordFailure(account.id, {
          status: 429,
          message: "rate limited",
          failureClass: "rate_limit",
          rateLimitResetAt: new Date(now + 60 * 60 * 1000).toISOString(),
          rateLimitCooldownUntil: new Date(now - 1).toISOString(),
        });
        if (!blocked?.rateLimitObservedAt) throw new Error("Expected a rate-limit revision");
        const availableUsage = {
          five_hour: { utilization: 20, resets_at: null },
        };
        const availableUpdate = createAccountRefreshUpdate(blocked, {
          metadata: { cachedUsageAt: now, cachedUsage: availableUsage },
        }, { usageObservedAt: now, recoverRateLimitState: true });
        const exhaustedUpdate = createAccountRefreshUpdate(blocked, {
          metadata: {
            cachedUsageAt: now + 1,
            cachedUsage: {
              five_hour: {
                utilization: 100,
                resets_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
              },
            },
          },
        }, { usageObservedAt: now + 1, recoverRateLimitState: true });

        await store.update(account.id, availableUpdate);
        await store.update(account.id, exhaustedUpdate);

        const recovered = await store.get(account.id);
        expect(recovered?.metadata.cachedUsage).toEqual(availableUsage);
        expect(recovered?.rateLimitResetAt).toBeUndefined();
        expect(recovered?.rateLimitCooldownUntil).toBeUndefined();
        expect(recovered?.rateLimitObservedAt).toBeGreaterThan(blocked.rateLimitObservedAt);
      } finally {
        vi.useRealTimers();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["memory", "sqlite"] as const)(
    "invalidates old-credential usage after replacement in the %s store",
    async (kind) => {
      const now = new Date("2026-09-11T00:00:00.000Z").getTime();
      const dir = kind === "sqlite" ? mkdtempSync(join(tmpdir(), "kyoli-account-credential-aba-")) : undefined;
      vi.useFakeTimers();
      vi.setSystemTime(now);

      try {
        const store = kind === "sqlite"
          ? new SQLiteAccountStore(join(dir!, "kyoli.db"))
          : new MemoryAccountStore();
        const account = await store.create({
          provider: "codex",
          kind: "oauth",
          credentials: {
            accessToken: "old-access",
            refreshToken: "old-refresh",
          },
        });
        const blocked = await store.recordFailure(account.id, {
          status: 429,
          message: "rate limited",
          failureClass: "rate_limit",
          rateLimitCooldownUntil: new Date(now + 60_000).toISOString(),
          metadata: {
            cachedUsageAt: now,
            cachedUsage: {
              five_hour: {
                utilization: 100,
                resets_at: new Date(now + 60 * 60 * 1000).toISOString(),
              },
            },
          },
        });
        if (!blocked?.rateLimitObservedAt) throw new Error("Expected a rate-limit revision");
        const staleUsage = createAccountRefreshUpdate(blocked, {
          metadata: {
            cachedUsageAt: now + 1,
            cachedUsage: {
              five_hour: {
                utilization: 100,
                resets_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
              },
            },
          },
        }, { usageObservedAt: now + 1, recoverRateLimitState: true });

        await store.update(account.id, {
          credentials: {
            accessToken: "new-access",
            refreshToken: "new-refresh",
          },
          metadataPatch: { owner: "replacement" },
        });
        await store.update(account.id, staleUsage);

        const replaced = await store.get(account.id);
        expect(replaced).toMatchObject({
          credentials: {
            accessToken: "new-access",
            refreshToken: "new-refresh",
          },
          metadata: { owner: "replacement" },
        });
        expect(replaced?.metadata.cachedUsage).toBeUndefined();
        expect(replaced?.rateLimitResetAt).toBeUndefined();
        expect(replaced?.rateLimitCooldownUntil).toBeUndefined();
        expect(replaced?.rateLimitObservedAt).toBeGreaterThan(blocked.rateLimitObservedAt);
      } finally {
        vi.useRealTimers();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("preserves a concurrent auth failure while usage recovers rate-limit state", async () => {
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const store = new MemoryAccountStore();
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
      });
      const blocked = await store.recordFailure(account.id, {
        status: 429,
        message: "rate limited",
        failureClass: "rate_limit",
        rateLimitResetAt: new Date(now + 60 * 60 * 1000).toISOString(),
        rateLimitCooldownUntil: new Date(now - 1).toISOString(),
      });
      if (!blocked) throw new Error("Expected blocked account");
      const availableUpdate = createAccountRefreshUpdate(blocked, {
        metadata: {
          cachedUsageAt: now,
          cachedUsage: { five_hour: { utilization: 20, resets_at: null } },
        },
      }, { usageObservedAt: now, recoverRateLimitState: true });

      await store.recordFailure(account.id, {
        status: 401,
        message: "concurrent auth failure",
        failureClass: "auth",
        failureCode: "invalid_token",
      });
      await store.update(account.id, availableUpdate);

      const recovered = await store.get(account.id);
      expect(recovered).toMatchObject({
        consecutiveAuthFailures: 1,
        lastFailureClass: "auth",
        lastFailureCode: "invalid_token",
        lastFailureMessage: "concurrent auth failure",
      });
      expect(recovered?.authCooldownUntil).toBeDefined();
      expect(recovered?.rateLimitResetAt).toBeUndefined();
      expect(recovered?.rateLimitBlockedAt).toBeUndefined();
      expect(recovered?.rateLimitCooldownUntil).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["memory", "sqlite"] as const)(
    "keeps healthy usage cached after request success in the %s store",
    async (kind) => {
      const dir = kind === "sqlite" ? mkdtempSync(join(tmpdir(), "kyoli-account-success-usage-")) : undefined;
      try {
        const store = kind === "sqlite"
          ? new SQLiteAccountStore(join(dir!, "kyoli.db"))
          : new MemoryAccountStore();
        const usage = {
          five_hour: {
            utilization: 25,
            resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        };
        const account = await store.create({
          provider: "claude-code",
          kind: "oauth",
          credentials: { accessToken: "token" },
          metadata: { cachedUsage: usage, cachedUsageAt: Date.now() },
        });

        const succeeded = await store.recordSuccess(account.id, {
          kind: "request",
          expectedRateLimitRevision: captureRateLimitRevision(account),
        });

        expect(succeeded?.metadata.cachedUsage).toEqual(usage);
        expect(succeeded?.metadata.cachedUsageAt).toBe(account.metadata.cachedUsageAt);
        expect(succeeded?.rateLimitObservedAt).toBe(account.rateLimitObservedAt);
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each(["memory", "sqlite"] as const)(
    "preserves legacy request-success recovery in the %s store",
    async (kind) => {
      const dir = kind === "sqlite" ? mkdtempSync(join(tmpdir(), "kyoli-account-legacy-success-")) : undefined;
      try {
        const store = kind === "sqlite"
          ? new SQLiteAccountStore(join(dir!, "kyoli.db"))
          : new MemoryAccountStore();
        const account = await store.create({ provider: "claude-code", kind: "oauth" });
        await store.recordFailure(account.id, {
          status: 429,
          message: "rate limited",
          failureClass: "rate_limit",
          rateLimitCooldownUntil: new Date(Date.now() + 60_000).toISOString(),
        });

        const recovered = await store.recordSuccess(account.id, { kind: "request" });

        expect(recovered?.failureCount).toBe(0);
        expect(recovered?.rateLimitBlockedAt).toBeUndefined();
        expect(recovered?.rateLimitCooldownUntil).toBeUndefined();
      } finally {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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
