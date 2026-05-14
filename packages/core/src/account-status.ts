import type { AccountRecord } from "./accounts";
import {
  isCurrentlyAuthCoolingDown,
  isCurrentlyRateLimited,
  readAccountAvailabilityState,
  readRateLimitRetryAt,
  shouldRecoverRateLimitBlock,
} from "./account-state";
import type { ProviderId } from "./index";

export interface AccountStatusRow {
  provider: ProviderId;
  total: number;
  ready: number;
  rateLimited: number;
  quotaExceeded: number;
  authCooldown: number;
  disabled: number;
  reauthRequired: number;
  failed: number;
  nextResetAt?: string;
  nextAuthRetryAt?: string;
}

export interface RateLimitedAccountRow {
  id: string;
  provider: ProviderId;
  resetAt?: string;
  retryAt?: string;
  blockedAt?: string;
  resetIn?: string;
  failureCount: number;
  failureClass?: string;
  failureCode?: string;
  lastErrorAt?: string;
  name: string;
}

export interface ReadyAccountRow {
  id: string;
  provider: ProviderId;
  name: string;
  planTier?: string;
  lastUsedAt?: string;
  failureCount: number;
}

export interface BlockedAccountRow {
  id: string;
  provider: ProviderId;
  state: "disabled" | "reauth_required" | "auth_cooldown";
  reason: string;
  name: string;
  retryAt?: string;
  consecutiveAuthFailures?: number;
}

export interface FailedAccountRow {
  id: string;
  provider: ProviderId;
  state: "ready" | "rate-limited" | "quota-exceeded" | "auth-cooldown" | "disabled" | "reauth_required";
  failureCount: number;
  lastErrorAt?: string;
  resetAt?: string;
  authRetryAt?: string;
  name: string;
}

export function summarizeAccountStatus(accounts: AccountRecord[]): AccountStatusRow[] {
  const summaries = new Map<ProviderId, AccountStatusRow>();

  for (const account of accounts) {
    const summary = summaries.get(account.provider) ?? {
      provider: account.provider,
      total: 0,
      ready: 0,
      rateLimited: 0,
      quotaExceeded: 0,
      authCooldown: 0,
      disabled: 0,
      reauthRequired: 0,
      failed: 0,
    };

    summary.total += 1;
    if (account.reauthRequiredReason) {
      summary.reauthRequired += 1;
    } else if (!account.enabled) {
      summary.disabled += 1;
    } else if (isCurrentlyAuthCoolingDown(account)) {
      summary.authCooldown += 1;
      summary.nextAuthRetryAt = earlierIso(summary.nextAuthRetryAt, account.authCooldownUntil);
    } else if (isCurrentlyRateLimited(account)) {
      if (account.lastFailureClass === "quota") summary.quotaExceeded += 1;
      else summary.rateLimited += 1;
      summary.nextResetAt = earlierIso(summary.nextResetAt, readRateLimitRetryAt(account));
    } else {
      summary.ready += 1;
    }

    if (account.failureCount > 0 || account.lastErrorAt) {
      summary.failed += 1;
    }

    summaries.set(account.provider, summary);
  }

  return [...summaries.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

export function listRateLimitedAccounts(accounts: AccountRecord[]): RateLimitedAccountRow[] {
  return accounts
    .filter((account) =>
      account.enabled &&
      !account.reauthRequiredReason &&
      !isCurrentlyAuthCoolingDown(account) &&
      isCurrentlyRateLimited(account)
    )
    .map((account) => {
      const retryAt = readRateLimitRetryAt(account);
      return {
        id: account.id,
        provider: account.provider,
        resetAt: account.rateLimitResetAt,
        retryAt,
        blockedAt: account.rateLimitBlockedAt,
        resetIn: retryAt ? formatRelativeFuture(retryAt) : undefined,
        failureCount: account.failureCount,
        failureClass: account.lastFailureClass,
        failureCode: account.lastFailureCode,
        lastErrorAt: account.lastErrorAt,
        name: account.name,
      };
    })
    .sort((a, b) =>
      (a.retryAt ?? a.resetAt ?? a.blockedAt ?? "").localeCompare(b.retryAt ?? b.resetAt ?? b.blockedAt ?? "")
    );
}

export function listReadyAccounts(accounts: AccountRecord[]): ReadyAccountRow[] {
  return accounts
    .filter((account) =>
      account.enabled &&
      account.kind === "oauth" &&
      !account.reauthRequiredReason &&
      !isCurrentlyRateLimited(account) &&
      !isCurrentlyAuthCoolingDown(account)
    )
    .map((account) => ({
      id: account.id,
      provider: account.provider,
      name: account.name,
      planTier: readString(account.metadata.planTier),
      lastUsedAt: account.lastUsedAt,
      failureCount: account.failureCount,
    }))
    .sort((a, b) =>
      a.provider.localeCompare(b.provider) ||
      (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? "") ||
      a.name.localeCompare(b.name)
    );
}

export function listBlockedAccounts(accounts: AccountRecord[]): BlockedAccountRow[] {
  return accounts
    .filter((account) =>
      !account.enabled || Boolean(account.reauthRequiredReason) || isCurrentlyAuthCoolingDown(account)
    )
    .map((account) => ({
      id: account.id,
      provider: account.provider,
      state: readBlockedAccountState(account),
      reason: account.reauthRequiredReason ??
        (isCurrentlyAuthCoolingDown(account)
          ? `temporary auth failure cooldown (${formatRelativeFuture(account.authCooldownUntil!)} remaining)`
          : "manually disabled"),
      name: account.name,
      retryAt: account.authCooldownUntil,
      consecutiveAuthFailures: account.consecutiveAuthFailures,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

export function listFailedAccounts(accounts: AccountRecord[]): FailedAccountRow[] {
  return accounts
    .filter((account) => account.failureCount > 0 || Boolean(account.lastErrorAt))
    .map((account) => ({
      id: account.id,
      provider: account.provider,
      state: readAccountState(account),
      failureCount: account.failureCount,
      lastErrorAt: account.lastErrorAt,
      resetAt: account.rateLimitResetAt,
      authRetryAt: account.authCooldownUntil,
      name: account.name,
    }))
    .sort((a, b) => {
      const left = a.lastErrorAt ?? "";
      const right = b.lastErrorAt ?? "";
      return right.localeCompare(left);
    });
}

export function listExpiredRateLimitAccounts(accounts: AccountRecord[]): AccountRecord[] {
  const now = Date.now();
  return accounts
    .filter((account) => shouldRecoverRateLimitBlock(account, now))
    .sort((a, b) =>
      (readRateLimitRetryAt(a) ?? a.rateLimitBlockedAt ?? "").localeCompare(
        readRateLimitRetryAt(b) ?? b.rateLimitBlockedAt ?? "",
      )
    );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readAccountState(account: AccountRecord): FailedAccountRow["state"] {
  return readAccountAvailabilityState(account);
}

function readBlockedAccountState(account: AccountRecord): BlockedAccountRow["state"] {
  if (account.reauthRequiredReason) return "reauth_required";
  if (!account.enabled) return "disabled";
  return "auth_cooldown";
}

function earlierIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!right) return left;
  if (!left) return right;
  return new Date(right).getTime() < new Date(left).getTime() ? right : left;
}

function formatRelativeFuture(value: string): string {
  const diffMs = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return value;
  if (diffMs <= 0) return "now";
  if (diffMs < 60_000) return `${Math.ceil(diffMs / 1000)}s`;
  if (diffMs < 60 * 60_000) return `${Math.ceil(diffMs / 60_000)}m`;
  if (diffMs < 24 * 60 * 60_000) return `${Math.ceil(diffMs / (60 * 60_000))}h`;
  return `${Math.ceil(diffMs / (24 * 60 * 60_000))}d`;
}
