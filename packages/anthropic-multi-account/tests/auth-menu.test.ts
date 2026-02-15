import { describe, expect, it } from "bun:test";

describe("getAccountStatus", () => {
  it("returns rate-limited when rateLimitResetAt is in the future", async () => {
    const { getAccountStatus } = await import("../src/ui/auth-menu");

    const account = {
      index: 0,
      refreshToken: "r",
      addedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
      rateLimitResetAt: Date.now() + 60_000,
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
    };

    expect(getAccountStatus(account)).toBe("rate-limited");
  });

  it("returns rate-limited when cached usage tier is exhausted with future reset", async () => {
    const { getAccountStatus } = await import("../src/ui/auth-menu");

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

    expect(getAccountStatus(account)).toBe("rate-limited");
  });

  it("returns active when cachedUsage is absent", async () => {
    const { getAccountStatus } = await import("../src/ui/auth-menu");

    const account = {
      index: 0,
      refreshToken: "r",
      addedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
    };

    expect(getAccountStatus(account)).toBe("active");
  });

  it("returns active when utilization is below 100", async () => {
    const { getAccountStatus } = await import("../src/ui/auth-menu");

    const account = {
      index: 0,
      refreshToken: "r",
      addedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
      cachedUsage: {
        five_hour: { utilization: 99, resets_at: new Date(Date.now() + 3600_000).toISOString() },
        seven_day: { utilization: 50, resets_at: new Date(Date.now() + 86400_000).toISOString() },
        seven_day_sonnet: null,
      },
    };

    expect(getAccountStatus(account)).toBe("active");
  });
});
