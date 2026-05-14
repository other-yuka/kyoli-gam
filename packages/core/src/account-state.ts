import type { AccountRecord } from "./accounts";

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
  return hasUnrecoveredRateLimitBlock(account, now);
}

export function isCurrentlyAuthCoolingDown(account: AccountRecord, now = Date.now()): boolean {
  const cooldownUntil = readIsoMs(account.authCooldownUntil);
  return cooldownUntil !== undefined && cooldownUntil > now;
}

export function shouldRecoverRateLimitBlock(account: AccountRecord, now = Date.now()): boolean {
  if (!account.rateLimitBlockedAt && !account.rateLimitResetAt) return false;
  if (account.reauthRequiredReason || isCurrentlyAuthCoolingDown(account, now)) return false;

  const resetAt = readIsoMs(account.rateLimitResetAt);
  if (resetAt !== undefined && resetAt <= now) return true;

  return hasFreshAvailableUsageAfterBlock(account);
}

export function readRateLimitRetryAt(account: AccountRecord): string | undefined {
  return account.rateLimitResetAt ?? account.rateLimitCooldownUntil;
}

function hasUnrecoveredRateLimitBlock(account: AccountRecord, now: number): boolean {
  if (!account.rateLimitBlockedAt) return false;
  if (account.lastFailureClass !== "rate_limit" && account.lastFailureClass !== "quota") return false;
  if (hasFreshAvailableUsageAfterBlock(account)) return false;

  const cooldownUntil = readIsoMs(account.rateLimitCooldownUntil);
  if (cooldownUntil !== undefined && cooldownUntil > now) return true;
  return !account.rateLimitResetAt;
}

function hasFreshAvailableUsageAfterBlock(account: AccountRecord): boolean {
  const blockedAt = readIsoMs(account.rateLimitBlockedAt);
  if (blockedAt === undefined) return false;

  const cachedUsageAt = readNumber(account.metadata.cachedUsageAt);
  if (!cachedUsageAt || cachedUsageAt <= blockedAt) return false;

  const usage = readRecord(account.metadata.cachedUsage) ?? readRecord(account.metadata.usage);
  if (!usage) return false;

  const keys = account.lastFailureClass === "quota"
    ? readQuotaUsageWindowKeys(usage)
    : ["five_hour", "primary"];
  const windows = keys
    .map((key) => readRecord(usage[key]))
    .filter((window): window is Record<string, unknown> => Boolean(window));
  if (windows.length === 0) return false;

  return windows.some((window) => {
    const utilization = readUsagePercent(window);
    return utilization !== undefined && utilization < 100;
  });
}

function readQuotaUsageWindowKeys(usage: Record<string, unknown>): string[] {
  const keys = Object.keys(usage).filter((key) => key === "seven_day" || key.startsWith("seven_day_"));
  for (const key of ["secondary", "credits"]) {
    if (Object.prototype.hasOwnProperty.call(usage, key)) keys.push(key);
  }
  return keys;
}

function readUsagePercent(window: Record<string, unknown>): number | undefined {
  const raw = readNumber(window.utilization) ?? readNumber(window.used_percent) ?? readNumber(window.usedPercent);
  if (raw === undefined) return undefined;
  return raw <= 1 ? raw * 100 : raw;
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
