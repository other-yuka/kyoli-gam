import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildFakeJwt } from "./helpers";

// ─── Mock fetch before importing module ─────────────────────────

const originalFetch = globalThis.fetch;
let mockFetchFn: any;

beforeEach(() => {
  mockFetchFn = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
  globalThis.fetch = mockFetchFn as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ─── WHAM API response fixtures ─────────────────────────────────

function makeWhamResponse(overrides: Record<string, unknown> = {}) {
  return {
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 9,
        reset_after_seconds: 7252,
      },
      secondary_window: {
        used_percent: 3,
        reset_after_seconds: 265266,
      },
    },
    credits: {
      balance: "0",
      unlimited: false,
    },
    ...overrides,
  };
}

function mockFetchResponse(body: unknown, status = 200) {
  mockFetchFn.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, statusText: status === 200 ? "OK" : "Error" })),
  );
}

// ─── Tests ──────────────────────────────────────────────────────

describe("fetchUsage", () => {
  it("maps WHAM primary_window to five_hour", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse(makeWhamResponse());

    const result = await fetchUsage("test-access-token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.five_hour).not.toBeNull();
    expect(result.data.five_hour!.utilization).toBe(9);
    expect(result.data.five_hour!.resets_at).toBeTruthy();
  });

  it("maps WHAM secondary_window to seven_day", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse(makeWhamResponse());

    const result = await fetchUsage("test-access-token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.seven_day).not.toBeNull();
    expect(result.data.seven_day!.utilization).toBe(3);
    expect(result.data.seven_day!.resets_at).toBeTruthy();
  });

  it("converts reset_after_seconds to ISO timestamp in the future", async () => {
    const { fetchUsage } = await import("../src/usage");
    const resetAfterSeconds = 7252;
    mockFetchResponse(makeWhamResponse());

    const beforeMs = Date.now();
    const result = await fetchUsage("test-access-token");
    const afterMs = Date.now();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resetAt = new Date(result.data.five_hour!.resets_at!).getTime();
    expect(resetAt).toBeGreaterThanOrEqual(beforeMs + resetAfterSeconds * 1000);
    expect(resetAt).toBeLessThanOrEqual(afterMs + resetAfterSeconds * 1000);
  });

  it("sends Authorization header with access token", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse(makeWhamResponse());

    await fetchUsage("my-secret-token");

    expect(mockFetchFn).toHaveBeenCalledTimes(1);
    const [, init] = mockFetchFn.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-secret-token");
  });

  it("sends ChatGPT-Account-Id header when accountId provided", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse(makeWhamResponse());

    await fetchUsage("token", "acc-123");

    const [, init] = mockFetchFn.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["ChatGPT-Account-Id"]).toBe("acc-123");
  });

  it("omits ChatGPT-Account-Id header when accountId not provided", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse(makeWhamResponse());

    await fetchUsage("token");

    const [, init] = mockFetchFn.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["ChatGPT-Account-Id"]).toBeUndefined();
  });

  it("returns error for non-200 HTTP response", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse({ error: "unauthorized" }, 401);

    const result = await fetchUsage("bad-token");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("401");
  });

  it("returns error for invalid response shape", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse({ unexpected: "data", rate_limit: "not-an-object" });

    const result = await fetchUsage("token");

    // Should still succeed since WhamUsageResponseSchema uses optional fields
    // The rate_limit being a string will cause a parse failure
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Invalid response");
  });

  it("handles missing rate_limit gracefully", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse({ plan_type: "free" });

    const result = await fetchUsage("token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.five_hour).toBeNull();
    expect(result.data.seven_day).toBeNull();
  });

  it("handles missing primary_window only", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse(makeWhamResponse({
      rate_limit: {
        secondary_window: { used_percent: 5, reset_after_seconds: 100000 },
      },
    }));

    const result = await fetchUsage("token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.five_hour).toBeNull();
    expect(result.data.seven_day).not.toBeNull();
    expect(result.data.seven_day!.utilization).toBe(5);
  });

  it("handles network error", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchFn.mockImplementation(() => Promise.reject(new Error("Network unreachable")));

    const result = await fetchUsage("token");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Network unreachable");
  });

  it("calls the correct WHAM usage endpoint", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse(makeWhamResponse());

    await fetchUsage("token");

    const [url] = mockFetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
  });

  it("sets seven_day_sonnet to null (not applicable for Codex)", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse(makeWhamResponse());

    const result = await fetchUsage("token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.seven_day_sonnet).toBeNull();
  });

  it("returns planType from WHAM response", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse(makeWhamResponse({ plan_type: "pro" }));

    const result = await fetchUsage("token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.planType).toBe("pro");
  });

  it("returns undefined planType when WHAM response omits it", async () => {
    const { fetchUsage } = await import("../src/usage");
    mockFetchResponse({ rate_limit: {} });

    const result = await fetchUsage("token");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.planType).toBeUndefined();
  });
});

describe("fetchProfile", () => {
  it("extracts email from OpenAI namespaced JWT claims", async () => {
    const { fetchProfile } = await import("../src/usage");
    const token = buildFakeJwt({
      "https://api.openai.com/profile": { email: "user@example.com" },
      "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
    });

    const result = fetchProfile(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.email).toBe("user@example.com");
  });

  it("detects Pro plan ($200) from namespaced auth claim", async () => {
    const { fetchProfile } = await import("../src/usage");
    const token = buildFakeJwt({
      "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
    });

    const result = fetchProfile(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.planTier).toBe("pro");
  });

  it("detects Plus plan ($20) from namespaced auth claim", async () => {
    const { fetchProfile } = await import("../src/usage");
    const token = buildFakeJwt({
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    });

    const result = fetchProfile(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.planTier).toBe("plus");
  });

  it("returns defaults when JWT has no plan claims", async () => {
    const { fetchProfile } = await import("../src/usage");
    const token = buildFakeJwt({ sub: "user-123" });

    const result = fetchProfile(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.planTier).toBe("free");
  });

  it("returns defaults for invalid JWT (no crash)", async () => {
    const { fetchProfile } = await import("../src/usage");

    const result = fetchProfile("not-a-jwt");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.planTier).toBe("free");
    expect(result.data.email).toBeUndefined();
  });
});

describe("derivePlanTier", () => {
  it("returns pro for pro input", async () => {
    const { derivePlanTier } = await import("../src/usage");
    expect(derivePlanTier("pro")).toBe("pro");
  });

  it("returns plus for plus input", async () => {
    const { derivePlanTier } = await import("../src/usage");
    expect(derivePlanTier("plus")).toBe("plus");
  });

  it("normalizes uppercase to lowercase", async () => {
    const { derivePlanTier } = await import("../src/usage");
    expect(derivePlanTier("PRO")).toBe("pro");
    expect(derivePlanTier("Plus")).toBe("plus");
  });

  it("returns free for free or empty plan", async () => {
    const { derivePlanTier } = await import("../src/usage");
    expect(derivePlanTier("free")).toBe("free");
    expect(derivePlanTier("")).toBe("free");
  });
});

describe("getUsageSummary", () => {
  it("formats usage with both tiers", async () => {
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
        five_hour: { utilization: 9, resets_at: new Date(Date.now() + 3600_000).toISOString() },
        seven_day: { utilization: 3, resets_at: new Date(Date.now() + 86400_000).toISOString() },
        seven_day_sonnet: null,
      },
    };

    const summary = getUsageSummary(account);
    expect(summary).toContain("5h: 9%");
    expect(summary).toContain("7d: 3%");
  });

  it("returns 'no usage data' when cachedUsage is absent", async () => {
    const { getUsageSummary } = await import("../src/usage");

    const account = {
      index: 0,
      refreshToken: "r",
      addedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
    };

    expect(getUsageSummary(account)).toBe("no usage data");
  });
});

describe("getPlanLabel", () => {
  it("returns ChatGPT Pro for pro tier", async () => {
    const { getPlanLabel } = await import("../src/usage");

    const account = {
      index: 0, refreshToken: "r", addedAt: 0, lastUsed: 0,
      enabled: true, consecutiveAuthFailures: 0, isAuthDisabled: false,
      planTier: "pro",
    };

    expect(getPlanLabel(account)).toBe("ChatGPT Pro");
  });

  it("returns ChatGPT Plus for plus tier", async () => {
    const { getPlanLabel } = await import("../src/usage");

    const account = {
      index: 0, refreshToken: "r", addedAt: 0, lastUsed: 0,
      enabled: true, consecutiveAuthFailures: 0, isAuthDisabled: false,
      planTier: "plus",
    };

    expect(getPlanLabel(account)).toBe("ChatGPT Plus");
  });

  it("returns empty string for free accounts", async () => {
    const { getPlanLabel } = await import("../src/usage");

    const account = {
      index: 0, refreshToken: "r", addedAt: 0, lastUsed: 0,
      enabled: true, consecutiveAuthFailures: 0, isAuthDisabled: false,
    };

    expect(getPlanLabel(account)).toBe("");
  });
});
