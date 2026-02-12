import { AccountStore } from "./account-store";
import type { PluginClient, PluginConfig, StoredAccount, TokenRefreshResult } from "./types";

const INITIAL_DELAY_MS = 5_000;

export interface ProactiveRefreshDependencies {
  getConfig: () => PluginConfig;
  refreshToken: (
    currentRefreshToken: string,
    accountId: string,
    client: PluginClient,
  ) => Promise<TokenRefreshResult>;
  isTokenExpired: (account: Pick<StoredAccount, "accessToken" | "expiresAt">) => boolean;
  debugLog: (client: PluginClient, message: string, extra?: Record<string, unknown>) => void;
}

export interface ProactiveRefreshQueueInstance {
  start(): void;
  stop(): Promise<void>;
}

export interface ProactiveRefreshQueueClass {
  new (
    client: PluginClient,
    store: AccountStore,
    onInvalidate?: (uuid: string) => void,
  ): ProactiveRefreshQueueInstance;
}

export function createProactiveRefreshQueueForProvider(dependencies: ProactiveRefreshDependencies): ProactiveRefreshQueueClass {
  const {
    getConfig,
    refreshToken,
    isTokenExpired,
    debugLog,
  } = dependencies;

  return class ProactiveRefreshQueue {
    private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    private runToken = 0;
    private inFlight: Promise<void> | null = null;

    constructor(
      private readonly client: PluginClient,
      private readonly store: AccountStore,
      private readonly onInvalidate?: (uuid: string) => void,
    ) {}

    start(): void {
      const config = getConfig();
      if (!config.proactive_refresh) return;

      this.runToken++;
      this.scheduleNext(this.runToken, INITIAL_DELAY_MS);

      debugLog(this.client, "Proactive refresh started", {
        intervalSeconds: config.proactive_refresh_interval_seconds,
        bufferSeconds: config.proactive_refresh_buffer_seconds,
      });
    }

    async stop(): Promise<void> {
      this.runToken++;
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = null;
      }
      if (this.inFlight) {
        await this.inFlight;
        this.inFlight = null;
      }
      debugLog(this.client, "Proactive refresh stopped");
    }

    private scheduleNext(token: number, delayMs: number): void {
      this.timeoutHandle = setTimeout(() => {
        if (token !== this.runToken) return;
        this.inFlight = this.runCheck(token).finally(() => {
          this.inFlight = null;
        });
      }, delayMs);
    }

    private needsProactiveRefresh(account: Pick<StoredAccount, "accessToken" | "expiresAt">): boolean {
      if (!account.accessToken || !account.expiresAt) return false;
      if (isTokenExpired(account)) return false;
      const bufferMs = getConfig().proactive_refresh_buffer_seconds * 1000;
      return account.expiresAt <= Date.now() + bufferMs;
    }

    private async runCheck(token: number): Promise<void> {
      try {
        const stored = await this.store.load();
        if (token !== this.runToken) return;

        const candidates = stored.accounts.filter((a) =>
          a.enabled !== false
          && !a.isAuthDisabled
          && a.uuid
          && this.needsProactiveRefresh(a),
        );

        if (candidates.length === 0) return;

        debugLog(this.client, `Proactive refresh: ${candidates.length} account(s) approaching expiry`);

        for (const account of candidates) {
          if (token !== this.runToken) return;

          const credentials = await this.store.readCredentials(account.uuid!);
          if (!credentials || !this.needsProactiveRefresh(credentials)) continue;

          const result = await refreshToken(credentials.refreshToken, account.uuid!, this.client);
          if (result.ok) {
            await this.store.mutateAccount(account.uuid!, (target) => {
              target.accessToken = result.patch.accessToken;
              target.expiresAt = result.patch.expiresAt;
              if (result.patch.refreshToken) target.refreshToken = result.patch.refreshToken;
              if (result.patch.uuid) target.uuid = result.patch.uuid;
              if (result.patch.email) target.email = result.patch.email;
              if (result.patch.accountId) target.accountId = result.patch.accountId;
              target.consecutiveAuthFailures = 0;
              target.isAuthDisabled = false;
              target.authDisabledReason = undefined;
            });
            this.onInvalidate?.(account.uuid!);
          } else {
            await this.persistFailure(account, result.permanent);
          }
        }
      } catch (error) {
        debugLog(this.client, `Proactive refresh check error: ${error}`);
      } finally {
        if (token === this.runToken) {
          const intervalMs = getConfig().proactive_refresh_interval_seconds * 1000;
          this.scheduleNext(token, intervalMs);
        }
      }
    }

    private async persistFailure(account: StoredAccount, permanent: boolean): Promise<void> {
      try {
        await this.store.mutateAccount(account.uuid!, (target) => {
          if (permanent) {
            target.isAuthDisabled = true;
            target.authDisabledReason = "Token permanently rejected (proactive refresh)";
          } else {
            target.consecutiveAuthFailures = (target.consecutiveAuthFailures ?? 0) + 1;
            const maxFailures = getConfig().max_consecutive_auth_failures;
            if (target.consecutiveAuthFailures >= maxFailures) {
              target.isAuthDisabled = true;
              target.authDisabledReason = `${maxFailures} consecutive auth failures (proactive refresh)`;
            }
          }
        });
      } catch {
        debugLog(this.client, `Failed to persist auth failure for ${account.uuid}`);
      }
    }
  };
}
