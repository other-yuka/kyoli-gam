import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_CACHED_USAGE_FORMAT,
  MemoryAccountStore,
  SQLiteAccountStore,
} from "../src/accounts";
import { StickyAccountPool } from "../src/account-pool";
import { summarizeAccountStatus, listFailedAccounts } from "../src/account-status";
import { MemoryStickySessionStore } from "../src/sticky-sessions";

describe("StickyAccountPool", () => {
  it("keeps the same account for a sticky session", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "first",
    });
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "second",
    });

    const pool = new StickyAccountPool(store);
    const selectedA = await pool.select({
      provider: "claude-code",
      kind: "oauth",
      sessionKey: "session-a",
    });
    const selectedB = await pool.select({
      provider: "claude-code",
      kind: "oauth",
      sessionKey: "session-a",
    });

    expect(selectedA?.id).toBe(first.id);
    expect(selectedB?.id).toBe(first.id);
  });

  it.each(["sticky", "weighted"] as const)(
    "refreshes an active prompt-cache binding before stale purge with %s routing",
    async (strategy) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
      try {
        const store = new MemoryAccountStore();
        const stickyAccount = await store.create({
          provider: "codex",
          kind: "oauth",
          name: "sticky",
          metadata: {
            cachedUsage: {
              five_hour: { utilization: 50 },
            },
          },
        });
        if (strategy === "weighted") {
          await store.create({
            provider: "codex",
            kind: "oauth",
            name: "weighted-best",
            metadata: {
              cachedUsage: {
                five_hour: { utilization: 40 },
              },
            },
          });
        }

        const stickySessionStore = new MemoryStickySessionStore();
        const stickyKey = "codex:prompt_cache:prompt_cache:turn-a";
        stickySessionStore.upsertStickySession({
          key: stickyKey,
          provider: "codex",
          kind: "prompt_cache",
          sessionKey: "prompt_cache:turn-a",
          accountId: stickyAccount.id,
        });
        const pool = new StickyAccountPool(store, { strategy, stickySessionStore });

        vi.setSystemTime(new Date("2026-07-18T00:31:00.000Z"));
        const result = await pool.selectWithDiagnostics({
          provider: "codex",
          kind: "oauth",
          sessionKey: "prompt_cache:turn-a",
        });

        expect(result.account?.id).toBe(stickyAccount.id);
        expect(result.diagnostics.selectedReason).toBe(
          strategy === "sticky" ? "sticky_existing" : "weighted_sticky",
        );
        expect(stickySessionStore.getStickySession(stickyKey)).toMatchObject({
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:31:00.000Z",
        });
        expect(pool.purgeStickySessions({ maxAgeSeconds: 30 * 60, kind: "prompt_cache" })).toBe(0);
        expect(pool.listStickySessions()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("can share sticky mappings through an external sticky store", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "codex",
      kind: "oauth",
      name: "first",
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      name: "second",
    });
    const stickySessionStore = new MemoryStickySessionStore();
    const firstPool = new StickyAccountPool(store, { stickySessionStore });
    const secondPool = new StickyAccountPool(store, { stickySessionStore });

    await firstPool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
    });
    const selected = await secondPool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
    });

    expect(selected?.id).toBe(first.id);
    expect(secondPool.listStickySessions()).toHaveLength(1);
  });

  it("lists and deletes sticky session mappings", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      name: "first",
    });
    const pool = new StickyAccountPool(store);

    await pool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
    });
    const sessions = pool.listStickySessions();

    expect(sessions).toEqual([
      expect.objectContaining({
        key: "codex:oauth:session-a",
        provider: "codex",
        kind: "oauth",
        sessionKey: "session-a",
        accountId: account.id,
      }),
    ]);
    expect(pool.deleteStickySession(sessions[0]!.key)).toBe(true);
    expect(pool.listStickySessions()).toEqual([]);
  });

  it("clears sticky session mappings", async () => {
    const store = new MemoryAccountStore();
    await store.create({ provider: "codex", kind: "oauth", name: "first" });
    const pool = new StickyAccountPool(store);

    await pool.select({ provider: "codex", kind: "oauth", sessionKey: "session-a" });
    await pool.select({ provider: "codex", kind: "oauth", sessionKey: "session-b" });

    expect(pool.clearStickySessions()).toBe(2);
    expect(pool.listStickySessions()).toEqual([]);
  });

  it("rotates accounts with round-robin strategy", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({ provider: "codex", kind: "oauth", name: "first" });
    const second = await store.create({ provider: "codex", kind: "oauth", name: "second" });
    const pool = new StickyAccountPool(store, { strategy: "round-robin" });

    const selected = [];
    for (let index = 0; index < 3; index += 1) {
      selected.push(
        (await pool.select({
          provider: "codex",
          kind: "oauth",
          sessionKey: `session-${index}`,
        }))?.id,
      );
    }

    expect(selected).toEqual([first.id, second.id, first.id]);
  });

  it("explains soft-quota skips and selected usage", async () => {
    const store = new MemoryAccountStore();
    const high = await store.create({
      provider: "codex",
      kind: "oauth",
      name: "high",
      metadata: {
        planTier: "pro",
        cachedUsage: {
          five_hour: { utilization: 1 },
          seven_day: { utilization: 96 },
        },
      },
    });
    const low = await store.create({
      provider: "codex",
      kind: "oauth",
      name: "low",
      metadata: {
        planTier: "pro",
        cachedUsage: {
          five_hour: { utilization: 20 },
          seven_day: { utilization: 30 },
        },
      },
    });
    const pool = new StickyAccountPool(store, {
      strategy: "round-robin",
      softQuotaThresholdPercent: 95,
    });

    const result = await pool.selectWithDiagnostics({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
    });

    expect(result.account?.id).toBe(low.id);
    expect(result.diagnostics).toMatchObject({
      strategy: "round-robin",
      selectedReason: "round_robin",
      softQuotaThresholdPercent: 95,
      softQuotaSkippedAccountIds: [high.id],
      poolAccountIds: [low.id],
      selectedAccount: {
        id: low.id,
        planTier: "pro",
        usage: {
          five_hour: 20,
          seven_day: 30,
          max: 30,
        },
      },
    });
  });

  it("honors a preferred account when it is still eligible", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({ provider: "codex", kind: "oauth", name: "first" });
    const second = await store.create({ provider: "codex", kind: "oauth", name: "second" });
    const pool = new StickyAccountPool(store, { strategy: "round-robin" });

    const selected = await pool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "file:file_123",
      preferredAccountId: second.id,
    });

    expect(selected?.id).toBe(second.id);
    expect(pool.listStickySessions()).toEqual([
      expect.objectContaining({
        kind: "codex_session",
        sessionKey: "file:file_123",
        accountId: second.id,
      }),
    ]);
    expect(first.id).toBeTruthy();
  });

  it("recovers expired rate-limit state before selecting an account", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({ provider: "codex", kind: "oauth", name: "expired" });
    await store.recordFailure(account.id, {
      status: 429,
      message: "rate limited",
      rateLimitResetAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const pool = new StickyAccountPool(store);

    const selected = await pool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
    });
    const updated = await store.get(account.id);

    expect(selected?.id).toBe(account.id);
    expect(updated?.failureCount).toBe(0);
    expect(updated?.rateLimitResetAt).toBeUndefined();
    expect(updated?.lastErrorAt).toBeUndefined();
  });

  it("keeps an expired legacy reset blocked until every exhausted usage window resets", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.setSystemTime(now);

    try {
      const store = new MemoryAccountStore();
      const account = await store.create({ provider: "claude-code", kind: "oauth", name: "overlap" });
      await store.recordFailure(account.id, {
        status: 429,
        message: "rate limited",
        failureClass: "rate_limit",
        failureCode: "rate_limit",
        rateLimitResetAt: new Date(now + 60_000).toISOString(),
        metadata: {
          cachedUsageAt: now,
          cachedUsage: {
            format: CLAUDE_CODE_CACHED_USAGE_FORMAT,
            five_hour: {
              utilization: 100,
              resets_at: new Date(now + 120_000).toISOString(),
            },
          },
        },
      });
      const pool = new StickyAccountPool(store);

      vi.setSystemTime(now + 60_001);
      expect(await pool.select({
        provider: "claude-code",
        kind: "oauth",
        sessionKey: "before-usage-reset",
      })).toBeUndefined();
      const stillBlocked = await store.get(account.id);
      expect(stillBlocked?.rateLimitBlockedAt).toBeDefined();
      expect(stillBlocked?.metadata.cachedUsage).toBeDefined();

      vi.setSystemTime(now + 120_001);
      expect((await pool.select({
        provider: "claude-code",
        kind: "oauth",
        sessionKey: "after-usage-reset",
      }))?.id).toBe(account.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["memory", "sqlite"] as const)(
    "keeps an indeterminate canonical and legacy usage pair blocked in the %s store",
    async (kind) => {
      vi.useFakeTimers();
      const now = new Date("2026-09-11T00:00:00.000Z").getTime();
      vi.setSystemTime(now);
      const dir = kind === "sqlite" ? mkdtempSync(join(tmpdir(), "kyoli-account-usage-conflict-")) : undefined;

      try {
        const store = kind === "sqlite"
          ? new SQLiteAccountStore(join(dir!, "kyoli.db"))
          : new MemoryAccountStore();
        const account = await store.create({
          provider: "claude-code",
          kind: "oauth",
          name: "usage-conflict",
          metadata: {
            cachedUsage: {
              format: CLAUDE_CODE_CACHED_USAGE_FORMAT,
              five_hour: { utilization: 20, resets_at: null },
            },
            usageCachedAt: now,
            usage: {
              five_hour: {
                utilization: 100,
                resets_at: new Date(now + 120_000).toISOString(),
              },
            },
          },
        });
        await store.recordFailure(account.id, {
          status: 429,
          message: "rate limited",
          failureClass: "rate_limit",
          failureCode: "rate_limit",
          rateLimitCooldownUntil: new Date(now + 60_000).toISOString(),
        });
        const pool = new StickyAccountPool(store);

        vi.setSystemTime(now + 60_001);
        expect(await pool.select({
          provider: "claude-code",
          kind: "oauth",
          sessionKey: "before-legacy-reset",
        })).toBeUndefined();
        await expect(store.get(account.id)).resolves.toMatchObject({
          failureCount: 1,
          rateLimitBlockedAt: expect.any(String),
        });

        vi.setSystemTime(now + 120_001);
        expect((await pool.select({
          provider: "claude-code",
          kind: "oauth",
          sessionKey: "after-legacy-reset",
        }))?.id).toBe(account.id);
        await expect(store.get(account.id)).resolves.toMatchObject({
          failureCount: 0,
          rateLimitBlockedAt: undefined,
        });
      } finally {
        vi.useRealTimers();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("recovers a cooldown-only rate limit after its retry window expires", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.setSystemTime(now);

    try {
      const store = new MemoryAccountStore();
      const account = await store.create({ provider: "claude-code", kind: "oauth", name: "cooldown" });
      await store.recordFailure(account.id, {
        status: 429,
        message: "rate limited",
        failureClass: "rate_limit",
        failureCode: "rate_limit",
        rateLimitCooldownUntil: new Date(now + 60_000).toISOString(),
      });
      const pool = new StickyAccountPool(store);

      expect(await pool.select({
        provider: "claude-code",
        kind: "oauth",
        sessionKey: "during-cooldown",
      })).toBeUndefined();

      vi.setSystemTime(now + 60_001);
      const selected = await pool.select({
        provider: "claude-code",
        kind: "oauth",
        sessionKey: "after-cooldown",
      });
      const recovered = await store.get(account.id);

      expect(selected?.id).toBe(account.id);
      expect(recovered?.failureCount).toBe(0);
      expect(recovered?.rateLimitBlockedAt).toBeUndefined();
      expect(recovered?.rateLimitCooldownUntil).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an expired cooldown blocked while an exhausted usage window is active", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.setSystemTime(now);

    try {
      const store = new MemoryAccountStore();
      const account = await store.create({ provider: "claude-code", kind: "oauth", name: "quota" });
      await store.recordFailure(account.id, {
        status: 429,
        message: "rate limited",
        failureClass: "rate_limit",
        failureCode: "rate_limit",
        rateLimitCooldownUntil: new Date(now + 60_000).toISOString(),
        metadata: {
          cachedUsageAt: now,
          cachedUsage: {
            five_hour: {
              utilization: 100,
              resets_at: new Date(now + 120_000).toISOString(),
            },
          },
        },
      });
      const pool = new StickyAccountPool(store);

      vi.setSystemTime(now + 60_001);
      expect(await pool.select({
        provider: "claude-code",
        kind: "oauth",
        sessionKey: "before-quota-reset",
      })).toBeUndefined();

      vi.setSystemTime(now + 120_001);
      expect((await pool.select({
        provider: "claude-code",
        kind: "oauth",
        sessionKey: "after-quota-reset",
      }))?.id).toBe(account.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps active rate-limited accounts out of selection", async () => {
    const store = new MemoryAccountStore();
    const limited = await store.create({ provider: "codex", kind: "oauth", name: "limited" });
    await store.recordFailure(limited.id, {
      status: 429,
      message: "rate limited",
      rateLimitResetAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const ready = await store.create({ provider: "codex", kind: "oauth", name: "ready" });
    const pool = new StickyAccountPool(store);

    const selected = await pool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
    });

    expect(selected?.id).toBe(ready.id);
    expect((await store.get(limited.id))?.rateLimitResetAt).toBeDefined();
  });

  it("keeps unknown usage-limit blocks out of selection until fresh usage shows capacity", async () => {
    const store = new MemoryAccountStore();
    const limited = await store.create({ provider: "codex", kind: "oauth", name: "limited" });
    const blocked = await store.recordFailure(limited.id, {
      status: 429,
      message: "You've hit your usage limit. Upgrade to Plus to continue using Codex.",
      failureClass: "rate_limit",
      failureCode: "usage_limit_reached",
    });
    const ready = await store.create({ provider: "codex", kind: "oauth", name: "ready" });
    const pool = new StickyAccountPool(store);

    const selected = await pool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
    });

    expect(selected?.id).toBe(ready.id);
    expect(blocked?.rateLimitResetAt).toBeUndefined();
    expect((await store.get(limited.id))?.rateLimitBlockedAt).toBeDefined();

    await store.update(limited.id, {
      metadata: {
        cachedUsageAt: Date.now() + 1_000,
        cachedUsage: {
          five_hour: { utilization: "35" },
        },
      },
    });

    const recovered = await pool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-b",
      preferredAccountId: limited.id,
    });

    expect(recovered?.id).toBe(limited.id);
    expect((await store.get(limited.id))?.rateLimitBlockedAt).toBeUndefined();
  });

  it("honors a provider retry cooldown despite fresher available usage", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.setSystemTime(now);

    try {
      const store = new MemoryAccountStore();
      const limited = await store.create({ provider: "claude-code", kind: "oauth", name: "limited" });
      const cooldownUntil = new Date(now + 60_000).toISOString();
      await store.recordFailure(limited.id, {
        status: 429,
        message: "rate limited",
        failureClass: "rate_limit",
        failureCode: "rate_limit",
        failurePhase: "startup",
        rateLimitCooldownUntil: cooldownUntil,
      });
      const ready = await store.create({ provider: "claude-code", kind: "oauth", name: "ready" });
      await store.update(limited.id, {
        metadata: {
          cachedUsageAt: now + 1,
          cachedUsage: {
            five_hour: { utilization: 10, resets_at: null },
          },
        },
      });
      const pool = new StickyAccountPool(store);

      const duringCooldown = await pool.select({
        provider: "claude-code",
        kind: "oauth",
        sessionKey: "during-provider-cooldown",
        preferredAccountId: limited.id,
      });

      expect(duringCooldown?.id).toBe(ready.id);
      expect(await store.get(limited.id)).toMatchObject({
        rateLimitBlockedAt: expect.any(String),
        rateLimitCooldownUntil: cooldownUntil,
      });

      vi.setSystemTime(now + 60_001);
      const afterCooldown = await pool.select({
        provider: "claude-code",
        kind: "oauth",
        sessionKey: "after-provider-cooldown",
        preferredAccountId: limited.id,
      });

      expect(afterCooldown?.id).toBe(limited.id);
      expect((await store.get(limited.id))?.rateLimitBlockedAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recover unknown usage-limit blocks from blank utilization strings", async () => {
    const store = new MemoryAccountStore();
    const limited = await store.create({ provider: "codex", kind: "oauth", name: "limited" });
    await store.recordFailure(limited.id, {
      status: 429,
      message: "You've hit your usage limit. Upgrade to Plus to continue using Codex.",
      failureClass: "rate_limit",
      failureCode: "usage_limit_reached",
    });
    const ready = await store.create({ provider: "codex", kind: "oauth", name: "ready" });
    await store.update(limited.id, {
      metadata: {
        cachedUsageAt: Date.now() + 1_000,
        cachedUsage: {
          five_hour: { utilization: "" },
        },
      },
    });
    const pool = new StickyAccountPool(store);

    const selected = await pool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
      preferredAccountId: limited.id,
    });

    expect(selected?.id).toBe(ready.id);
    expect((await store.get(limited.id))?.rateLimitBlockedAt).toBeDefined();
  });

  it("keeps a fresh exhausted usage window blocked until its reset", async () => {
    const store = new MemoryAccountStore();
    const limited = await store.create({ provider: "codex", kind: "oauth", name: "limited" });
    await store.recordFailure(limited.id, {
      status: 429,
      message: "rate limited",
      failureClass: "rate_limit",
      failureCode: "rate_limit",
      failurePhase: "startup",
    });
    const ready = await store.create({ provider: "codex", kind: "oauth", name: "ready" });
    await store.update(limited.id, {
      metadata: {
        cachedUsageAt: Date.now() + 1_000,
        cachedUsage: {
          five_hour: {
            utilization: 100,
            resets_at: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      },
    });
    const pool = new StickyAccountPool(store);

    const selected = await pool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "fresh-exhausted-session",
      preferredAccountId: limited.id,
    });

    expect(selected?.id).toBe(ready.id);
    expect((await store.get(limited.id))?.rateLimitBlockedAt).toBeDefined();
  });

  it("preserves quota failures separately from rate limits", async () => {
    const store = new MemoryAccountStore();
    const limited = await store.create({ provider: "codex", kind: "oauth", name: "quota" });
    await store.recordFailure(limited.id, {
      status: 429,
      message: "quota exceeded",
      rateLimitResetAt: new Date(Date.now() + 60_000).toISOString(),
      failureClass: "quota",
      failureCode: "quota_exceeded",
      failurePhase: "startup",
    });

    const account = await store.get(limited.id);
    const summary = summarizeAccountStatus([account!])[0]!;
    const failed = listFailedAccounts([account!])[0]!;

    expect(account?.lastFailureClass).toBe("quota");
    expect(account?.lastFailureCode).toBe("quota_exceeded");
    expect(summary.quotaExceeded).toBe(1);
    expect(summary.rateLimited).toBe(0);
    expect(failed.state).toBe("quota-exceeded");
  });

  it("keeps accounts in auth cooldown out of selection", async () => {
    const store = new MemoryAccountStore();
    const coolingDown = await store.create({ provider: "codex", kind: "oauth", name: "cooldown" });
    await store.recordFailure(coolingDown.id, {
      status: 401,
      message: "auth rejected",
    });
    const ready = await store.create({ provider: "codex", kind: "oauth", name: "ready" });
    const pool = new StickyAccountPool(store);

    const selected = await pool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
    });

    expect(selected?.id).toBe(ready.id);
    expect((await store.get(coolingDown.id))?.authCooldownUntil).toBeDefined();
  });

  it("skips accounts over the soft quota threshold when alternatives exist", async () => {
    const store = new MemoryAccountStore();
    const saturated = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "saturated",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 95, resets_at: new Date(Date.now() + 60_000).toISOString() },
          seven_day: { utilization: 40, resets_at: null },
        },
      },
    });
    const available = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "available",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 35, resets_at: null },
          seven_day: { utilization: 30, resets_at: null },
        },
      },
    });
    const pool = new StickyAccountPool(store, {
      strategy: "weighted",
      softQuotaThresholdPercent: 90,
    });

    const selected = await pool.select({
      provider: "claude-code",
      kind: "oauth",
      sessionKey: "session-a",
    });

    expect(selected?.id).toBe(available.id);
    expect(selected?.id).not.toBe(saturated.id);
  });

  it("does not soft-skip Claude usage after that tier has rolled over", async () => {
    const store = new MemoryAccountStore();
    const rolledOver = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "rolled-over",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 0.96, resets_at: new Date(Date.now() - 60_000).toISOString() },
          seven_day: { utilization: 0.2, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
        },
      },
    });
    const available = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "available",
      metadata: { cachedUsage: { five_hour: { utilization: 0.1, resets_at: null } } },
    });
    const pool = new StickyAccountPool(store, { strategy: "round-robin", softQuotaThresholdPercent: 90 });

    const result = await pool.selectWithDiagnostics({
      provider: "claude-code",
      kind: "oauth",
      sessionKey: "rollover-session",
    });

    expect(result.diagnostics.softQuotaSkippedAccountIds).not.toContain(rolledOver.id);
    expect(result.account?.id).toBe(rolledOver.id);
    expect(result.account?.id).not.toBe(available.id);
  });

  it("keeps a one-percent Claude usage value distinct from a ratio cache", async () => {
    const store = new MemoryAccountStore();
    const lowUsage = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "one-percent",
      metadata: {
        cachedUsage: {
          format: "percent-v1",
          five_hour: { utilization: 1, resets_at: null },
        },
      },
    });
    const exhausted = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "exhausted",
      metadata: {
        cachedUsage: {
          format: "percent-v1",
          five_hour: { utilization: 100, resets_at: null },
        },
      },
    });
    const pool = new StickyAccountPool(store, {
      strategy: "weighted",
      softQuotaThresholdPercent: 90,
    });

    const result = await pool.selectWithDiagnostics({
      provider: "claude-code",
      kind: "oauth",
      sessionKey: "one-percent-session",
    });

    expect(result.account?.id).toBe(lowUsage.id);
    expect(result.diagnostics.softQuotaSkippedAccountIds).toContain(exhausted.id);
  });

  it("treats fractional Claude OAuth utilization as a percentage", async () => {
    const store = new MemoryAccountStore();
    const fractionalPercent = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "fractional-percent",
      metadata: {
        cachedUsage: {
          format: "percent-v1",
          five_hour: { utilization: 0.5, resets_at: null },
        },
      },
    });
    const overThreshold = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "over-threshold",
      metadata: {
        cachedUsage: {
          format: "percent-v1",
          five_hour: { utilization: 10, resets_at: null },
        },
      },
    });
    const pool = new StickyAccountPool(store, {
      strategy: "round-robin",
      softQuotaThresholdPercent: 5,
    });

    const result = await pool.selectWithDiagnostics({
      provider: "claude-code",
      kind: "oauth",
      sessionKey: "fractional-percent-session",
    });

    expect(result.account?.id).toBe(fractionalPercent.id);
    expect(result.diagnostics.softQuotaSkippedAccountIds).not.toContain(fractionalPercent.id);
    expect(result.diagnostics.softQuotaSkippedAccountIds).toContain(overThreshold.id);
  });

  it("uses a conservative default soft quota threshold for fresh selection", async () => {
    const store = new MemoryAccountStore();
    const exhausted = await store.create({
      provider: "codex",
      kind: "oauth",
      name: "weekly-exhausted",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 0, resets_at: null },
          seven_day: { utilization: 100, resets_at: null },
        },
      },
    });
    const available = await store.create({
      provider: "codex",
      kind: "oauth",
      name: "available",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 35, resets_at: null },
          seven_day: { utilization: 40, resets_at: null },
        },
      },
    });
    const pool = new StickyAccountPool(store, { strategy: "round-robin" });

    const selected = await pool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
    });

    expect(selected?.id).toBe(available.id);
    expect(selected?.id).not.toBe(exhausted.id);
  });

  it("rebinds sticky sessions away from accounts above the soft quota threshold", async () => {
    const store = new MemoryAccountStore();
    const stickySessionStore = new MemoryStickySessionStore();
    const exhausted = await store.create({
      provider: "codex",
      kind: "oauth",
      name: "sticky-exhausted",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 100, resets_at: null },
          seven_day: { utilization: 20, resets_at: null },
        },
      },
    });
    const available = await store.create({
      provider: "codex",
      kind: "oauth",
      name: "available",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 20, resets_at: null },
          seven_day: { utilization: 20, resets_at: null },
        },
      },
    });
    stickySessionStore.upsertStickySession({
      key: "codex:codex_session:header:turn-a",
      provider: "codex",
      kind: "codex_session",
      sessionKey: "header:turn-a",
      accountId: exhausted.id,
    });
    const pool = new StickyAccountPool(store, {
      strategy: "round-robin",
      stickySessionStore,
    });

    const selected = await pool.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "header:turn-a",
    });

    expect(selected?.id).toBe(available.id);
    expect(pool.listStickySessions()).toEqual([
      expect.objectContaining({
        kind: "codex_session",
        sessionKey: "header:turn-a",
        accountId: available.id,
      }),
    ]);
  });

  it("treats Claude per-model seven-day buckets as soft quota inputs", async () => {
    const store = new MemoryAccountStore();
    const saturated = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "opus-saturated",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 20, resets_at: null },
          seven_day_opus: { utilization: "96", resets_at: null },
        },
      },
    });
    const available = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "available",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 25, resets_at: null },
          seven_day_opus: { utilization: 30, resets_at: null },
        },
      },
    });
    const pool = new StickyAccountPool(store, {
      strategy: "weighted",
      softQuotaThresholdPercent: 90,
    });

    const selected = await pool.select({
      provider: "claude-code",
      kind: "oauth",
      sessionKey: "session-a",
    });

    expect(selected?.id).toBe(available.id);
    expect(selected?.id).not.toBe(saturated.id);
  });

  it("prefers accounts that are under pace for their reset window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T00:00:00.000Z"));
    try {
      const store = new MemoryAccountStore();
      const overPace = await store.create({
        provider: "codex",
        kind: "oauth",
        name: "over-pace",
        metadata: {
          cachedUsage: {
            seven_day: {
              utilization: 40,
              resets_at: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
            },
          },
        },
      });
      const underPace = await store.create({
        provider: "codex",
        kind: "oauth",
        name: "under-pace",
        metadata: {
          cachedUsage: {
            seven_day: {
              utilization: 60,
              resets_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
            },
          },
        },
      });
      const pool = new StickyAccountPool(store, { strategy: "weighted" });

      const result = await pool.selectWithDiagnostics({
        provider: "codex",
        kind: "oauth",
        sessionKey: "session-a",
      });

      expect(result.account?.id).toBe(underPace.id);
      expect(result.account?.id).not.toBe(overPace.id);
      expect(result.diagnostics.selectedReason).toBe("weighted_best");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores blank utilization strings for soft quota inputs", async () => {
    const store = new MemoryAccountStore();
    const blankUsage = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "blank-usage",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: "" },
        },
      },
    });
    const saturated = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "saturated",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 95 },
        },
      },
    });
    const pool = new StickyAccountPool(store, {
      strategy: "weighted",
      softQuotaThresholdPercent: 90,
    });

    const selected = await pool.select({
      provider: "claude-code",
      kind: "oauth",
      sessionKey: "session-a",
    });

    expect(selected?.id).toBe(blankUsage.id);
    expect(selected?.id).not.toBe(saturated.id);
  });

  it("uses plan weights when selecting weighted accounts", async () => {
    const store = new MemoryAccountStore();
    const pro = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "pro",
      metadata: {
        planTier: "pro",
        cachedUsage: {
          five_hour: { utilization: 45, resets_at: null },
          seven_day: { utilization: 45, resets_at: null },
        },
      },
    });
    const max = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "max",
      metadata: {
        planTier: "max",
        cachedUsage: {
          five_hour: { utilization: 45, resets_at: null },
          seven_day: { utilization: 45, resets_at: null },
        },
      },
    });
    const pool = new StickyAccountPool(store, { strategy: "weighted" });

    const selected = await pool.select({
      provider: "claude-code",
      kind: "oauth",
      sessionKey: "session-a",
    });

    expect(selected?.id).toBe(max.id);
    expect(selected?.id).not.toBe(pro.id);
  });
});
