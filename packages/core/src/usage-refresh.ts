import type {
  AccountRecord,
  AccountStore,
} from "./accounts";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderUsageRefreshResult,
} from "./index";

export interface UsageRefreshServiceOptions {
  accounts: AccountStore;
  providers: ProviderAdapter[];
  intervalMs?: number;
  authFailureCooldownMs?: number;
  onError?: (event: UsageRefreshErrorEvent) => void;
}

export interface UsageRefreshErrorEvent {
  accountId: string;
  provider: ProviderId;
  message: string;
  status?: number;
}

export interface UsageRefreshRunResult {
  checked: number;
  refreshed: number;
  skipped: number;
  failed: number;
}

const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_AUTH_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export class UsageRefreshService {
  private readonly providersById: Map<ProviderId, ProviderAdapter>;
  private readonly intervalMs: number;
  private readonly authFailureCooldownMs: number;
  private readonly cooldownUntilByAccount = new Map<string, number>();
  private readonly inFlightByAccount = new Map<string, Promise<boolean>>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;

  constructor(private readonly options: UsageRefreshServiceOptions) {
    this.providersById = new Map(
      options.providers
        .filter((provider) => provider.refreshUsage)
        .map((provider) => [provider.id, provider]),
    );
    this.intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_USAGE_REFRESH_INTERVAL_MS);
    this.authFailureCooldownMs = Math.max(
      0,
      options.authFailureCooldownMs ?? DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
    );
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refreshOnce().finally(() => this.scheduleNext());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async refreshOnce(options: { force?: boolean } = {}): Promise<UsageRefreshRunResult> {
    const result: UsageRefreshRunResult = {
      checked: 0,
      refreshed: 0,
      skipped: 0,
      failed: 0,
    };

    for (const provider of this.providersById.values()) {
      const accounts = await this.options.accounts.listByProvider(provider.id);
      for (const account of accounts) {
        result.checked += 1;
        if (!this.shouldRefresh(account, options.force ?? false)) {
          result.skipped += 1;
          continue;
        }
        const ok = await this.refreshAccount(provider, account);
        if (ok) result.refreshed += 1;
        else result.failed += 1;
      }
    }

    return result;
  }

  async refreshAccountById(accountId: string, options: { force?: boolean } = {}): Promise<boolean> {
    const account = await this.options.accounts.get(accountId);
    if (!account) return false;
    const provider = this.providersById.get(account.provider);
    if (!provider?.refreshUsage) return false;
    if (!this.shouldRefresh(account, options.force ?? false)) return false;
    return this.refreshAccount(provider, account);
  }

  private scheduleNext(): void {
    if (this.stopped || this.intervalMs <= 0) return;
    this.timer = setTimeout(() => {
      void this.refreshOnce().finally(() => this.scheduleNext());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private shouldRefresh(account: AccountRecord, force: boolean): boolean {
    if (!this.providersById.has(account.provider)) return false;
    if (!account.enabled || account.reauthRequiredReason) return false;
    const cooldownUntil = this.cooldownUntilByAccount.get(account.id);
    if (!force && cooldownUntil && cooldownUntil > Date.now()) return false;
    if (force) return true;
    if (this.intervalMs === 0) return true;

    const cachedUsageAt = readNumber(account.metadata.cachedUsageAt ?? account.metadata.usageCachedAt);
    if (!cachedUsageAt) return true;
    return Date.now() - cachedUsageAt > this.intervalMs;
  }

  private async refreshAccount(provider: ProviderAdapter, account: AccountRecord): Promise<boolean> {
    const current = this.inFlightByAccount.get(account.id);
    if (current) return current;

    const task = this.runAccountRefresh(provider, account)
      .finally(() => {
        if (this.inFlightByAccount.get(account.id) === task) {
          this.inFlightByAccount.delete(account.id);
        }
      });
    this.inFlightByAccount.set(account.id, task);
    return task;
  }

  private async runAccountRefresh(provider: ProviderAdapter, account: AccountRecord): Promise<boolean> {
    try {
      const refresh = provider.refreshUsage;
      if (!refresh) return false;
      const refreshed = await refresh({ account });
      if (!refreshed.ok) {
        await this.handleRefreshFailure(account, refreshed);
        return false;
      }

      const nextMetadata = refreshed.metadata
        ? { ...account.metadata, ...refreshed.metadata }
        : account.metadata;
      const nextCredentials = refreshed.credentials
        ? { ...account.credentials, ...refreshed.credentials }
        : account.credentials;
      const updated = await this.options.accounts.update(account.id, {
        credentials: nextCredentials,
        metadata: nextMetadata,
      });

      if (updated && shouldRecoverAccountState(updated)) {
        await this.options.accounts.resetState(updated.id);
      }
      this.cooldownUntilByAccount.delete(account.id);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onError?.({ accountId: account.id, provider: account.provider, message });
      return false;
    }
  }

  private async handleRefreshFailure(
    account: AccountRecord,
    failure: Extract<ProviderUsageRefreshResult, { ok: false }>,
  ): Promise<void> {
    if (failure.status === 401 || failure.status === 403 || failure.reauthRequiredReason) {
      this.cooldownUntilByAccount.set(account.id, Date.now() + this.authFailureCooldownMs);
    }
    if (failure.reauthRequiredReason) {
      await this.options.accounts.recordFailure(account.id, {
        status: failure.status ?? 401,
        message: failure.message,
        reauthRequiredReason: failure.reauthRequiredReason,
        failureClass: "auth",
        failureCode: "usage_refresh_failed",
        failurePhase: "startup",
      });
    }
    this.options.onError?.({
      accountId: account.id,
      provider: account.provider,
      status: failure.status,
      message: failure.message,
    });
  }
}

function shouldRecoverAccountState(account: AccountRecord): boolean {
  if (!account.rateLimitResetAt && !account.rateLimitCooldownUntil && account.lastFailureClass !== "quota") {
    return false;
  }
  return hasNoExhaustedUsageWindow(account.metadata.cachedUsage) ||
    hasNoExhaustedUsageWindow(account.metadata.usage);
}

function hasNoExhaustedUsageWindow(value: unknown): boolean {
  const usage = readRecord(value);
  if (!usage) return false;
  const windows = [
    usage.five_hour,
    usage.seven_day,
    ...Object.entries(usage)
      .filter(([key]) => key.startsWith("seven_day_"))
      .map(([, window]) => window),
  ].map((window) => readNumber(readRecord(window)?.utilization))
    .filter((utilization): utilization is number => utilization !== undefined);
  return windows.length > 0 && windows.every((utilization) => utilization < 100);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}
