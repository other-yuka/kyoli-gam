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
