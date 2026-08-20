import { AccountStore, type DiskCredentials } from "./account-store";
import type { PluginClient, PluginConfig, StoredAccount, TokenRefreshResult } from "./types";
import { getClearedOAuthBody } from "./utils";

const INITIAL_DELAY_MS = 5_000;

export interface ProactiveRefreshDependencies {
  providerAuthId: string;
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
    providerAuthId,
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
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = null;
      }
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

          const { result } = await this.store.refreshAccountCredentials(
            account.uuid!,
            credentials,
            (refreshTokenValue) => refreshToken(refreshTokenValue, account.uuid!, this.client),
          );
          if (result.ok) {
            this.onInvalidate?.(account.uuid!);
          } else {
            await this.persistFailure(account, result.permanent, credentials);
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

    private async persistFailure(
      account: StoredAccount,
      permanent: boolean,
      expected: DiskCredentials,
    ): Promise<void> {
      try {
        const accountUuid = account.uuid;
        if (!accountUuid) return;

        await this.store.mutateStorageIfCredentialsMatch(
          accountUuid,
          expected,
          (target, storage) => {
            if (permanent) {
              target.consecutiveAuthFailures = Math.max(
                (target.consecutiveAuthFailures ?? 0) + 1,
                getConfig().max_consecutive_auth_failures,
              );
              target.isAuthDisabled = true;
              target.authDisabledReason = "refresh failed permanently (proactive refresh)";
              return;
            }

            target.consecutiveAuthFailures = (target.consecutiveAuthFailures ?? 0) + 1;
            const maxFailures = getConfig().max_consecutive_auth_failures;
            const usableCount = storage.accounts.filter(
              (entry) => entry.enabled && !entry.isAuthDisabled && entry.uuid !== target.uuid,
            ).length;

            if (target.consecutiveAuthFailures >= maxFailures && usableCount > 0) {
              target.isAuthDisabled = true;
              target.authDisabledReason = `${maxFailures} consecutive auth failures (proactive refresh)`;
            }
          },
        );
      } catch {
        debugLog(this.client, `Failed to persist auth failure for ${account.uuid}`);
      }
    }

    private async clearOpenCodeAuthIfNoAccountsRemain(): Promise<void> {
      const storage = await this.store.load();
      if (storage.accounts.length > 0) return;

      await this.client.auth
        .set({
          path: { id: providerAuthId },
          body: getClearedOAuthBody(),
        })
        .catch(() => {});
    }
  };
}
