import type { ManagedAccount, PluginClient, PluginConfig, UsageLimits } from "./types";

const USAGE_FETCH_COOLDOWN_MS = 30_000;

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

  function getResetMsFromUsage(account: ManagedAccount): number | null {
    const usage = account.cachedUsage;
    if (!usage) return null;

    const now = Date.now();
    const candidates: number[] = [];

    if (usage.five_hour?.resets_at) {
      const ms = Date.parse(usage.five_hour.resets_at) - now;
      if (ms > 0) candidates.push(ms);
    }
    if (usage.seven_day?.resets_at) {
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

    const resetMs = getResetMsFromUsage(account) ?? retryAfterMsFromResponse(response);
    await manager.markRateLimited(account.uuid, resetMs);

    const shouldFetchUsage = account.accessToken
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
