export interface PacingConfig {
  minGapMs: number;
  jitterMs: number;
}

function pickNonNegativeInt(...values: (number | string | undefined)[]): number | undefined {
  for (const v of values) {
    if (v === undefined) continue;
    const n = typeof v === "number" ? v : Number.parseInt(v, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

export function computePacingDelay(
  now: number,
  lastRequestTime: number,
  cfg: PacingConfig,
  rng: () => number = Math.random,
): number {
  if (lastRequestTime <= 0) return 0;
  const minGap = Math.max(0, cfg.minGapMs);
  const jitter = Math.max(0, cfg.jitterMs);
  const jitterAdd = jitter > 0 ? Math.floor(rng() * jitter) : 0;
  const effectiveGap = minGap + jitterAdd;
  const elapsed = now - lastRequestTime;
  if (elapsed >= effectiveGap) return 0;
  return effectiveGap - elapsed;
}

export function resolvePacingConfig(
  explicit: { minGapMs?: number; jitterMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): PacingConfig {
  const minGap = pickNonNegativeInt(explicit.minGapMs, env.ANTHROPIC_PACE_MIN_MS, env.MIN_REQUEST_INTERVAL_MS) ?? 500;
  const jitter = pickNonNegativeInt(explicit.jitterMs, env.ANTHROPIC_PACE_JITTER_MS) ?? 0;
  return { minGapMs: minGap, jitterMs: jitter };
}
