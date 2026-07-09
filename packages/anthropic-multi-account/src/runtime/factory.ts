import { AccountStore } from "../accounts/store";
import { ANTHROPIC_OAUTH_ADAPTER } from "../shared/constants";
import { isTokenExpired, refreshToken } from "../oauth/token";
import { TokenRefreshError } from "opencode-multi-account-core";
import {
  applyRequestToolMasking,
  extractModelIdFromBody,
  extractToolNamesFromRequestBody,
  transformRequestUrl,
} from "../request/transform";
import {
  clampEffortAfterRejection,
  clampUnsupportedEffortInBody,
  parseEffortCapabilityRejection,
} from "@kyoli-gam/provider-claude-code/opencode";
import {
  addExcludedBeta,
  ensureOauthBeta,
  extractRejectedBetas,
  getExcludedBetas,
  getModelBetas,
  isUnexpectedBetaError,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "../request/betas";
import {
  filterBillableBetas,
  getPerRequestHeaders,
  getStaticHeaders,
  orderHeadersForOutbound,
} from "../request/headers";
import {
  buildUpstreamRequest,
  createStreamingReverseMapper,
  getDanglingToolUseError,
  OPENCODE_OUTPUT_EFFORT_HEADER,
  readOpenCodeVariantEffort,
  stampClaudeCodeCch,
  getUpstreamSessionId,
  reverseMapResponse,
  type OutputEffortValue,
} from "../request/upstream-request";
import { claudeCodeIntegration, type ClaudeIdentity } from "../claude-code";
import type { PluginClient, StoredAccount } from "../shared/types";
import { recordObservedToolNames } from "../tools/observation";
import { debugLog } from "../shared/utils";
import { enrich429, sanitizeError } from "../shared/error-utils";
import { computePacingDelay, resolvePacingConfig } from "./pacing";

type BaseFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;
type Message = JsonRecord & {
  role?: string;
  content?: unknown;
};

interface AccountRuntime {
  fetch: BaseFetch;
}

const TOKEN_REFRESH_PERMANENT_FAILURE_STATUS = 401;
const ASSISTANT_PREFILL_UNSUPPORTED_MESSAGE = "This model does not support assistant message prefill";
const NON_SUBSCRIPTION_BILLING_BACKOFF_MS = 24 * 60 * 60 * 1000;

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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function readHeaderOutputEffort(headers: Record<string, string>): OutputEffortValue | undefined {
  return readOpenCodeVariantEffort(headers[OPENCODE_OUTPUT_EFFORT_HEADER]);
}

function messageHasToolUse(message: Message): boolean {
  return Array.isArray(message.content)
    && message.content.some((block) => isRecord(block) && block.type === "tool_use");
}

function removeTrailingAssistantPrefillBody(body: BodyInit | null | undefined): string | null {
  if (typeof body !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
      return null;
    }

    const messages = parsed.messages as Message[];
    const originalLength = messages.length;

    while (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (!lastMessage || lastMessage.role !== "assistant" || messageHasToolUse(lastMessage)) {
        break;
      }

      messages.pop();
    }

    return messages.length === originalLength ? null : JSON.stringify(parsed);
  } catch {
    return null;
  }
}

async function isAssistantPrefillUnsupportedResponse(response: Response): Promise<boolean> {
  if (response.status !== 400) {
    return false;
  }

  return (await response.clone().text()).includes(ASSISTANT_PREFILL_UNSUPPORTED_MESSAGE);
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
  outputEffort?: OutputEffortValue,
): { body: string; reverseLookup: Map<string, string>; validationError: string | null } {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { body, reverseLookup: new Map(), validationError: null };
    }

    const template = claudeCodeIntegration.loadTemplate();

    const upstreamRequest = buildUpstreamRequest(
      parsed as Record<string, unknown>,
      identity,
      template,
      { sessionId, outputEffort },
    );

    const validationError = getDanglingToolUseError(
      Array.isArray(upstreamRequest.messages) ? upstreamRequest.messages as Array<Record<string, unknown>> : [],
    );

    const maskedRequest = applyRequestToolMasking(upstreamRequest as Record<string, unknown>, template.tool_names) as {
      body: string;
      reverseLookup: Map<string, string>;
    };

    return {
      ...maskedRequest,
      validationError,
    };
  } catch {
    return { body, reverseLookup: new Map(), validationError: null };
  }
}

function resolveAccountIdentity(storedAccount: StoredAccount, fallback: ClaudeIdentity): ClaudeIdentity {
  return {
    deviceId: storedAccount.deviceId || fallback.deviceId,
    accountUuid: storedAccount.accountUuid || storedAccount.accountId || fallback.accountUuid || storedAccount.uuid || "",
  };
}

async function applyResponseReverseLookup(
  response: Response,
  reverseLookup: Map<string, string>,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return createStreamingReverseMapper(response, reverseLookup);
  }

  if (!contentType.includes("application/json") || reverseLookup.size === 0) {
    return response;
  }

  try {
    const payload = await response.clone().json();
    const remapped = reverseMapResponse(payload, reverseLookup);
    return new Response(JSON.stringify(remapped), {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  } catch {
    return response;
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

async function blockNonSubscriptionBillingClaim(response: Response): Promise<Response> {
  const claim = response.headers.get("anthropic-ratelimit-unified-representative-claim");
  if (!isNonSubscriptionBillingClaim(claim)) {
    return response;
  }

  await response.body?.cancel().catch(() => undefined);
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.set("retry-after-ms", String(NON_SUBSCRIPTION_BILLING_BACKOFF_MS));
  headers.set("x-kyoli-non-subscription-billing-claim", claim);

  return new Response(
    JSON.stringify({
      error: {
        type: "non_subscription_billing_claim",
        message: `Claude Code response used non-subscription billing claim '${claim}'. Kyoli blocked this account to avoid API/credit billing bleed.`,
      },
    }),
    {
      status: 429,
      headers,
    },
  );
}

export interface PacingTestOverrides {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class AccountRuntimeFactory {
  private runtimes = new Map<string, AccountRuntime>();
  private initLocks = new Map<string, Promise<AccountRuntime>>();
  private effortSupportByModel = new Map<string, string[]>();
  private lastRequestTime = 0;
  private pacingGate = Promise.resolve();
  private pacingTestOverrides: PacingTestOverrides = {};
  private tokenRefreshLocks = new Map<string, Promise<{ accessToken: string; expiresAt: number }>>();

  constructor(
    private readonly store: AccountStore,
    private readonly client: PluginClient,
    private readonly identity: ClaudeIdentity = claudeCodeIntegration.loadIdentity(),
  ) {}

  setPacingTestOverrides(overrides: PacingTestOverrides): void {
    this.pacingTestOverrides = overrides;
  }

  resetPacingForTest(): void {
    this.lastRequestTime = 0;
    this.pacingGate = Promise.resolve();
    this.pacingTestOverrides = {};
  }

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
    const existingRefresh = this.tokenRefreshLocks.get(uuid);
    if (existingRefresh) return existingRefresh;

    const refreshPromise = this.refreshAndPersistToken(storedAccount, uuid);
    this.tokenRefreshLocks.set(uuid, refreshPromise);

    try {
      return await refreshPromise;
    } finally {
      this.tokenRefreshLocks.delete(uuid);
    }
  }

  private async refreshAndPersistToken(
    storedAccount: StoredAccount,
    uuid: string,
  ): Promise<{ accessToken: string; expiresAt: number }> {
    const latestStorage = await this.store.load();
    const latestAccount = latestStorage.accounts.find((account: StoredAccount) => account.uuid === uuid);
    const accountToRefresh = latestAccount ?? storedAccount;
    const latestAccessToken = accountToRefresh.accessToken;

    if (
      latestAccessToken
      && accountToRefresh.expiresAt
      && !isTokenExpired({ accessToken: latestAccessToken, expiresAt: accountToRefresh.expiresAt })
    ) {
      return { accessToken: latestAccessToken, expiresAt: accountToRefresh.expiresAt };
    }

    const refreshed = await refreshToken(accountToRefresh.refreshToken, uuid, this.client);
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
      if (refreshed.patch.accountId) account.accountId = refreshed.patch.accountId;
      if (refreshed.patch.accountUuid && !account.accountUuid) account.accountUuid = refreshed.patch.accountUuid;
      if (refreshed.patch.deviceId && !account.deviceId) account.deviceId = refreshed.patch.deviceId;
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
          refresh: refreshed.patch.refreshToken ?? accountToRefresh.refreshToken,
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
    const mergedBetas = deduplicateBetas(ensureOauthBeta([
      ...getModelBetas(modelId, excludedBetas),
      ...excludeBetas(splitBetaValues(incomingHeaders["anthropic-beta"]), excludedBetas),
    ])).join(",");

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
    identity: ClaudeIdentity,
  ): Promise<Response> {
    const transformedInput = transformRequestUrl(input);
    const modelId = extractModelIdFromBody(init?.body);
    const excludedBetas = getExcludedBetas(modelId);

    const incomingHeaders = extractIncomingHeaders(transformedInput, init);
    const sessionId = incomingHeaders["x-claude-code-session-id"] ?? getUpstreamSessionId();
    const outputEffort = readHeaderOutputEffort(incomingHeaders);
    delete incomingHeaders[OPENCODE_OUTPUT_EFFORT_HEADER];
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

    const transformedRequest = typeof init?.body === "string"
      ? transformBodyToUpstream(init.body, identity, sessionId, outputEffort)
      : { body: init?.body, reverseLookup: new Map<string, string>(), validationError: null };

    if (transformedRequest.validationError) {
      return new Response(JSON.stringify({
        error: {
          message: transformedRequest.validationError,
          type: "invalid_request_error",
        },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const pacingCfg = resolvePacingConfig();
    const getNow = this.pacingTestOverrides.now ?? Date.now;
    const sleepFn = this.pacingTestOverrides.sleep
      ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    const reservePacingSlot = async (): Promise<void> => {
      let releaseGate: (() => void) | undefined;
      const previousGate = this.pacingGate;
      this.pacingGate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });

      await previousGate;

      try {
        const delay = computePacingDelay(getNow(), this.lastRequestTime, pacingCfg);
        if (delay > 0) {
          await sleepFn(delay);
        }
        this.lastRequestTime = getNow();
      } finally {
        releaseGate?.();
      }
    };

    const performFetch = async (requestHeaders: HeadersInit, requestBody: BodyInit | null | undefined): Promise<Response> => {
      await reservePacingSlot();
      const stampedBody = typeof requestBody === "string"
        ? stampClaudeCodeCch(requestBody)
        : requestBody;

      try {
        const response = await fetch(transformedInput, {
          ...init,
          headers: requestHeaders,
          body: stampedBody,
        });
        return await enrichRateLimitResponse(await blockNonSubscriptionBillingClaim(response));
      } catch (error) {
        debugLog(this.client, "Anthropic upstream fetch failed", {
          error: sanitizeError(error),
        });
        throw error;
      }
    };

    let outboundBody = clampUnsupportedEffortInBody(
      transformedRequest.body,
      this.effortSupportByModel,
    ).body;
    const retryEffortCapability = async (
      currentResponse: Response,
      requestHeaders: HeadersInit,
    ): Promise<Response> => {
      if (currentResponse.status !== 400) {
        return currentResponse;
      }

      const responseBody = await currentResponse.clone().text().catch(() => "");
      const rejection = parseEffortCapabilityRejection(responseBody);
      if (!rejection) {
        return currentResponse;
      }

      const clamped = clampEffortAfterRejection(
        outboundBody,
        rejection,
        this.effortSupportByModel,
      );
      if (!clamped.changed) {
        return currentResponse;
      }

      outboundBody = clamped.body;
      return performFetch(requestHeaders, outboundBody);
    };

    let response = await performFetch(headers, outboundBody);
    response = await retryEffortCapability(response, headers);

    if (await isAssistantPrefillUnsupportedResponse(response)) {
      const retryBody = removeTrailingAssistantPrefillBody(outboundBody);
      if (retryBody) {
        outboundBody = retryBody;
        response = await performFetch(headers, outboundBody);
        response = await retryEffortCapability(response, headers);
      }
    }

    for (let attempt = 0; attempt < LONG_CONTEXT_BETAS.length; attempt += 1) {
      if (response.status !== 400 && response.status !== 429) {
        break;
      }

      const responseBody = await response.clone().text();
      if (!isLongContextError(responseBody) && !isUnexpectedBetaError(responseBody)) {
        break;
      }

      if (isUnexpectedBetaError(responseBody)) {
        const rejectedBetas = extractRejectedBetas(responseBody);
        if (rejectedBetas.length === 0) {
          break;
        }

        for (const rejectedBeta of rejectedBetas) {
          addExcludedBeta(modelId, rejectedBeta);
        }
      } else {
        const betasToExclude = LONG_CONTEXT_BETAS.filter((beta) => !getExcludedBetas(modelId).has(beta));
        if (betasToExclude.length === 0) {
          break;
        }

        for (const beta of betasToExclude) {
          addExcludedBeta(modelId, beta);
        }
      }

      const retryHeaders = this.buildOutboundHeaders(
        incomingHeaders,
        sessionId,
        accessToken,
        modelId,
        getExcludedBetas(modelId),
      );

      response = await performFetch(retryHeaders, outboundBody);
      response = await retryEffortCapability(response, retryHeaders);
    }

    return applyResponseReverseLookup(response, transformedRequest.reverseLookup);
  }

  private async createRuntime(uuid: string): Promise<AccountRuntime> {
    const fetchWithAccount: BaseFetch = async (input, init) => {
      const storage = await this.store.load();
      const storedAccount = storage.accounts.find((account: StoredAccount) => account.uuid === uuid);
      if (!storedAccount) {
        throw new Error(`No credentials found for account ${uuid}`);
      }

      let accessToken = storedAccount.accessToken;

      if (!accessToken || !storedAccount.expiresAt || isTokenExpired({ accessToken, expiresAt: storedAccount.expiresAt })) {
        ({ accessToken } = await this.ensureFreshToken(storedAccount, uuid));
      }

      if (!accessToken) {
        throw new Error(`No access token available for account ${uuid}`);
      }

      return this.executeTransformedFetch(
        input,
        init,
        accessToken,
        resolveAccountIdentity(storedAccount, this.identity),
      );
    };

    debugLog(this.client, `Runtime created for account ${uuid.slice(0, 8)}`);
    return { fetch: fetchWithAccount };
  }
}
