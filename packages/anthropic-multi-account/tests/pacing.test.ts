import { afterEach, describe, expect, test } from "bun:test";
import { computePacingDelay, resolvePacingConfig } from "../src/pacing";

afterEach(() => {
  delete process.env.ANTHROPIC_PACE_MIN_MS;
  delete process.env.ANTHROPIC_PACE_JITTER_MS;
  delete process.env.MIN_REQUEST_INTERVAL_MS;
});

describe("computePacingDelay", () => {
  test("first request — no delay when lastRequestTime is 0", () => {
    const delay = computePacingDelay(1000, 0, { minGapMs: 500, jitterMs: 0 });
    expect(delay).toBe(0);
  });

  test("within minGap — returns remaining delay", () => {
    const delay = computePacingDelay(1300, 1000, { minGapMs: 500, jitterMs: 0 });
    expect(delay).toBe(200);
  });

  test("past minGap — no delay", () => {
    const delay = computePacingDelay(1600, 1000, { minGapMs: 500, jitterMs: 0 });
    expect(delay).toBe(0);
  });

  test("exactly at minGap boundary — no delay", () => {
    const delay = computePacingDelay(1500, 1000, { minGapMs: 500, jitterMs: 0 });
    expect(delay).toBe(0);
  });

  test("jitter adds randomness to effective gap", () => {
    const delay = computePacingDelay(1000, 999, { minGapMs: 500, jitterMs: 200 }, () => 0.5);
    // effectiveGap = 500 + floor(0.5 * 200) = 600, elapsed = 1 → delay = 599
    expect(delay).toBe(599);
  });

  test("jitter zero rng produces no extra gap", () => {
    const delay = computePacingDelay(1000, 999, { minGapMs: 500, jitterMs: 200 }, () => 0);
    // effectiveGap = 500 + floor(0 * 200) = 500, elapsed = 1 → delay = 499
    expect(delay).toBe(499);
  });

  test("negative lastRequestTime treated as first request", () => {
    const delay = computePacingDelay(1000, -1, { minGapMs: 500, jitterMs: 0 });
    expect(delay).toBe(0);
  });

  test("negative minGapMs clamped to 0", () => {
    const delay = computePacingDelay(1000, 999, { minGapMs: -100, jitterMs: 0 });
    expect(delay).toBe(0);
  });
});

describe("resolvePacingConfig", () => {
  test("defaults to minGapMs=500, jitterMs=0 with no overrides", () => {
    const cfg = resolvePacingConfig();
    expect(cfg).toEqual({ minGapMs: 500, jitterMs: 0 });
  });

  test("explicit values take highest precedence", () => {
    process.env.ANTHROPIC_PACE_MIN_MS = "999";
    const cfg = resolvePacingConfig({ minGapMs: 100, jitterMs: 50 });
    expect(cfg).toEqual({ minGapMs: 100, jitterMs: 50 });
  });

  test("ANTHROPIC_PACE_MIN_MS and ANTHROPIC_PACE_JITTER_MS env override", () => {
    process.env.ANTHROPIC_PACE_MIN_MS = "300";
    process.env.ANTHROPIC_PACE_JITTER_MS = "100";
    const cfg = resolvePacingConfig();
    expect(cfg).toEqual({ minGapMs: 300, jitterMs: 100 });
  });

  test("MIN_REQUEST_INTERVAL_MS fallback for minGapMs", () => {
    process.env.MIN_REQUEST_INTERVAL_MS = "250";
    const cfg = resolvePacingConfig();
    expect(cfg).toEqual({ minGapMs: 250, jitterMs: 0 });
  });

  test("ANTHROPIC_PACE_MIN_MS takes precedence over MIN_REQUEST_INTERVAL_MS", () => {
    process.env.ANTHROPIC_PACE_MIN_MS = "300";
    process.env.MIN_REQUEST_INTERVAL_MS = "250";
    const cfg = resolvePacingConfig();
    expect(cfg).toEqual({ minGapMs: 300, jitterMs: 0 });
  });

  test("invalid env values fall through to defaults", () => {
    process.env.ANTHROPIC_PACE_MIN_MS = "not-a-number";
    process.env.MIN_REQUEST_INTERVAL_MS = "also-invalid";
    const cfg = resolvePacingConfig();
    expect(cfg).toEqual({ minGapMs: 500, jitterMs: 0 });
  });

  test("negative env values fall through to defaults", () => {
    process.env.ANTHROPIC_PACE_MIN_MS = "-10";
    const cfg = resolvePacingConfig();
    expect(cfg).toEqual({ minGapMs: 500, jitterMs: 0 });
  });

  test("custom env object is used instead of process.env", () => {
    const customEnv = { ANTHROPIC_PACE_MIN_MS: "200", ANTHROPIC_PACE_JITTER_MS: "50" };
    const cfg = resolvePacingConfig({}, customEnv as unknown as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ minGapMs: 200, jitterMs: 50 });
  });
});
