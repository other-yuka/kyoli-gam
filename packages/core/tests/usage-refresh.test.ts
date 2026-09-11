import { describe, expect, it, vi } from "vitest";
import {
  MemoryAccountStore,
  UsageRefreshService,
  type ProviderAdapter,
} from "../src";

class InterleavingAccountStore extends MemoryAccountStore {
  beforeUpdate?: () => Promise<void>;
  afterUpdate?: () => Promise<void>;

  override async update(
    id: string,
    input: Parameters<MemoryAccountStore["update"]>[1],
  ): ReturnType<MemoryAccountStore["update"]> {
    const beforeUpdate = this.beforeUpdate;
    this.beforeUpdate = undefined;
    await beforeUpdate?.();
    const updated = await super.update(id, input);
    const afterUpdate = this.afterUpdate;
    this.afterUpdate = undefined;
    await afterUpdate?.();
    return updated;
  }
}

describe("UsageRefreshService", () => {
  it("refreshes stale provider usage metadata", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      metadata: { cachedUsageAt: Date.now() - 10_000 },
    });
    const provider = createUsageProvider(async () => ({
      ok: true,
      metadata: {
        cachedUsageAt: Date.now(),
        cachedUsage: {
          five_hour: { utilization: 25, resets_at: null },
          seven_day: { utilization: 40, resets_at: null },
        },
      },
    }));

    const service = new UsageRefreshService({
      accounts: store,
      providers: [provider],
      intervalMs: 1,
    });

    const result = await service.refreshOnce();
    const updated = await store.get(account.id);

    expect(result).toMatchObject({ checked: 1, refreshed: 1, failed: 0 });
    expect((updated?.metadata.cachedUsage as { five_hour?: { utilization: number } }).five_hour?.utilization)
      .toBe(25);
  });

  it("skips fresh usage snapshots unless forced", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      metadata: { cachedUsageAt: Date.now() },
    });
    let calls = 0;
    const provider = createUsageProvider(async () => {
      calls += 1;
      return { ok: true, metadata: { cachedUsageAt: Date.now() } };
    });

    const service = new UsageRefreshService({
      accounts: store,
      providers: [provider],
      intervalMs: 60_000,
    });

    expect(await service.refreshOnce()).toMatchObject({ checked: 1, skipped: 1 });
    expect(calls).toBe(0);
    expect(await service.refreshOnce({ force: true })).toMatchObject({ checked: 1, refreshed: 1 });
    expect(calls).toBe(1);
  });

  it("refreshes disabled accounts without re-enabling them", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      enabled: false,
      metadata: { cachedUsageAt: Date.now() - 10_000 },
    });
    const provider = createUsageProvider(async () => ({
      ok: true,
      metadata: {
        cachedUsageAt: Date.now(),
        cachedUsage: { five_hour: { utilization: 10, resets_at: null } },
      },
    }));

    const service = new UsageRefreshService({
      accounts: store,
      providers: [provider],
      intervalMs: 1,
    });

    expect(await service.refreshOnce()).toMatchObject({ checked: 1, refreshed: 1 });
    const updated = await store.get(account.id);
    expect(updated?.enabled).toBe(false);
    expect((updated?.metadata.cachedUsage as { five_hour?: { utilization: number } }).five_hour?.utilization)
      .toBe(10);
  });

  it("merges refreshed fields with concurrent metadata changes", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: { accessToken: "stale-access", refreshToken: "stale-refresh" },
      metadata: { source: "initial" },
    });
    let signalUsageStarted: (() => void) | undefined;
    let finishUsage: (() => void) | undefined;
    const usageStarted = new Promise<void>((resolve) => {
      signalUsageStarted = resolve;
    });
    const usageFinished = new Promise<void>((resolve) => {
      finishUsage = resolve;
    });
    const provider = createUsageProvider(async ({ account: staleAccount }) => {
      signalUsageStarted?.();
      await usageFinished;
      return {
        ok: true,
        credentials: {
          ...staleAccount.credentials,
          accessToken: "refreshed-access",
        },
        metadata: {
          ...staleAccount.metadata,
          cachedUsageAt: Date.now(),
          usageSource: "refresh",
        },
      };
    });
    const service = new UsageRefreshService({
      accounts: store,
      providers: [provider],
      intervalMs: 0,
    });

    const refresh = service.refreshOnce();
    await usageStarted;
    await store.update(account.id, {
      metadataPatch: { source: "concurrent" },
    });
    finishUsage?.();
    await refresh;

    expect((await store.get(account.id))?.credentials).toEqual({
      accessToken: "refreshed-access",
      refreshToken: "stale-refresh",
    });
    expect((await store.get(account.id))?.metadata).toMatchObject({
      source: "concurrent",
      usageSource: "refresh",
      cachedUsageAt: expect.any(Number),
    });
  });

  it("preserves concurrent nested usage metadata changes", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        },
      },
    });
    let signalUsageStarted: (() => void) | undefined;
    let finishUsage: (() => void) | undefined;
    const usageStarted = new Promise<void>((resolve) => {
      signalUsageStarted = resolve;
    });
    const usageFinished = new Promise<void>((resolve) => {
      finishUsage = resolve;
    });
    const provider = createUsageProvider(async ({ account: staleAccount }) => {
      signalUsageStarted?.();
      await usageFinished;
      const staleUsage = staleAccount.metadata.cachedUsage as Record<string, unknown>;
      return {
        ok: true,
        metadata: {
          ...staleAccount.metadata,
          cachedUsage: {
            ...staleUsage,
            five_hour: { utilization: 25 },
          },
          cachedUsageAt: Date.now(),
        },
      };
    });
    const service = new UsageRefreshService({
      accounts: store,
      providers: [provider],
      intervalMs: 0,
    });

    const refresh = service.refreshOnce();
    await usageStarted;
    const currentUsage = account.metadata.cachedUsage as Record<string, unknown>;
    await store.update(account.id, {
      metadataPatch: {
        cachedUsage: {
          ...currentUsage,
          seven_day: { utilization: 30, operatorNote: "keep" },
        },
      },
    });
    finishUsage?.();
    await refresh;

    await expect(store.get(account.id)).resolves.toMatchObject({
      metadata: {
        cachedUsage: {
          five_hour: { utilization: 25 },
          seven_day: { utilization: 30, operatorNote: "keep" },
        },
      },
    });
  });

  it("does not let an older usage refresh overwrite a newer rate-limit snapshot", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.setSystemTime(now);

    try {
      const store = new InterleavingAccountStore();
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
        metadata: { cachedUsageAt: now - 10_000 },
      });
      let signalUsageStarted: (() => void) | undefined;
      let finishUsage: (() => void) | undefined;
      const usageStarted = new Promise<void>((resolve) => {
        signalUsageStarted = resolve;
      });
      const usageFinished = new Promise<void>((resolve) => {
        finishUsage = resolve;
      });
      const provider = createUsageProvider(async () => {
        signalUsageStarted?.();
        await usageFinished;
        return {
          ok: true,
          metadata: {
            cachedUsageAt: Date.now() + 1_000,
            cachedUsage: {
              five_hour: { utilization: 10, resets_at: null },
            },
            planTier: "max",
          },
        };
      }, "claude-code");
      const service = new UsageRefreshService({
        accounts: store,
        providers: [provider],
        intervalMs: 0,
      });

      const refresh = service.refreshOnce();
      await usageStarted;
      vi.advanceTimersByTime(1);
      const rateLimitedAt = Date.now();
      const cooldownUntil = new Date(rateLimitedAt + 60_000).toISOString();
      const rateLimitUsage = {
        five_hour: {
          utilization: 100,
          resets_at: new Date(rateLimitedAt + 60 * 60 * 1000).toISOString(),
        },
      };
      store.beforeUpdate = async () => {
        await store.recordFailure(account.id, {
          status: 429,
          message: "rate limited",
          failureClass: "rate_limit",
          failureCode: "rate_limit",
          failurePhase: "startup",
          rateLimitCooldownUntil: cooldownUntil,
          metadata: {
            cachedUsage: rateLimitUsage,
            cachedUsageAt: rateLimitedAt,
          },
        });
      };
      finishUsage?.();

      await expect(refresh).resolves.toMatchObject({ checked: 1, refreshed: 1, failed: 0 });
      await expect(store.get(account.id)).resolves.toMatchObject({
        metadata: {
          cachedUsage: rateLimitUsage,
          cachedUsageAt: rateLimitedAt,
          planTier: "max",
        },
        rateLimitBlockedAt: new Date(rateLimitedAt).toISOString(),
        rateLimitCooldownUntil: cooldownUntil,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recover a newer rate limit after its cooldown elapses during a stale refresh", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.setSystemTime(now);

    try {
      const store = new InterleavingAccountStore();
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
        metadata: {
          cachedUsageAt: now - 10_000,
          cachedUsage: {
            five_hour: { utilization: 10, resets_at: null },
          },
        },
      });
      let signalUsageStarted: (() => void) | undefined;
      let finishUsage: (() => void) | undefined;
      const usageStarted = new Promise<void>((resolve) => {
        signalUsageStarted = resolve;
      });
      const usageFinished = new Promise<void>((resolve) => {
        finishUsage = resolve;
      });
      const provider = createUsageProvider(async () => {
        signalUsageStarted?.();
        await usageFinished;
        return {
          ok: true,
          metadata: {
            cachedUsageAt: Date.now(),
            cachedUsage: {
              five_hour: { utilization: 20, resets_at: null },
            },
            planTier: "max",
          },
        };
      }, "claude-code");
      const service = new UsageRefreshService({
        accounts: store,
        providers: [provider],
        intervalMs: 0,
      });
      const resetAt = new Date(now + 60 * 60 * 1000).toISOString();
      const cooldownUntil = new Date(now + 1).toISOString();

      const refresh = service.refreshOnce();
      await usageStarted;
      store.beforeUpdate = async () => {
        await store.recordFailure(account.id, {
          status: 429,
          message: "newer rate limit",
          failureClass: "rate_limit",
          rateLimitResetAt: resetAt,
          rateLimitCooldownUntil: cooldownUntil,
        });
        vi.advanceTimersByTime(2);
      };
      finishUsage?.();

      await expect(refresh).resolves.toMatchObject({ checked: 1, refreshed: 1, failed: 0 });
      await expect(store.get(account.id)).resolves.toMatchObject({
        failureCount: 1,
        lastFailureMessage: "newer rate limit",
        metadata: {
          cachedUsageAt: now - 10_000,
          cachedUsage: {
            five_hour: { utilization: 10, resets_at: null },
          },
          planTier: "max",
        },
        rateLimitResetAt: resetAt,
        rateLimitCooldownUntil: cooldownUntil,
        rateLimitObservedAt: now,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clear a rate limit recorded as the usage update returns", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.setSystemTime(now);

    try {
      const store = new InterleavingAccountStore();
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
        metadata: { cachedUsageAt: now - 10_000 },
      });
      await store.recordFailure(account.id, {
        status: 429,
        message: "old rate limit",
        failureClass: "rate_limit",
        failureCode: "rate_limit",
        failurePhase: "startup",
        rateLimitResetAt: new Date(now + 60 * 60 * 1000).toISOString(),
        rateLimitCooldownUntil: new Date(now - 1).toISOString(),
      });
      const provider = createUsageProvider(async () => ({
        ok: true,
        metadata: {
          cachedUsageAt: Date.now(),
          cachedUsage: {
            five_hour: { utilization: 10, resets_at: null },
            seven_day: { utilization: 20, resets_at: null },
          },
        },
      }), "claude-code");
      const service = new UsageRefreshService({
        accounts: store,
        providers: [provider],
        intervalMs: 0,
      });
      const newCooldownUntil = new Date(now + 2 * 60_000).toISOString();
      store.afterUpdate = async () => {
        await store.recordFailure(account.id, {
          status: 429,
          message: "new rate limit",
          failureClass: "rate_limit",
          failureCode: "rate_limit",
          failurePhase: "startup",
          rateLimitCooldownUntil: newCooldownUntil,
        });
      };
      vi.setSystemTime(now + 1);

      await expect(service.refreshOnce()).resolves.toMatchObject({ checked: 1, refreshed: 1, failed: 0 });
      await expect(store.get(account.id)).resolves.toMatchObject({
        failureCount: 1,
        lastFailureMessage: "new rate limit",
        rateLimitBlockedAt: new Date(now + 1).toISOString(),
        rateLimitCooldownUntil: newCooldownUntil,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a stale refresh after concurrent credentials are replaced", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "generation-a-access",
        refreshToken: "generation-a-refresh",
        accountId: "generation-a-account",
      },
      metadata: { owner: "initial" },
    });
    let signalUsageStarted: (() => void) | undefined;
    let finishUsage: (() => void) | undefined;
    const usageStarted = new Promise<void>((resolve) => {
      signalUsageStarted = resolve;
    });
    const usageFinished = new Promise<void>((resolve) => {
      finishUsage = resolve;
    });
    const provider = createUsageProvider(async ({ account: staleAccount }) => {
      signalUsageStarted?.();
      await usageFinished;
      return {
        ok: true,
        credentials: {
          ...staleAccount.credentials,
          accessToken: "generation-a-refreshed-access",
        },
        metadata: {
          ...staleAccount.metadata,
          cachedUsageAt: Date.now(),
        },
      };
    });
    const service = new UsageRefreshService({
      accounts: store,
      providers: [provider],
      intervalMs: 0,
    });

    const refresh = service.refreshOnce();
    await usageStarted;
    await store.update(account.id, {
      credentials: {
        accessToken: "generation-b-access",
        refreshToken: "generation-b-refresh",
        accountId: "generation-b-account",
      },
      metadataPatch: { owner: "reauthenticated" },
    });
    finishUsage?.();

    await expect(refresh).resolves.toMatchObject({ checked: 1, refreshed: 0, failed: 1 });
    await expect(store.get(account.id)).resolves.toMatchObject({
      credentials: {
        accessToken: "generation-b-access",
        refreshToken: "generation-b-refresh",
        accountId: "generation-b-account",
      },
      metadata: { owner: "reauthenticated" },
    });
  });

  it("only recovers blocked accounts when every visible usage window has capacity", async () => {
    const store = new MemoryAccountStore();
    const exhausted = await store.create({
      provider: "codex",
      kind: "oauth",
      metadata: { cachedUsageAt: Date.now() - 10_000 },
    });
    const recovered = await store.create({
      provider: "codex",
      kind: "oauth",
      metadata: { cachedUsageAt: Date.now() - 10_000 },
    });
    await store.recordFailure(exhausted.id, {
      status: 429,
      message: "limited",
      failureClass: "rate_limit",
      failureCode: "rate_limit",
      failurePhase: "startup",
      rateLimitResetAt: new Date(Date.now() + 60_000).toISOString(),
      rateLimitCooldownUntil: new Date(Date.now() - 1).toISOString(),
    });
    await store.recordFailure(recovered.id, {
      status: 429,
      message: "limited",
      failureClass: "rate_limit",
      failureCode: "rate_limit",
      failurePhase: "startup",
      rateLimitResetAt: new Date(Date.now() + 60_000).toISOString(),
      rateLimitCooldownUntil: new Date(Date.now() - 1).toISOString(),
    });
    const provider = createUsageProvider(async ({ account }) => ({
      ok: true,
      metadata: {
        cachedUsageAt: Date.now(),
        cachedUsage: account.id === exhausted.id
          ? {
            five_hour: { utilization: 100, resets_at: null },
            seven_day: { utilization: 40, resets_at: null },
          }
          : {
            five_hour: { utilization: 20, resets_at: null },
            seven_day: { utilization: 40, resets_at: null },
          },
      },
    }));

    const service = new UsageRefreshService({
      accounts: store,
      providers: [provider],
      intervalMs: 1,
    });

    expect(await service.refreshOnce()).toMatchObject({ checked: 2, refreshed: 2 });
    expect((await store.get(exhausted.id))?.rateLimitResetAt).toBeDefined();
    expect((await store.get(recovered.id))?.rateLimitResetAt).toBeUndefined();
  });

  it("recovers a blocked account when its exhausted usage window has rolled over", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.setSystemTime(now);

    try {
      const store = new MemoryAccountStore();
      const account = await store.create({
        provider: "codex",
        kind: "oauth",
        metadata: { cachedUsageAt: now - 10_000 },
      });
      await store.recordFailure(account.id, {
        status: 429,
        message: "limited",
        failureClass: "rate_limit",
        failureCode: "rate_limit",
        failurePhase: "startup",
        rateLimitResetAt: new Date(now + 60_000).toISOString(),
        rateLimitCooldownUntil: new Date(now - 1).toISOString(),
      });
      vi.setSystemTime(now + 1);
      const provider = createUsageProvider(async () => ({
        ok: true,
        metadata: {
          cachedUsageAt: Date.now(),
          cachedUsage: {
            five_hour: { utilization: 100, resets_at: new Date(now - 60_000).toISOString() },
            seven_day: { utilization: 20, resets_at: null },
          },
        },
      }));
      const service = new UsageRefreshService({
        accounts: store,
        providers: [provider],
        intervalMs: 1,
      });

      expect(await service.refreshOnce()).toMatchObject({ checked: 1, refreshed: 1 });
      expect((await store.get(account.id))?.rateLimitResetAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let fresh usage clear an active provider retry cooldown", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "claude-code",
      kind: "oauth",
      metadata: { cachedUsageAt: Date.now() - 10_000 },
    });
    const cooldownUntil = new Date(Date.now() + 60_000).toISOString();
    await store.recordFailure(account.id, {
      status: 429,
      message: "rate limited",
      failureClass: "rate_limit",
      failureCode: "rate_limit",
      failurePhase: "startup",
      rateLimitCooldownUntil: cooldownUntil,
    });
    const provider = createUsageProvider(async () => ({
      ok: true,
      metadata: {
        cachedUsageAt: Date.now(),
        cachedUsage: {
          five_hour: { utilization: 10, resets_at: null },
          seven_day: { utilization: 20, resets_at: null },
        },
      },
    }), "claude-code");
    const service = new UsageRefreshService({
      accounts: store,
      providers: [provider],
      intervalMs: 1,
    });

    expect(await service.refreshOnce()).toMatchObject({ checked: 1, refreshed: 1 });
    expect(await store.get(account.id)).toMatchObject({
      rateLimitBlockedAt: expect.any(String),
      rateLimitCooldownUntil: cooldownUntil,
    });
  });
});

function createUsageProvider(
  refreshUsage: ProviderAdapter["refreshUsage"],
  id: ProviderAdapter["id"] = "codex",
): ProviderAdapter {
  return {
    id,
    displayName: "Test Codex",
    routes: [],
    async listModels() {
      return [];
    },
    async handleRequest() {
      return new Response(null, { status: 204 });
    },
    refreshUsage,
  };
}
