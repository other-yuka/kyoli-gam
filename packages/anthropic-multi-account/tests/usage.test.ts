import { describe, expect, it } from "bun:test";

describe("getUsageSummary", () => {
  it("hides reset time when utilization < 100", async () => {
    const { getUsageSummary } = await import("../src/usage");

    const account = {
      index: 0,
      refreshToken: "r",
      addedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
      cachedUsage: {
        five_hour: { utilization: 50, resets_at: new Date(Date.now() + 3600_000).toISOString() },
        seven_day: { utilization: 30, resets_at: new Date(Date.now() + 86400_000).toISOString() },
        seven_day_sonnet: null,
      },
    };

    const summary = getUsageSummary(account);
    expect(summary).toMatch(/5h: 50%/);
    expect(summary).not.toMatch(/resets/);
    expect(summary).toMatch(/7d: 30%/);
  });

  it("shows reset time when utilization >= 100", async () => {
    const { getUsageSummary } = await import("../src/usage");

    const account = {
      index: 0,
      refreshToken: "r",
      addedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
      cachedUsage: {
        five_hour: { utilization: 100, resets_at: new Date(Date.now() + 3600_000).toISOString() },
        seven_day: null,
        seven_day_sonnet: null,
      },
    };

    const summary = getUsageSummary(account);
    expect(summary).toMatch(/5h: 100%/);
    expect(summary).toMatch(/resets/);
  });
});
