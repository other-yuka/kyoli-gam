import { describe, expect, it } from "vitest";
import { MemoryAccountStore } from "../src/accounts";
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
