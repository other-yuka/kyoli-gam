import { AccountStore } from "./account-store";
import { isTokenExpired, refreshToken } from "./token";
import { buildRequestHeaders, transformRequestUrl } from "./request-transform";
import type { PluginClient, StoredAccount } from "./types";
import { debugLog } from "./utils";

type BaseFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface AccountRuntime {
  fetch: BaseFetch;
}

export class AccountRuntimeFactory {
  private runtimes = new Map<string, AccountRuntime>();
  private initLocks = new Map<string, Promise<AccountRuntime>>();

  constructor(
    private readonly store: AccountStore,
    private readonly client: PluginClient,
  ) {}

  async getRuntime(uuid: string): Promise<AccountRuntime> {
    const cached = this.runtimes.get(uuid);
    if (cached) return cached;

    const existing = this.initLocks.get(uuid);
    if (existing) return existing;

    const initPromise = this.createRuntime(uuid);
    this.initLocks.set(uuid, initPromise);

    try {
      const runtime = await initPromise;
      this.runtimes.set(uuid, runtime);
      return runtime;
    } finally {
      this.initLocks.delete(uuid);
    }
  }

  invalidate(uuid: string): void {
    this.runtimes.delete(uuid);
  }

  invalidateAll(): void {
    this.runtimes.clear();
  }

  private async createRuntime(uuid: string): Promise<AccountRuntime> {
    const fetchWithAccount: BaseFetch = async (input, init) => {
      const storage = await this.store.load();
      const storedAccount = storage.accounts.find((account: StoredAccount) => account.uuid === uuid);
      if (!storedAccount) {
        throw new Error(`No credentials found for account ${uuid}`);
      }

      let accessToken = storedAccount.accessToken;
      let expiresAt = storedAccount.expiresAt;
      let accountId = storedAccount.accountId;

      if (!accessToken || !expiresAt || isTokenExpired({ accessToken, expiresAt })) {
        const refreshed = await refreshToken(storedAccount.refreshToken, uuid, this.client);
        if (!refreshed.ok) {
          if (typeof refreshed.status === "number") {
            throw new Error(`Token refresh failed: ${refreshed.status}`);
          }
          throw new Error("Token refresh failed");
        }

        accessToken = refreshed.patch.accessToken;
        expiresAt = refreshed.patch.expiresAt;
        accountId = refreshed.patch.accountId ?? accountId;

        await this.store.mutateAccount(uuid, (account) => {
          account.accessToken = refreshed.patch.accessToken;
          account.expiresAt = refreshed.patch.expiresAt;
          if (refreshed.patch.refreshToken) account.refreshToken = refreshed.patch.refreshToken;
          if (refreshed.patch.accountId) account.accountId = refreshed.patch.accountId;
          if (refreshed.patch.email) account.email = refreshed.patch.email;
          account.consecutiveAuthFailures = 0;
          account.isAuthDisabled = false;
          account.authDisabledReason = undefined;
        });
      }

      if (!accessToken) {
        throw new Error(`No access token available for account ${uuid}`);
      }

      const transformedInput = transformRequestUrl(input);
      const headers = buildRequestHeaders(transformedInput, init, accessToken, accountId);

      return fetch(transformedInput, {
        ...init,
        headers,
      });
    };

    debugLog(this.client, `Runtime created for account ${uuid.slice(0, 8)}`);
    return { fetch: fetchWithAccount };
  }
}
