import {
  isTokenRefreshError,
  type ManagedAccount,
  type PluginClient,
  type TokenRefreshResult,
} from "./types";

const MIN_MAX_RETRIES = 6;
const RETRIES_PER_ACCOUNT = 3;
const MAX_SERVER_RETRIES_PER_ATTEMPT = 2;
const MAX_RESOLVE_ATTEMPTS = 10;
const SERVER_RETRY_BASE_MS = 1_000;
const SERVER_RETRY_MAX_MS = 4_000;
export interface ExecutorAccountManager {
  getAccountCount(): number;
  refresh(): Promise<void>;
  selectAccount(stickyKey?: string): Promise<ManagedAccount | null>;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function readStickyHeaderFromInit(headers: HeadersInit | undefined): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get("x-claude-code-session-id") ?? undefined;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (String(key).toLowerCase() === "x-claude-code-session-id") {
        return String(value);
      }
    }
    return undefined;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "x-claude-code-session-id" && value !== undefined) {
      return String(value);
    }
  }

  return undefined;
}

function extractStickyKey(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  const requestHeader = input instanceof Request
    ? input.headers.get("x-claude-code-session-id") ?? undefined
    : undefined;

  return readStickyHeaderFromInit(init?.headers) ?? requestHeader;
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
    let previousAccountUuid: string | undefined;
    const stickyKey = extractStickyKey(input, init);

    type StatusTransition =
      | { type: "success"; response: Response }
      | { type: "handled"; response?: Response }
      | { type: "retryOuter" };

    async function retryServerErrors(
      account: ManagedAccount,
      runtime: Awaited<ReturnType<ExecutorRuntimeFactory["getRuntime"]>>,
    ): Promise<Response | null> {
      for (let attempt = 0; attempt < MAX_SERVER_RETRIES_PER_ATTEMPT; attempt++) {
        const backoff = Math.min(SERVER_RETRY_BASE_MS * 2 ** attempt, SERVER_RETRY_MAX_MS);
        const jitteredBackoff = backoff * (0.5 + Math.random() * 0.5);
        await sleep(jitteredBackoff);

        let retryResponse: Response;
        try {
          retryResponse = await runtime.fetch(input, init);
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (await handleRuntimeFetchFailure(manager, runtimeFactory, client, account, error)) {
            return null;
          }
          void showToast(client, `${getAccountLabel(account)} network error — switching`, "warning");
          return null;
        }

        if (retryResponse.status < 500) return retryResponse;
      }

      return null;
    }

    const dispatchResponseStatus = async (
      account: ManagedAccount,
      accountUuid: string,
      runtime: Awaited<ReturnType<ExecutorRuntimeFactory["getRuntime"]>>,
      response: Response,
      allow401Retry: boolean,
      from401RefreshRetry: boolean,
    ): Promise<StatusTransition> => {
      if (response.status >= 500) {
        const recovered = await retryServerErrors(account, runtime);
        if (recovered === null) {
          return { type: "retryOuter" };
        }
        response = recovered;
      }

      if (response.status === 401) {
        if (allow401Retry) {
          runtimeFactory.invalidate(accountUuid);
          try {
            const retryRuntime = await runtimeFactory.getRuntime(accountUuid);
            const retryResponse = await retryRuntime.fetch(input, init);
            return dispatchResponseStatus(account, accountUuid, retryRuntime, retryResponse, false, true);
          } catch (error) {
            if (isAbortError(error)) throw error;
            await handleRuntimeFetchFailure(manager, runtimeFactory, client, account, error);
            return { type: "retryOuter" };
          }
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
        return { type: "retryOuter" };
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
          return { type: "retryOuter" };
        }

        if (from401RefreshRetry) {
          return { type: "handled", response };
        }
      }

      if (response.status === 429) {
        await handleRateLimitResponse(manager, client, account, response);
        return { type: "handled" };
      }

      return { type: "success", response };
    };

    for (let retries = 1; retries <= maxRetries; retries++) {
      await manager.refresh();
      const account = await resolveAccount(manager, client, stickyKey);
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
        if (isAbortError(error)) throw error;
        if (await handleRuntimeFetchFailure(manager, runtimeFactory, client, account, error)) {
          continue;
        }
        void showToast(client, `${getAccountLabel(account)} network error — switching`, "warning");
        continue;
      }

      const transition = await dispatchResponseStatus(account, accountUuid, runtime, response, true, false);
      if (transition.type === "retryOuter" || transition.type === "handled") {
        if (transition.type === "handled" && transition.response) {
          return transition.response;
        }
        continue;
      }

      await manager.markSuccess(accountUuid);
      return transition.response;
    }

    throw new Error(
      `Exhausted ${maxRetries} retries across all accounts. All attempts failed due to auth errors, rate limits, or token issues.`,
    );
  }

  async function handleRuntimeFetchFailure(
    manager: ExecutorAccountManager,
    runtimeFactory: ExecutorRuntimeFactory,
    client: PluginClient,
    account: ManagedAccount,
    error: unknown,
  ): Promise<boolean> {
    if (!isTokenRefreshError(error)) return false;
    if (!account.uuid) return false;

    const accountUuid = account.uuid;
    runtimeFactory.invalidate(accountUuid);
    await manager.markAuthFailure(accountUuid, {
      ok: false,
      permanent: error.permanent,
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
    stickyKey?: string,
  ): Promise<ManagedAccount> {
    let attempts = 0;

    while (true) {
      if (++attempts > MAX_RESOLVE_ATTEMPTS) {
        throw new Error(
          `Failed to resolve an available account after ${MAX_RESOLVE_ATTEMPTS} attempts. All accounts may be rate-limited or disabled.`,
        );
      }

      const account = await manager.selectAccount(stickyKey);
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

async function isRevokedTokenResponse(response: Response): Promise<boolean> {
  try {
    const cloned = response.clone();
    const body = await cloned.text();
    return body.includes("revoked");
  } catch {
    return false;
  }
}
