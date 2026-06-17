import { describe, expect, it } from "vitest";
import { scoreQuotaResetPace } from "../src/routing";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-06-18T00:00:00.000Z").getTime();

describe("quota reset-aware routing", () => {
  it("scores a soon-reset under-pace account above a long-reset over-pace account", () => {
    const longResetScore = scoreQuotaResetPace([
      {
        key: "seven_day",
        utilization: 80,
        resetAt: new Date(NOW + 6 * DAY_MS).toISOString(),
      },
    ], { now: NOW });
    const soonResetScore = scoreQuotaResetPace([
      {
        key: "seven_day",
        utilization: 60,
        resetAt: new Date(NOW + 12 * HOUR_MS).toISOString(),
      },
    ], { now: NOW });

    expect(soonResetScore).toBeGreaterThan(longResetScore);
  });

  it("can outweigh lower raw utilization when reset pace is healthier", () => {
    const lowerUsageLongResetScore = scoreQuotaResetPace([
      {
        key: "seven_day",
        utilization: 40,
        resetAt: new Date(NOW + 6 * DAY_MS).toISOString(),
      },
    ], { now: NOW });
    const higherUsageSoonResetScore = scoreQuotaResetPace([
      {
        key: "seven_day",
        utilization: 60,
        resetAt: new Date(NOW + 12 * HOUR_MS).toISOString(),
      },
    ], { now: NOW });

    expect(higherUsageSoonResetScore).toBeGreaterThan(lowerUsageLongResetScore);
  });
});
