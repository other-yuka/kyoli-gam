export interface QuotaRoutingWindow {
  key: string;
  utilization?: number | null;
  resetAt?: string | null;
  windowMs?: number;
}

export interface QuotaResetPaceOptions {
  now?: number;
  targetAtResetPercent?: number;
}

const DEFAULT_TARGET_AT_RESET_PERCENT = 90;
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function scoreQuotaResetPace(
  windows: QuotaRoutingWindow[],
  options: QuotaResetPaceOptions = {},
): number {
  const scores = windows
    .map((window) => scoreQuotaWindowResetPace(window, options))
    .filter((score): score is number => score !== undefined);

  return scores.length > 0 ? Math.min(...scores) : 0;
}

function scoreQuotaWindowResetPace(
  window: QuotaRoutingWindow,
  options: QuotaResetPaceOptions,
): number | undefined {
  const utilization = readPercent(window.utilization);
  const resetAt = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
  const windowMs = window.windowMs ?? inferQuotaWindowMs(window.key);
  if (utilization === undefined || !windowMs || !Number.isFinite(resetAt)) return undefined;

  const now = options.now ?? Date.now();
  const resetInMs = Math.max(0, resetAt - now);
  const elapsedRatio = clampRatio(1 - resetInMs / windowMs);
  const targetAtResetPercent = options.targetAtResetPercent ?? DEFAULT_TARGET_AT_RESET_PERCENT;
  const targetUtilization = targetAtResetPercent * elapsedRatio;
  const slack = targetUtilization - utilization;

  return slack >= 0
    ? Math.min(120, slack * 3)
    : Math.max(-160, slack * 4);
}

function inferQuotaWindowMs(key: string): number | undefined {
  if (key === "five_hour") return FIVE_HOUR_WINDOW_MS;
  if (key === "seven_day" || key.startsWith("seven_day_")) return SEVEN_DAY_WINDOW_MS;
  return undefined;
}

function readPercent(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : undefined;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
