import { afterEach, describe, expect, test } from "bun:test";
import {
  enrich429,
  getMinRequestIntervalMs,
  rateGovern,
  resetRateGovernorForTest,
  sanitizeError,
  setRateGovernorTestOverridesForTest,
} from "../src/error-utils";

afterEach(() => {
  delete process.env.MIN_REQUEST_INTERVAL_MS;
  resetRateGovernorForTest();
});

describe("error-utils", () => {
  test("sanitizeError redacts sk-ant tokens, JWTs, and bearer tokens", () => {
    const sanitized = sanitizeError(
      "Failed: sk-ant-abc123-xyz eyJheader.eyJpayload.signature Bearer secret-token",
    );

    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).toContain("[REDACTED_JWT]");
    expect(sanitized).toContain("Bearer [REDACTED]");
    expect(sanitized).not.toContain("sk-ant-");
    expect(sanitized).not.toContain("eyJheader.eyJpayload.signature");
    expect(sanitized).not.toContain("secret-token");
  });

  test("enrich429 upgrades generic rate-limit payloads with header details", () => {
    const nowMs = 1_700_000_000_000;
    setRateGovernorTestOverridesForTest({ now: () => nowMs });

    const enriched = enrich429(
      JSON.stringify({ error: { message: "Error" } }),
      new Headers({
        "anthropic-ratelimit-unified-representative-claim": "workspace",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-5h-utilization": "0.85",
        "anthropic-ratelimit-unified-7d-utilization": "0.40",
        "anthropic-ratelimit-unified-reset": String(Math.floor((nowMs + 30 * 60 * 1000) / 1000)),
      }),
    );

    const parsed = JSON.parse(enriched) as { error?: { message?: string } };

    expect(parsed.error?.message).toContain("Rate limited (rejected)");
    expect(parsed.error?.message).toContain("Limiting window: workspace");
    expect(parsed.error?.message).toContain("5h utilization: 85%");
    expect(parsed.error?.message).toContain("7d utilization: 40%");
    expect(parsed.error?.message).toContain("resets in 30m");
  });

  test("enrich429 leaves non-generic payloads unchanged", () => {
    const original = JSON.stringify({ error: { message: "Already specific" } });

    expect(enrich429(original, new Headers({ "anthropic-ratelimit-unified-status": "rejected" }))).toBe(original);
    expect(enrich429("not-json", new Headers())).toBe("not-json");
  });

  test("getMinRequestIntervalMs uses MIN_REQUEST_INTERVAL_MS env override with default fallback", () => {
    expect(getMinRequestIntervalMs()).toBe(500);

    process.env.MIN_REQUEST_INTERVAL_MS = "250";
    expect(getMinRequestIntervalMs()).toBe(250);

    process.env.MIN_REQUEST_INTERVAL_MS = "invalid";
    expect(getMinRequestIntervalMs()).toBe(500);
  });

  test("rateGovern delays only the second request by the remaining interval", async () => {
    let currentTime = 1_000;
    const sleepCalls: number[] = [];

    setRateGovernorTestOverridesForTest({
      now: () => currentTime,
      minIntervalMs: 500,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        currentTime += ms;
      },
    });

    await rateGovern();
    expect(sleepCalls).toEqual([]);

    currentTime = 1_100;
    await rateGovern();

    expect(sleepCalls).toEqual([400]);
  });
});
