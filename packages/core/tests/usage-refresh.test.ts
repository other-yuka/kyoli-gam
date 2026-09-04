import { describe, expect, it } from "vitest";
import {
  MemoryAccountStore,
  UsageRefreshService,
  type ProviderAdapter,
} from "../src";

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
    });
    await store.recordFailure(recovered.id, {
      status: 429,
      message: "limited",
      failureClass: "rate_limit",
      failureCode: "rate_limit",
      failurePhase: "startup",
      rateLimitResetAt: new Date(Date.now() + 60_000).toISOString(),
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
});

function createUsageProvider(refreshUsage: ProviderAdapter["refreshUsage"]): ProviderAdapter {
  return {
    id: "codex",
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
