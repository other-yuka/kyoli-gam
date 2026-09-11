import type { AccountRecord } from "./accounts";
import {
  isQuotaWindowActive,
  normalizeUsagePercent,
} from "opencode-multi-account-core";

export type AccountAvailabilityState =
  | "ready"
  | "rate-limited"
  | "quota-exceeded"
  | "auth-cooldown"
  | "disabled"
  | "reauth_required";

export function readAccountAvailabilityState(account: AccountRecord, now = Date.now()): AccountAvailabilityState {
  if (account.reauthRequiredReason) return "reauth_required";
  if (!account.enabled) return "disabled";
  if (isCurrentlyAuthCoolingDown(account, now)) return "auth-cooldown";
  if (isCurrentlyRateLimited(account, now)) {
    return account.lastFailureClass === "quota" ? "quota-exceeded" : "rate-limited";
  }
  return "ready";
}

export function isCurrentlyRateLimited(account: AccountRecord, now = Date.now()): boolean {
  const resetAt = readIsoMs(account.rateLimitResetAt);
  if (resetAt !== undefined && resetAt > now) return true;
  if (isCurrentlyRateLimitCoolingDown(account, now)) return true;
  return hasUnrecoveredRateLimitBlock(account, now);
}

export function isCurrentlyAuthCoolingDown(account: AccountRecord, now = Date.now()): boolean {
  const cooldownUntil = readIsoMs(account.authCooldownUntil);
  return cooldownUntil !== undefined && cooldownUntil > now;
}

export function isCurrentlyRateLimitCoolingDown(account: AccountRecord, now = Date.now()): boolean {
  const cooldownUntil = readIsoMs(account.rateLimitCooldownUntil);
  return cooldownUntil !== undefined && cooldownUntil > now;
}

export function shouldRecoverRateLimitBlock(account: AccountRecord, now = Date.now()): boolean {
  if (!account.rateLimitBlockedAt && !account.rateLimitResetAt) return false;
  if (account.reauthRequiredReason || isCurrentlyAuthCoolingDown(account, now)) return false;
  if (isCurrentlyRateLimitCoolingDown(account, now)) return false;
  if (readUsageRateLimitBoundary(account.metadata, now) !== "") return false;

  const resetAt = readIsoMs(account.rateLimitResetAt);
  if (resetAt !== undefined && resetAt <= now) return true;
  const cooldownUntil = readIsoMs(account.rateLimitCooldownUntil);
  if (
    cooldownUntil !== undefined
    && cooldownUntil <= now
    && resetAt === undefined
  ) return true;

  return hasFreshAvailableUsageAfterBlock(account, now);
}

export function shouldRecoverRateLimitStateAfterUsage(
  account: AccountRecord,
  now = Date.now(),
): boolean {
  if (!account.rateLimitResetAt && !account.rateLimitCooldownUntil && account.lastFailureClass !== "quota") {
    return false;
  }
  if (isCurrentlyRateLimitCoolingDown(account, now)) return false;
  const blockedAt = readIsoMs(account.rateLimitBlockedAt);
  const usageSnapshot = readLatestUsageSnapshot(account.metadata);
  if (blockedAt === undefined || !usageSnapshot || usageSnapshot.observedAt <= blockedAt) return false;
  return hasNoExhaustedUsageWindow(usageSnapshot.usage, now);
}

export function readUsageRateLimitBoundary(
  metadata: Record<string, unknown>,
  now = Date.now(),
): string {
  const latestSnapshot = readLatestUsageSnapshot(metadata);
  const usageSnapshots = latestSnapshot
    ? [latestSnapshot.usage]
    : [readRecord(metadata.cachedUsage), readRecord(metadata.usage)]
      .filter((usage): usage is Record<string, unknown> => Boolean(usage));

  return [...new Set(usageSnapshots.flatMap((usage) =>
    Object.entries(usage)
      .filter(([key]) => isAccountWideUsageWindowKey(key))
      .flatMap(([key, value]) => {
        const window = readRecord(value);
        if (!window || readUsagePercent(window) !== 100) return [];
        const resetAt = readUsageWindowResetAt(window);
        if (!resetAt || !isQuotaWindowActive(resetAt, now)) return [];
        return [`${key}:${resetAt}`];
      }),
  ))].sort().join("|");
}

export function readRateLimitRetryAt(account: AccountRecord): string | undefined {
  const candidates = [account.rateLimitResetAt, account.rateLimitCooldownUntil]
    .map((value) => ({ value, timestamp: readIsoMs(value) }))
    .filter((candidate): candidate is { value: string; timestamp: number } =>
      candidate.value !== undefined && candidate.timestamp !== undefined
    )
    .sort((left, right) => right.timestamp - left.timestamp);
  return candidates[0]?.value;
}

function hasUnrecoveredRateLimitBlock(account: AccountRecord, now: number): boolean {
  if (!account.rateLimitBlockedAt) return false;
  if (account.lastFailureClass !== "rate_limit" && account.lastFailureClass !== "quota") return false;
  const cooldownUntil = readIsoMs(account.rateLimitCooldownUntil);
  if (cooldownUntil !== undefined && cooldownUntil > now) return true;
  if (readUsageRateLimitBoundary(account.metadata, now) !== "") return true;
  if (cooldownUntil !== undefined) return false;
  if (hasFreshAvailableUsageAfterBlock(account, now)) return false;
  return !account.rateLimitResetAt;
}

function hasFreshAvailableUsageAfterBlock(account: AccountRecord, now: number): boolean {
  const blockedAt = readIsoMs(account.rateLimitBlockedAt);
  if (blockedAt === undefined) return false;

  const usageSnapshot = readLatestUsageSnapshot(account.metadata);
  if (!usageSnapshot || usageSnapshot.observedAt <= blockedAt) return false;
  const { usage } = usageSnapshot;

  const keys = account.lastFailureClass === "quota"
    ? readQuotaUsageWindowKeys(usage)
    : ["five_hour", "primary"];
  const windows = keys
    .map((key) => readRecord(usage[key]))
    .filter((window): window is Record<string, unknown> => Boolean(window));
  if (windows.length === 0) return false;

  return windows.some((window) => {
    const utilization = readUsagePercent(window);
    if (utilization === undefined) return false;
    const resetAt = readUsageWindowResetAt(window);
    return (resetAt != null && !isQuotaWindowActive(resetAt, now)) || utilization < 100;
  });
}

function readLatestUsageSnapshot(
  metadata: Record<string, unknown>,
): { usage: Record<string, unknown>; observedAt: number } | undefined {
  const cachedUsage = readRecord(metadata.cachedUsage);
  const cachedUsageAt = readNumber(metadata.cachedUsageAt);
  const legacyUsage = readRecord(metadata.usage);
  const legacyUsageAt = readNumber(metadata.usageCachedAt);
  if (cachedUsage && cachedUsageAt === undefined) return undefined;
  const cachedSnapshot = cachedUsage && cachedUsageAt !== undefined
    ? { usage: cachedUsage, observedAt: cachedUsageAt }
    : undefined;
  const legacySnapshot = legacyUsage && legacyUsageAt !== undefined
    ? { usage: legacyUsage, observedAt: legacyUsageAt }
    : undefined;

  if (!cachedSnapshot) return legacySnapshot;
  if (!legacySnapshot || cachedSnapshot.observedAt >= legacySnapshot.observedAt) return cachedSnapshot;
  return legacySnapshot;
}

function readQuotaUsageWindowKeys(usage: Record<string, unknown>): string[] {
  return Object.keys(usage).filter((key) =>
    isAccountWideUsageWindowKey(key)
    && key !== "five_hour"
    && key !== "primary"
  );
}

function isAccountWideUsageWindowKey(key: string): boolean {
  return key === "five_hour"
    || key === "primary"
    || key === "seven_day"
    || key.startsWith("seven_day_")
    || key === "secondary"
    || key === "credits";
}

function readUsagePercent(window: Record<string, unknown>): number | undefined {
  const raw = readNumber(window.utilization) ?? readNumber(window.used_percent) ?? readNumber(window.usedPercent);
  if (raw === undefined) return undefined;
  return normalizeUsagePercent(raw);
}

function hasNoExhaustedUsageWindow(value: unknown, now: number): boolean {
  const usage = readRecord(value);
  if (!usage) return false;
  const windows = [
    usage.five_hour,
    usage.seven_day,
    ...Object.entries(usage)
      .filter(([key]) => key.startsWith("seven_day_"))
      .map(([, window]) => window),
  ].map((window) => {
    const record = readRecord(window);
    return {
      utilization: readUsagePercent(record ?? {}),
      resetAt: readUsageWindowResetAt(record),
    };
  }).filter((window): window is { utilization: number; resetAt: string | undefined } =>
    window.utilization !== undefined
  );
  return windows.length > 0 && windows.every((window) =>
    window.utilization < 100
    || (window.resetAt != null && !isQuotaWindowActive(window.resetAt, now))
  );
}

function readUsageWindowResetAt(window: Record<string, unknown> | undefined): string | undefined {
  if (!window) return undefined;
  return readString(window.reset_at)
    ?? readString(window.resetAt)
    ?? readString(window.resets_at)
    ?? readString(window.resetsAt);
}

function readIsoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
