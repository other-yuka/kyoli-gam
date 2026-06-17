import { describe, expect, it, vi } from "vitest";
import {
  CODEX_RATE_LIMIT_RESET_CONSUME_ENDPOINT,
  CODEX_RATE_LIMIT_RESET_CREDITS_ENDPOINT,
  CodexRateLimitResetError,
  consumeCodexRateLimitResetCredit,
  fetchCodexRateLimitResetCredits,
} from "../src/reset-credits";

describe("codex reset credits", () => {
  it("lists banked reset credits with Codex OAuth account headers", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      available_count: 1,
      credits: [
        {
          id: "RateLimitResetCredit_123",
          status: "available",
          reset_type: "codex_rate_limits",
          granted_at: "2026-06-12T01:33:14Z",
          expires_at: "2026-07-12T01:33:14Z",
          title: "One free rate limit reset",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await fetchCodexRateLimitResetCredits({
      accessToken: "access-token",
      chatgptAccountId: "chatgpt-account",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(CODEX_RATE_LIMIT_RESET_CREDITS_ENDPOINT, {
      method: "GET",
      headers: expect.objectContaining({
        authorization: "Bearer access-token",
        "ChatGPT-Account-Id": "chatgpt-account",
        accept: "application/json",
      }),
    });
    expect(result.availableCount).toBe(1);
    expect(result.credits[0]).toMatchObject({
      id: "RateLimitResetCredit_123",
      status: "available",
      resetType: "codex_rate_limits",
      grantedAt: "2026-06-12T01:33:14Z",
      expiresAt: "2026-07-12T01:33:14Z",
      title: "One free rate limit reset",
    });
  });

  it("consumes a selected reset credit with a stable redeem request id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: "reset",
      windows_reset: 1,
      credit: {
        id: "RateLimitResetCredit_123",
        status: "redeemed",
        redeemed_at: "2026-06-13T13:12:31Z",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await consumeCodexRateLimitResetCredit({
      accessToken: "access-token",
      chatgptAccountId: "chatgpt-account",
      creditId: "RateLimitResetCredit_123",
      redeemRequestId: "redeem-request-id",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(CODEX_RATE_LIMIT_RESET_CONSUME_ENDPOINT, {
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer access-token",
        "ChatGPT-Account-Id": "chatgpt-account",
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        credit_id: "RateLimitResetCredit_123",
        redeem_request_id: "redeem-request-id",
      }),
    });
    expect(result).toMatchObject({
      code: "reset",
      windowsReset: 1,
      credit: {
        id: "RateLimitResetCredit_123",
        status: "redeemed",
        redeemedAt: "2026-06-13T13:12:31Z",
      },
    });
  });

  it("summarizes non-JSON backend failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>challenge ".repeat(80), {
      status: 403,
      statusText: "Forbidden",
    }));

    await expect(fetchCodexRateLimitResetCredits({
      accessToken: "access-token",
      chatgptAccountId: "chatgpt-account",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({
      name: "CodexRateLimitResetError",
      status: 403,
    } satisfies Partial<CodexRateLimitResetError>);
  });
});
