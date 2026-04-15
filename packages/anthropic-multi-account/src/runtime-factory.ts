import { AccountStore } from "./account-store";
import { ANTHROPIC_OAUTH_ADAPTER } from "./constants";
import { isTokenExpired, refreshToken } from "./token";
import { TokenRefreshError } from "opencode-multi-account-core";
import {
  extractModelIdFromBody,
  extractRequestToolMaskMap,
  buildRequestHeaders,
  createResponseStreamTransform,
  extractToolNamesFromRequestBody,
  transformRequestBody,
  transformRequestUrl,
} from "./request-transform";
import {
  addExcludedBeta,
  getExcludedBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas";
import type { PluginClient, StoredAccount } from "./types";
import { recordObservedToolNames } from "./tool-observation";
import { debugLog } from "./utils";

type BaseFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface AccountRuntime {
  fetch: BaseFetch;
}

const TOKEN_REFRESH_PERMANENT_FAILURE_STATUS = 401;

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

  private async ensureFreshToken(
    storedAccount: StoredAccount,
    uuid: string,
  ): Promise<{ accessToken: string; expiresAt: number }> {
    const refreshed = await refreshToken(storedAccount.refreshToken, uuid, this.client);
    if (!refreshed.ok) {
      throw new TokenRefreshError(
        refreshed.permanent,
        refreshed.permanent ? TOKEN_REFRESH_PERMANENT_FAILURE_STATUS : undefined,
      );
    }

    await this.store.mutateAccount(uuid, (account) => {
      account.accessToken = refreshed.patch.accessToken;
      account.expiresAt = refreshed.patch.expiresAt;
      if (refreshed.patch.refreshToken) account.refreshToken = refreshed.patch.refreshToken;
      if (refreshed.patch.uuid) account.uuid = refreshed.patch.uuid;
      if (refreshed.patch.email) account.email = refreshed.patch.email;
      account.consecutiveAuthFailures = 0;
      account.isAuthDisabled = false;
      account.authDisabledReason = undefined;
    });

    this.client.auth
      .set({
        path: { id: ANTHROPIC_OAUTH_ADAPTER.authProviderId },
        body: {
          type: "oauth",
          refresh: refreshed.patch.refreshToken ?? storedAccount.refreshToken,
          access: refreshed.patch.accessToken,
          expires: refreshed.patch.expiresAt,
        },
      })
      .catch(() => {});

    return { accessToken: refreshed.patch.accessToken, expiresAt: refreshed.patch.expiresAt };
  }

  private async executeTransformedFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    accessToken: string,
  ): Promise<Response> {
    const transformedInput = transformRequestUrl(input);
    const modelId = extractModelIdFromBody(init?.body);
    const excludedBetas = getExcludedBetas(modelId);
    const headers = buildRequestHeaders(transformedInput, init, accessToken, modelId, excludedBetas);
    if (typeof init?.body === "string") {
      void recordObservedToolNames(extractToolNamesFromRequestBody(init.body)).catch(() => {});
    }
    const toolMaskMap = typeof init?.body === "string"
      ? extractRequestToolMaskMap(init.body)
      : new Map<string, string>();
    const transformedBody =
      typeof init?.body === "string" ? transformRequestBody(init.body) : init?.body;

    let response = await fetch(transformedInput, {
      ...init,
      headers,
      body: transformedBody,
    });

    for (let attempt = 0; attempt < LONG_CONTEXT_BETAS.length; attempt += 1) {
      if (response.status !== 400 && response.status !== 429) {
        break;
      }

      const responseBody = await response.clone().text();
      if (!isLongContextError(responseBody)) {
        break;
      }

      const betaToExclude = getNextBetaToExclude(modelId);
      if (!betaToExclude) {
        break;
      }

      addExcludedBeta(modelId, betaToExclude);

      const retryHeaders = buildRequestHeaders(
        transformedInput,
        init,
        accessToken,
        modelId,
        getExcludedBetas(modelId),
      );

      response = await fetch(transformedInput, {
        ...init,
        headers: retryHeaders,
        body: transformedBody,
      });
    }

    return createResponseStreamTransform(response, toolMaskMap);
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

      if (!accessToken || !expiresAt || isTokenExpired({ accessToken, expiresAt })) {
        ({ accessToken, expiresAt } = await this.ensureFreshToken(storedAccount, uuid));
      }

      if (!accessToken) {
        throw new Error(`No access token available for account ${uuid}`);
      }

      return this.executeTransformedFetch(input, init, accessToken);
    };

    debugLog(this.client, `Runtime created for account ${uuid.slice(0, 8)}`);
    return { fetch: fetchWithAccount };
  }
}
