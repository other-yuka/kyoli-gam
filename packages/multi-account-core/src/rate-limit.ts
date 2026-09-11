import { isQuotaWindowActive, normalizeUsagePercent } from "./routing";
import type { ManagedAccount, PluginClient, PluginConfig, UsageLimits } from "./types";

const USAGE_FETCH_COOLDOWN_MS = 30_000;
const NON_SUBSCRIPTION_BILLING_BACKOFF_MS = 24 * 60 * 60 * 1000;

export interface RateLimitDependencies {
  fetchUsage: (accessToken: string, accountId?: string) => Promise<{ ok: true; data: UsageLimits } | { ok: false; reason: string }>;
  getConfig: () => Pick<PluginConfig, "default_retry_after_ms">;
  formatWaitTime: (ms: number) => string;
  getAccountLabel: (account: ManagedAccount) => string;
  showToast: (
    client: PluginClient,
    message: string,
    variant: "info" | "warning" | "success" | "error",
  ) => Promise<void>;
}

export interface RateLimitAccountManager {
  markRateLimited(uuid: string, backoffMs?: number): Promise<void>;
  applyUsageCache(uuid: string, usage: UsageLimits): Promise<void>;
  getAccountCount(): number;
}

export function createRateLimitHandlers(dependencies: RateLimitDependencies) {
  const {
    fetchUsage,
    getConfig,
    formatWaitTime,
    getAccountLabel,
    showToast,
  } = dependencies;

  function retryAfterMsFromResponse(response: Response): number {
    const retryAfterMs = response.headers.get("retry-after-ms");
    if (retryAfterMs) {
      const parsed = parseInt(retryAfterMs, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }

    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed * 1000;
    }

    return getConfig().default_retry_after_ms;
  }

  function isNonSubscriptionBillingClaim(claim: string | null): claim is string {
    if (!claim || claim === "unknown") return false;
    const normalized = claim.toLowerCase();
    return normalized === "api"
      || normalized.startsWith("api_")
      || normalized === "overage"
      || normalized.startsWith("overage_")
      || normalized.includes("credit")
      || normalized.startsWith("sdk");
  }

  function hasNonExhaustedClaudeQuota(response: Response): boolean {
    const utilizationHeaders = [...response.headers.entries()]
      .filter(([name]) => name.startsWith("anthropic-ratelimit-unified-") && name.endsWith("-utilization"));
    if (utilizationHeaders.length === 0) return false;

    const claim = response.headers.get("anthropic-ratelimit-unified-representative-claim")?.toLowerCase();
    if (claim && claim !== "unknown") {
      const claimedHeader = claim === "five_hour"
        ? "anthropic-ratelimit-unified-5h-utilization"
        : claim === "seven_day"
          ? "anthropic-ratelimit-unified-7d-utilization"
          : claim.startsWith("seven_day_")
            ? `anthropic-ratelimit-unified-7d_${claim.slice("seven_day_".length)}-utilization`
            : undefined;
      if (claimedHeader) {
        const claimed = readClaudeUtilization(response.headers.get(claimedHeader));
        return claimed !== undefined && claimed < 100;
      }
    }

    const utilizations = utilizationHeaders.map(([, value]) => readClaudeUtilization(value));
    if (utilizations.some((value) => value === undefined)) return false;
    return utilizations.length > 0 && utilizations.every((value) => value !== undefined && value < 100);
  }

  function readClaudeUtilization(value: string | null): number | undefined {
    if (value == null || value.trim() === "") return undefined;
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return undefined;
    return parsed <= 1 ? parsed * 100 : parsed;
  }

  function getResetMsFromUsage(account: ManagedAccount): number | null {
    const usage = account.cachedUsage;
    if (!usage) return null;

    const now = Date.now();
    const candidates: number[] = [];

    if (usage.five_hour?.resets_at && normalizeUsagePercent(usage.five_hour.utilization) === 100 && isQuotaWindowActive(usage.five_hour.resets_at, now)) {
      const ms = Date.parse(usage.five_hour.resets_at) - now;
      if (ms > 0) candidates.push(ms);
    }
    if (usage.seven_day?.resets_at && normalizeUsagePercent(usage.seven_day.utilization) === 100 && isQuotaWindowActive(usage.seven_day.resets_at, now)) {
      const ms = Date.parse(usage.seven_day.resets_at) - now;
      if (ms > 0) candidates.push(ms);
    }

    return candidates.length > 0 ? Math.min(...candidates) : null;
  }

  async function fetchUsageLimits(accessToken: string, accountId?: string): Promise<UsageLimits | null> {
    if (!accessToken) return null;
    try {
      const result = await fetchUsage(accessToken, accountId);
      return result.ok ? result.data : null;
    } catch {
      return null;
    }
  }

  async function handleRateLimitResponse(
    manager: RateLimitAccountManager,
    client: PluginClient,
    account: ManagedAccount,
    response: Response,
  ): Promise<void> {
    if (!account.uuid) return;

    const nonSubscriptionClaim = response.headers.get("anthropic-ratelimit-unified-representative-claim");
    const shouldQuarantineBillingClaim = isNonSubscriptionBillingClaim(nonSubscriptionClaim);
    const hasNonExhaustedQuota = hasNonExhaustedClaudeQuota(response);
    const resetMs = shouldQuarantineBillingClaim
      ? Math.max(retryAfterMsFromResponse(response), NON_SUBSCRIPTION_BILLING_BACKOFF_MS)
      : hasNonExhaustedQuota
        ? retryAfterMsFromResponse(response)
        : getResetMsFromUsage(account) ?? retryAfterMsFromResponse(response);
    await manager.markRateLimited(account.uuid, resetMs);

    if (shouldQuarantineBillingClaim) {
      if (manager.getAccountCount() > 1) {
        void showToast(
          client,
          `${getAccountLabel(account)} blocked non-subscription billing claim (${nonSubscriptionClaim}). Switching...`,
          "warning",
        );
      }
      return;
    }

    const shouldFetchUsage = !hasNonExhaustedQuota && account.accessToken
      && (!account.cachedUsageAt || Date.now() - account.cachedUsageAt > USAGE_FETCH_COOLDOWN_MS);

    if (shouldFetchUsage) {
      const usage = await fetchUsageLimits(account.accessToken!, account.accountId);
      if (usage) {
        await manager.applyUsageCache(account.uuid, usage);
      }
    }

    if (manager.getAccountCount() > 1) {
      void showToast(
        client,
        `${getAccountLabel(account)} rate-limited (resets in ${formatWaitTime(resetMs)}). Switching...`,
        "warning",
      );
    }
  }

  return {
    retryAfterMsFromResponse,
    getResetMsFromUsage,
    fetchUsageLimits,
    handleRateLimitResponse,
  };
}
