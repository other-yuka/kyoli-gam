import type { ManagedAccount, PluginClient, TokenRefreshResult } from "./types";

const MIN_MAX_RETRIES = 6;
const RETRIES_PER_ACCOUNT = 3;
const MAX_SERVER_RETRIES_PER_ATTEMPT = 2;
const MAX_RESOLVE_ATTEMPTS = 10;
const SERVER_RETRY_BASE_MS = 1_000;
const SERVER_RETRY_MAX_MS = 4_000;
const PERMANENT_AUTH_FAILURE_STATUSES = new Set([400, 401, 403]);

export interface ExecutorAccountManager {
  getAccountCount(): number;
  refresh(): Promise<void>;
  selectAccount(): Promise<ManagedAccount | null>;
  markSuccess(uuid: string): Promise<void>;
  markAuthFailure(uuid: string, result: TokenRefreshResult): Promise<void>;
  markRevoked(uuid: string): Promise<void>;
  hasAnyUsableAccount(): boolean;
  getMinWaitTime(): number;
}

export interface ExecutorRuntimeFactory {
  getRuntime(uuid: string): Promise<{ fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }>;
  invalidate(uuid: string): void;
}

export interface ExecutorDependencies {
  handleRateLimitResponse: (
    manager: unknown,
    client: PluginClient,
    account: ManagedAccount,
    response: Response,
  ) => Promise<void>;
  formatWaitTime: (ms: number) => string;
  sleep: (ms: number) => Promise<void>;
  showToast: (
    client: PluginClient,
    message: string,
    variant: "info" | "warning" | "success" | "error",
  ) => Promise<void>;
  getAccountLabel: (account: ManagedAccount) => string;
}

export function createExecutorForProvider(
  providerName: string,
  dependencies: ExecutorDependencies,
): {
  executeWithAccountRotation: (
    manager: ExecutorAccountManager,
    runtimeFactory: ExecutorRuntimeFactory,
    client: PluginClient,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
} {
  const {
    handleRateLimitResponse,
    formatWaitTime,
    sleep,
    showToast,
    getAccountLabel,
  } = dependencies;

  async function executeWithAccountRotation(
    manager: ExecutorAccountManager,
    runtimeFactory: ExecutorRuntimeFactory,
    client: PluginClient,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const maxRetries = Math.max(MIN_MAX_RETRIES, manager.getAccountCount() * RETRIES_PER_ACCOUNT);
    let retries = 0;
    let previousAccountUuid: string | undefined;

    while (true) {
      if (++retries > maxRetries) {
        throw new Error(
          `Exhausted ${maxRetries} retries across all accounts. All attempts failed due to auth errors, rate limits, or token issues.`,
        );
      }

      await manager.refresh();
      const account = await resolveAccount(manager, client);
      const accountUuid = account.uuid;
      if (!accountUuid) continue;

      if (previousAccountUuid && accountUuid !== previousAccountUuid && manager.getAccountCount() > 1) {
        void showToast(client, `Switched to ${getAccountLabel(account)}`, "info");
      }
      previousAccountUuid = accountUuid;

      let runtime: Awaited<ReturnType<ExecutorRuntimeFactory["getRuntime"]>>;
      let response: Response;
      try {
        runtime = await runtimeFactory.getRuntime(accountUuid);
        response = await runtime.fetch(input, init);
      } catch (error) {
        if (await handleRuntimeFetchFailure(manager, runtimeFactory, client, account, error)) {
          continue;
        }
        void showToast(client, `${getAccountLabel(account)} network error — switching`, "warning");
        continue;
      }

      if (response.status >= 500) {
        let serverResponse = response;
        let networkErrorDuringServerRetry = false;
        let authFailureDuringServerRetry = false;

        for (let attempt = 0; attempt < MAX_SERVER_RETRIES_PER_ATTEMPT; attempt++) {
          const backoff = Math.min(SERVER_RETRY_BASE_MS * 2 ** attempt, SERVER_RETRY_MAX_MS);
          const jitteredBackoff = backoff * (0.5 + Math.random() * 0.5);
          await sleep(jitteredBackoff);

          try {
            serverResponse = await runtime.fetch(input, init);
          } catch (error) {
            if (await handleRuntimeFetchFailure(manager, runtimeFactory, client, account, error)) {
              authFailureDuringServerRetry = true;
              break;
            }
            networkErrorDuringServerRetry = true;
            void showToast(client, `${getAccountLabel(account)} network error — switching`, "warning");
            break;
          }

          if (serverResponse.status < 500) break;
        }

        if (authFailureDuringServerRetry) {
          continue;
        }

        if (networkErrorDuringServerRetry || serverResponse.status >= 500) {
          continue;
        }

        response = serverResponse;
      }

      if (response.status === 401) {
        runtimeFactory.invalidate(accountUuid);
        try {
          const retryRuntime = await runtimeFactory.getRuntime(accountUuid);
          const retryResponse = await retryRuntime.fetch(input, init);
          if (retryResponse.status !== 401) {
            await manager.markSuccess(accountUuid);
            return retryResponse;
          }
        } catch (error) {
          if (await handleRuntimeFetchFailure(manager, runtimeFactory, client, account, error)) {
            continue;
          }
          continue;
        }

        await manager.markAuthFailure(accountUuid, { ok: false, permanent: false });
        await manager.refresh();

        if (!manager.hasAnyUsableAccount()) {
          void showToast(client, "All accounts have auth failures.", "error");
          throw new Error(
            `All ${providerName} accounts have authentication failures. Re-authenticate with \`opencode auth login\`.`,
          );
        }

        void showToast(client, `${getAccountLabel(account)} auth failed — switching to next account.`, "warning");
        continue;
      }

      if (response.status === 403) {
        const revoked = await isRevokedTokenResponse(response);
        if (revoked) {
          await manager.markRevoked(accountUuid);
          await manager.refresh();
          void showToast(
            client,
            `${getAccountLabel(account)} disabled: OAuth token revoked.`,
            "error",
          );

          if (!manager.hasAnyUsableAccount()) {
            throw new Error(
              `All ${providerName} accounts have been revoked or disabled. Re-authenticate with \`opencode auth login\`.`,
            );
          }
          continue;
        }
      }

      if (response.status === 429) {
        await handleRateLimitResponse(manager, client, account, response);
        continue;
      }

      await manager.markSuccess(accountUuid);
      return response;
    }
  }

  async function handleRuntimeFetchFailure(
    manager: ExecutorAccountManager,
    runtimeFactory: ExecutorRuntimeFactory,
    client: PluginClient,
    account: ManagedAccount,
    error: unknown,
  ): Promise<boolean> {
    const refreshFailureStatus = getRefreshFailureStatus(error);
    if (refreshFailureStatus === undefined) return false;
    if (!account.uuid) return false;

    const accountUuid = account.uuid;
    runtimeFactory.invalidate(accountUuid);
    await manager.markAuthFailure(accountUuid, {
      ok: false,
      permanent: PERMANENT_AUTH_FAILURE_STATUSES.has(refreshFailureStatus),
    });
    await manager.refresh();

    if (!manager.hasAnyUsableAccount()) {
      void showToast(client, "All accounts have auth failures.", "error");
      throw new Error(
        `All ${providerName} accounts have authentication failures. Re-authenticate with \`opencode auth login\`.`,
      );
    }

    void showToast(client, `${getAccountLabel(account)} auth failed — switching to next account.`, "warning");
    return true;
  }

  async function resolveAccount(
    manager: ExecutorAccountManager,
    client: PluginClient,
  ): Promise<ManagedAccount> {
    let attempts = 0;

    while (true) {
      if (++attempts > MAX_RESOLVE_ATTEMPTS) {
        throw new Error(
          `Failed to resolve an available account after ${MAX_RESOLVE_ATTEMPTS} attempts. All accounts may be rate-limited or disabled.`,
        );
      }

      const account = await manager.selectAccount();
      if (account) return account;

      if (!manager.hasAnyUsableAccount()) {
        throw new Error(
          `All ${providerName} accounts are disabled. Re-authenticate with \`opencode auth login\`.`,
        );
      }

      const waitMs = manager.getMinWaitTime();
      if (waitMs <= 0) {
        throw new Error(
          `All ${providerName} accounts are rate-limited. Add more accounts with \`opencode auth login\` or wait.`,
        );
      }

      await showToast(
        client,
        `All ${manager.getAccountCount()} account(s) rate-limited. Waiting ${formatWaitTime(waitMs)}...`,
        "warning",
      );
      await sleep(waitMs);
    }
  }

  return {
    executeWithAccountRotation,
  };
}

function getRefreshFailureStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const matched = error.message.match(/Token refresh failed:\s*(\d{3})/);
  if (!matched) return undefined;

  const status = Number(matched[1]);
  return Number.isFinite(status) ? status : undefined;
}

async function isRevokedTokenResponse(response: Response): Promise<boolean> {
  try {
    const cloned = response.clone();
    const body = await cloned.text();
    return body.includes("revoked");
  } catch {
    return false;
  }
}
