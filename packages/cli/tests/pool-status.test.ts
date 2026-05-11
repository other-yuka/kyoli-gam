import { describe, expect, it } from "vitest";
import {
  MemoryAccountStore,
  MemoryRequestLogStore,
  MemoryStickySessionStore,
} from "@kyoli-gam/core";
import {
  createPoolStatus,
  formatPoolBanner,
  formatPoolDoctorDetail,
} from "../src/pool-status";

describe("pool status UX", () => {
  it("formats an empty pool with a login/import hint", () => {
    const status = createPoolStatus({ accounts: [], strategy: "sticky" });

    expect(formatPoolBanner(status)).toEqual([
      "Pool: no accounts loaded — run `kyoli login codex`, `kyoli login claude`, or `kyoli accounts import opencode`.",
    ]);
    expect(formatPoolDoctorDetail(status)).toContain("No accounts loaded");
  });

  it("summarizes account states and observability", async () => {
    const accounts = new MemoryAccountStore();
    const ready = await accounts.create({ provider: "codex", kind: "oauth", name: "ready" });
    const limited = await accounts.create({ provider: "codex", kind: "oauth", name: "limited" });
    await accounts.recordFailure(limited.id, {
      status: 429,
      message: "rate limited",
      rateLimitResetAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await accounts.create({ provider: "claude-code", kind: "oauth", name: "claude" });

    const stickySessions = new MemoryStickySessionStore();
    stickySessions.upsertStickySession({
      key: "codex:oauth:s1",
      provider: "codex",
      kind: "oauth",
      sessionKey: "s1",
      accountId: ready.id,
    });
    const requestLogs = new MemoryRequestLogStore();
    requestLogs.createRequestLog({
      provider: "codex",
      sessionKey: "s1",
      accountId: ready.id,
      eventType: "response",
      status: 200,
    });

    const status = createPoolStatus({
      accounts: await accounts.list(),
      strategy: "weighted",
      stickySessions,
      requestLogs,
    });

    expect(status).toMatchObject({
      total: 3,
      ready: 2,
      rateLimited: 1,
      stickySessions: 1,
      responses: 1,
    });
    expect(formatPoolBanner(status)).toEqual([
      "Pool: 3 accounts loaded — weighted, sticky-ready; ready=2 rate_limited=1 auth_cooldown=0 disabled=0 reauth_required=0 failed=1.",
      "  claude-code: ready=1 rate_limited=0 auth_cooldown=0 disabled=0 reauth_required=0 failed=0",
      "  codex: ready=1 rate_limited=1 auth_cooldown=0 disabled=0 reauth_required=0 failed=1",
    ]);
  });

  it("calls out single-account mode", async () => {
    const accounts = new MemoryAccountStore();
    await accounts.create({ provider: "codex", kind: "oauth" });

    const status = createPoolStatus({
      accounts: await accounts.list(),
      strategy: "sticky",
    });

    expect(formatPoolBanner(status)).toContain("  Add another account to enable failover and load balancing.");
    expect(formatPoolDoctorDetail(status)).toContain("1 total");
  });
});
