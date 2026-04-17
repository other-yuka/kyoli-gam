import { AccountStore } from "./account-store";
import { ANTHROPIC_OAUTH_ADAPTER } from "./constants";
import { isTokenExpired, refreshToken } from "./token";
import { TokenRefreshError } from "opencode-multi-account-core";
import {
  extractModelIdFromBody,
  extractToolNamesFromRequestBody,
  transformRequestUrl,
} from "./request-transform";
import {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas";
import {
  filterBillableBetas,
  getBetaHeader,
  getPerRequestHeaders,
  getStaticHeaders,
  orderHeadersForOutbound,
} from "./upstream-headers";
import {
  buildUpstreamRequest,
  createStreamingReverseMapper,
  getUpstreamSessionId,
} from "./upstream-request";
import { loadClaudeIdentity, type ClaudeIdentity } from "./claude-identity";
import { loadTemplate } from "./fingerprint-capture";
import type { PluginClient, StoredAccount } from "./types";
import { recordObservedToolNames } from "./tool-observation";
import { debugLog } from "./utils";
import { enrich429, rateGovern, sanitizeError } from "./error-utils";

type BaseFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface AccountRuntime {
  fetch: BaseFetch;
}

const TOKEN_REFRESH_PERMANENT_FAILURE_STATUS = 401;

function mergeHeaders(target: Record<string, string>, headers: HeadersInit | undefined): void {
  if (!headers) {
    return;
  }

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      target[key.toLowerCase()] = value;
    });
    return;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      target[String(key).toLowerCase()] = String(value);
    }
    return;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      target[key.toLowerCase()] = String(value);
    }
  }
}

function extractIncomingHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (input instanceof Request) {
    mergeHeaders(headers, input.headers);
  }

  mergeHeaders(headers, init?.headers);
  return headers;
}

function splitBetaValues(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function deduplicateBetas(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function excludeBetas(values: string[], excludedBetas: Set<string>): string[] {
  if (excludedBetas.size === 0) {
    return values;
  }

  return values.filter((beta) => !excludedBetas.has(beta));
}

function transformBodyToUpstream(
  body: string,
  identity: ClaudeIdentity,
  sessionId: string,
): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return body;
    }

    return JSON.stringify(
      buildUpstreamRequest(
        parsed as Record<string, unknown>,
        identity,
        loadTemplate(),
        { sessionId },
      ),
    );
  } catch {
    return body;
  }
}

async function enrichRateLimitResponse(response: Response): Promise<Response> {
  if (response.status !== 429) {
    return response;
  }

  const body = await response.clone().text();
  const enrichedBody = enrich429(body, response.headers);
  if (enrichedBody === body) {
    return response;
  }

  return new Response(enrichedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

export class AccountRuntimeFactory {
  private runtimes = new Map<string, AccountRuntime>();
  private initLocks = new Map<string, Promise<AccountRuntime>>();

  constructor(
    private readonly store: AccountStore,
    private readonly client: PluginClient,
    private readonly identity: ClaudeIdentity = loadClaudeIdentity(),
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

  private buildOutboundHeaders(
    incomingHeaders: Record<string, string>,
    sessionId: string,
    accessToken: string,
    modelId: string,
    excludedBetas: Set<string>,
  ): HeadersInit {
    const mergedBetas = deduplicateBetas([
      ...excludeBetas(splitBetaValues(getBetaHeader()), excludedBetas),
      ...getModelBetas(modelId, excludedBetas),
      ...excludeBetas(splitBetaValues(incomingHeaders["anthropic-beta"]), excludedBetas),
    ]).join(",");

    const outbound: Record<string, string> = {
      ...incomingHeaders,
      ...getStaticHeaders(),
      ...getPerRequestHeaders(sessionId),
      "authorization": `Bearer ${accessToken}`,
      "anthropic-beta": filterBillableBetas(mergedBetas),
    };
    delete outbound["x-api-key"];

    return orderHeadersForOutbound(outbound);
  }

  private async executeTransformedFetch(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    accessToken: string,
  ): Promise<Response> {
    const transformedInput = transformRequestUrl(input);
    const modelId = extractModelIdFromBody(init?.body);
    const excludedBetas = getExcludedBetas(modelId);

    const incomingHeaders = extractIncomingHeaders(transformedInput, init);
    const sessionId = incomingHeaders["x-claude-code-session-id"] ?? getUpstreamSessionId();
    const headers = this.buildOutboundHeaders(
      incomingHeaders,
      sessionId,
      accessToken,
      modelId,
      excludedBetas,
    );

    if (typeof init?.body === "string") {
      void recordObservedToolNames(extractToolNamesFromRequestBody(init.body)).catch(() => {});
    }

    const transformedBody = typeof init?.body === "string"
      ? transformBodyToUpstream(init.body, this.identity, sessionId)
      : init?.body;

    const performFetch = async (requestHeaders: HeadersInit): Promise<Response> => {
      await rateGovern();

      try {
        const response = await fetch(transformedInput, {
          ...init,
          headers: requestHeaders,
          body: transformedBody,
        });
        return await enrichRateLimitResponse(response);
      } catch (error) {
        debugLog(this.client, "Anthropic upstream fetch failed", {
          error: sanitizeError(error),
        });
        throw error;
      }
    };

    let response = await performFetch(headers);

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

      const retryHeaders = this.buildOutboundHeaders(
        incomingHeaders,
        sessionId,
        accessToken,
        modelId,
        getExcludedBetas(modelId),
      );

      response = await performFetch(retryHeaders);
    }

    return createStreamingReverseMapper(response);
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
