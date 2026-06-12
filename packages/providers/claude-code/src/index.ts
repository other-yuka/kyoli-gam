import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  AccountExecutionTraceEvent,
  AccountExecutionResult,
  AccountFailureSignal,
  AccountPool,
  AccountRecord,
  ModelInfo,
  ProviderAdapter,
  ProviderUsageRefreshResult,
  SelectedCredential,
} from "@kyoli-gam/core";
import {
  CredentialUnavailableError,
  executeWithAccountFailover,
  jsonResponse,
  stripProviderPrefix,
} from "@kyoli-gam/core";
import {
  applyClaudeCodeUpstreamBodyFields,
  CLAUDE_FABLE_1M_MODEL_ID,
  CLAUDE_FABLE_MODEL_ID,
  isClaudeCode1mModelLabel,
  isClaudeFableModel,
  resolveClaudeCodeModelAlias,
  toClaudeCodeWireModelId,
} from "./opencode-shared";
import {
  refreshClaudeCodeAccountMetadata,
  refreshClaudeCodeOAuthToken,
  type ClaudeCodeAccountMetadataRefresh,
  type ClaudeCodeTokenRefreshResult,
} from "./oauth";
import {
  applyClaudeToolFlow,
  reverseClaudeToolFlow,
  type ReverseToolLookup,
} from "./tool-flow";
import {
  clampEffortAfterRejection,
  clampUnsupportedEffortInBody,
  parseEffortCapabilityRejection,
} from "./effort-capability";
import {
  getClaudeCodeTemplateMetadata,
  getClaudeCodeTemplateTools,
} from "./fingerprint-template";
import {
  loadClaudeCodeIdentity,
  type ClaudeCodeIdentity,
} from "./identity";
import {
  classifyClaudeCodeSseStartupFailure,
  isClaudeCodeStartupOutputFrame,
} from "./failures";

const CLAUDE_CODE_API_BASE_URL = "https://api.anthropic.com";
const templateMetadata = getClaudeCodeTemplateMetadata();
const templateHeaders = templateMetadata.headerValues;
const CLAUDE_CODE_VERSION = templateMetadata.ccVersion ?? "2.1.137";
const CLAUDE_CODE_USER_AGENT =
  templateHeaders["user-agent"] ?? `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`;
const CLAUDE_CODE_X_APP = templateHeaders["x-app"] ?? "cli";
const CLAUDE_CODE_ANTHROPIC_VERSION = templateHeaders["anthropic-version"] ?? "2023-06-01";
const CLAUDE_CODE_BETA =
  templateMetadata.anthropicBeta ?? templateHeaders["anthropic-beta"] ?? "oauth-2025-04-20";
const CLAUDE_CODE_BROWSER_ACCESS =
  templateHeaders["anthropic-dangerous-direct-browser-access"] ?? "true";
const CLAUDE_CODE_TIMEOUT_SECONDS = templateHeaders["x-stainless-timeout"] ?? "600";
const STAINLESS_PACKAGE_VERSION = "0.81.0";
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const BILLABLE_BETA_PREFIXES = ["extended-cache-ttl-"];
const CONTEXT_1M_BETA = "context-1m-2025-08-07";
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const FABLE_FALLBACK_CREDIT_BETA = "fallback-credit-2026-06-01";
const MID_CONVERSATION_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
const EFFORT_BETA = "effort-2025-11-24";
const LONG_CONTEXT_BETAS = [CONTEXT_1M_BETA, CONTEXT_MANAGEMENT_BETA] as const;
const BILLING_SEED = "59cf53e54c78";
const CLAUDE_STARTUP_PROBE_MAX_BYTES = 64 * 1024;
const CLAUDE_CODE_AGENT_IDENTITY =
  templateMetadata.agentIdentity ?? "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CODE_SYSTEM_PROMPT =
  templateMetadata.systemPrompt ?? "You are an interactive agent that helps users with software engineering tasks. Follow the user's instructions carefully, use available tools when appropriate, and keep responses focused on the task.";
const sessionIdsByKey = new Map<string, ClaudeSessionState>();
const fallbackDeviceId = randomUUID();

const models: ModelInfo[] = [
  {
    id: `anthropic/${CLAUDE_FABLE_MODEL_ID}`,
    provider: "claude-code",
    upstreamId: CLAUDE_FABLE_MODEL_ID,
    displayName: "Claude Fable 5 via Claude Code",
    aliases: [
      CLAUDE_FABLE_MODEL_ID,
      "fable",
      `claude-code/${CLAUDE_FABLE_MODEL_ID}`,
      "claude-code/fable",
    ],
    capabilities: ["messages", "tools", "streaming", "reasoning", "claude-code"],
    metadata: { max_context_window: 1_000_000 },
  },
  {
    id: `anthropic/${CLAUDE_FABLE_1M_MODEL_ID}`,
    provider: "claude-code",
    upstreamId: CLAUDE_FABLE_1M_MODEL_ID,
    displayName: "Claude Fable 5 [1m] via Claude Code",
    aliases: [
      CLAUDE_FABLE_1M_MODEL_ID,
      "fable1m",
      `claude-code/${CLAUDE_FABLE_1M_MODEL_ID}`,
      "claude-code/fable1m",
    ],
    capabilities: ["messages", "tools", "streaming", "reasoning", "claude-code"],
    metadata: { max_context_window: 1_000_000 },
  },
  {
    id: "anthropic/claude-sonnet-4-5",
    provider: "claude-code",
    upstreamId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5 via Claude Code",
    aliases: ["claude-sonnet-4-5", "claude-code/claude-sonnet-4-5"],
    capabilities: ["messages", "tools", "streaming", "claude-code"],
  },
];

export interface ClaudeCodeProviderOptions {
  accounts?: AccountPool;
  baseUrl?: string;
  fetch?: typeof fetch;
  fingerprint?: Partial<ClaudeCodeRequestFingerprint>;
  identity?: ClaudeCodeIdentity;
  allowLiveMessages?: boolean;
  maxAccountAttempts?: number;
  onTrace?: (event: AccountExecutionTraceEvent) => void;
  pacing?: Partial<ClaudeCodePacingOptions> | false;
  drainOnCancel?: boolean;
  drainTimeoutMs?: number;
  retryContext1m?: boolean;
  retryRejectedBetas?: boolean;
  sessionRotation?: Partial<ClaudeCodeSessionRotationOptions>;
  tokenRefresh?: ClaudeCodeTokenRefresh;
  trustClientFingerprint?: boolean;
  usageRefresh?: ClaudeCodeUsageRefresh;
}

export {
  loadClaudeCodeIdentity,
  resetClaudeCodeIdentityForTest,
  setClaudeCodeIdentityForTest,
  type ClaudeCodeIdentity,
} from "./identity";
export {
  detectClaudeCodeOAuthConfig,
  findClaudeCodeBinary,
  probeClaudeVersion,
  resetClaudeCodeOAuthConfigForTest,
  type ClaudeCodeOAuthConfig,
} from "./oauth-config";
export {
  getClaudeCodeTemplateMetadata,
  getClaudeCodeTemplateTools,
  isClaudeCodeTemplateToolName,
} from "./fingerprint-template";
export {
  composeClaudeCodeBillingSystemEntry,
  computeClaudeCodeBuildTag,
  createClaudeCodePerRequestHeaders,
  createClaudeCodeStaticHeaders,
  applyClaudeCodeUpstreamBodyFields,
  loadClaudeCodeSharedRequestProfile,
  normalizeClaudeCodeSystemTexts,
  orderClaudeCodeBodyForOutbound,
  orderClaudeCodeHeadersForOutbound,
  type ClaudeCodeUpstreamBodyOptions,
  type ClaudeCodeUpstreamIdentity,
  type ClaudeCodeSharedRequestProfile,
} from "./opencode-shared";
export {
  checkClaudeCodeTemplateDrift,
  captureClaudeCodeWireRequest,
  type ClaudeCodeCapturedRequest,
  type ClaudeCodeTemplateDriftCheck,
  type ClaudeCodeTemplateDriftReport,
  type ClaudeCodeWireCapture,
} from "./template-drift";
export {
  refreshClaudeCodeAccountMetadata,
  refreshClaudeCodeOAuthToken,
  startClaudeCodeOAuthLogin,
  type ClaudeCodeAccountMetadataRefresh,
  type ClaudeCodeOAuthTokens,
  type ClaudeCodeTokenRefreshResult,
  type ClaudeCodeUsageLimits,
} from "./oauth";

interface ClaudeCodeCredential extends SelectedCredential {
  accountId?: string;
  metadata: Record<string, unknown>;
}

type ClaudeCodeTokenRefresh = (refreshToken: string) => Promise<ClaudeCodeTokenRefreshResult>;
type ClaudeCodeUsageRefresh = (accessToken: string) => Promise<ClaudeCodeAccountMetadataRefresh>;

interface ClaudeCodeRequestFingerprint {
  anthropicBeta: string;
  anthropicVersion: string;
  browserAccess: string;
  packageVersion: string;
  runtime: string;
  runtimeVersion: string;
  stainlessArch: string;
  stainlessLang: string;
  stainlessOs: string;
  timeoutSeconds: string;
  userAgent: string;
  xApp: string;
}

interface ClaudeCodePacingOptions {
  jitterMs: number;
  minGapMs: number;
}

interface ClaudeCodeSessionRotationOptions {
  idleTtlMs: number;
  idleJitterMs: number;
  maxAgeMs: number;
}

interface ClaudeSessionState {
  createdAt: number;
  id: string;
  idleJitterMs: number;
  lastUsedAt: number;
}

export function createClaudeCodeProvider(
  options: ClaudeCodeProviderOptions = {},
): ProviderAdapter {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? CLAUDE_CODE_API_BASE_URL);
  const fetchImpl = options.fetch ?? fetch;
  const fingerprint = createClaudeCodeRequestFingerprint(options.fingerprint);
  const usageRefresh = options.usageRefresh ?? ((accessToken: string) =>
    refreshClaudeCodeAccountMetadata(accessToken, { fetch: fetchImpl }));
  const rejectedBetasByAccount = new Map<string, Set<string>>();
  const effortSupportByModel = new Map<string, string[]>();
  const pacer = createClaudeCodePacer(resolvePacingOptions(options.pacing));
  const drainOnCancel = options.drainOnCancel ?? readBooleanEnv("KYOLI_CLAUDE_DRAIN_ON_CANCEL");
  const drainTimeoutMs = readNonNegativeInteger(options.drainTimeoutMs) ??
    readNonNegativeInteger(process.env.KYOLI_CLAUDE_DRAIN_TIMEOUT_MS) ??
    5 * 60 * 1000;
  const retryContext1m = options.retryContext1m ?? true;
  const retryRejectedBetas = options.retryRejectedBetas ?? true;
  const sessionRotation = resolveSessionRotationOptions(options.sessionRotation);

  return {
    id: "claude-code",
    displayName: "Claude Code OAuth",
    routes: ["/v1/messages", "/v1/messages/count_tokens"],
    async listModels() {
      return models;
    },
    refreshUsage: ({ account }) =>
      refreshClaudeCodeUsageForAccount({
        account,
        tokenRefresh: options.tokenRefresh ?? refreshClaudeCodeOAuthToken,
        usageRefresh,
      }),
    async handleRequest(context) {
      if (context.route !== "/v1/messages" && context.route !== "/v1/messages/count_tokens") {
        return jsonResponse(
          {
            error: {
              type: "route_not_supported",
              message: `Claude Code OAuth passthrough is not implemented for ${context.route}.`,
            },
          },
          { status: 501 },
        );
      }
      if (context.route === "/v1/messages" && options.allowLiveMessages !== true) {
        return jsonResponse(
          {
            error: {
              type: "claude_live_messages_disabled",
              message:
                "Claude Code live /v1/messages generation is disabled by default. Set KYOLI_CLAUDE_ALLOW_LIVE_MESSAGES=1 or enable allowLiveMessages explicitly after running the Claude safety doctors.",
            },
          },
          { status: 403 },
        );
      }

      return executeWithAccountFailover({
        provider: "claude-code",
        kind: "oauth",
        accounts: options.accounts,
        sessionKey: context.sessionKey,
        maxAttempts: options.maxAccountAttempts,
        missingCredentialResponse: () =>
          jsonResponse(
            {
              error: {
                type: "missing_oauth_account",
                message:
                  "Claude Code requests require a stored claude-code/oauth account.",
              },
            },
            { status: 401 },
          ),
        selectCredential: (excludeAccountIds) =>
          readOAuthCredential({
            accounts: options.accounts,
            sessionKey: context.sessionKey,
            excludeAccountIds,
            tokenRefresh: options.tokenRefresh ?? refreshClaudeCodeOAuthToken,
          }),
        execute: async (credential) => {
          const claudeCredential = credential as ClaudeCodeCredential;
          const sessionId = getClaudeSessionId(context.sessionKey, sessionRotation);
          const transformed = transformRequestBody(context.body, {
            identity: resolveRequestIdentity(claudeCredential, options.identity),
            model: context.model,
            route: context.route,
            sessionKey: context.sessionKey,
            sessionId,
          });
          const response = await fetchWithClaudeRetries({
            accessToken: credential.value,
            accountKey: readCredentialCacheKey(claudeCredential),
            body:
              transformed.body === undefined
                ? undefined
                : JSON.stringify(transformed.body),
            context,
            effortSupportByModel,
            fetchImpl,
            fingerprint,
            pacer,
            rejectedBetasByAccount,
            retryContext1m,
            retryRejectedBetas,
            sessionId,
            trustClientFingerprint: options.trustClientFingerprint ?? false,
            url: createUpstreamUrl(baseUrl, context.route),
          });
          const upstream = await normalizeClaudeCodeStartupFailure(response);
          const failure = upstream.failure ?? inferClaudeCodeHttpFailure(upstream.response);
          const transformedResponse = await transformResponse(upstream.response, transformed.reverseLookup, {
            drainOnCancel,
            drainTimeoutMs,
          });
          return {
            ...upstream,
            failure,
            response: transformedResponse,
          };
        },
        failureMessage: (status) => `Claude Code upstream returned ${status}`,
        onTrace: options.onTrace,
        readRateLimitResetAt: readClaudeCodeRateLimitResetAt,
        sameAccountMaxRetries: 1,
        traceModel: context.model ? stripProviderPrefix(context.model) : undefined,
        traceRoute: context.route,
      });
    },
  };
}

async function fetchWithClaudeRetries(input: {
  accessToken: string;
  accountKey: string;
  body: BodyInit | undefined;
  context: Parameters<ProviderAdapter["handleRequest"]>[0];
  effortSupportByModel: Map<string, string[]>;
  fetchImpl: typeof fetch;
  fingerprint: ClaudeCodeRequestFingerprint;
  pacer: () => Promise<void>;
  rejectedBetasByAccount: Map<string, Set<string>>;
  retryContext1m: boolean;
  retryRejectedBetas: boolean;
  sessionId: string;
  trustClientFingerprint: boolean;
  url: string;
}): Promise<Response> {
  const excludedBetas = getRejectedBetaSet(input.rejectedBetasByAccount, input.accountKey);
  let body = clampUnsupportedEffortInBody(input.body, input.effortSupportByModel).body;
  const dispatchInput = (nextBody: BodyInit | undefined): Parameters<typeof dispatchClaudeRequest>[0] => ({
    ...input,
    body: nextBody,
  });
  let response = await dispatchClaudeRequest(dispatchInput(body), excludedBetas, 0);

  if (response.status !== 400 && response.status !== 429) return response;

  let bodyText = await response.clone().text().catch(() => "");
  const effortRejection = response.status === 400
    ? parseEffortCapabilityRejection(bodyText)
    : null;
  if (effortRejection) {
    const clamped = clampEffortAfterRejection(
      body,
      effortRejection,
      input.effortSupportByModel,
    );
    if (clamped.changed) {
      body = clamped.body;
      response = await dispatchClaudeRequest(dispatchInput(body), excludedBetas, 1);
      if (response.status !== 400 && response.status !== 429) return response;
      bodyText = await response.clone().text().catch(() => "");
    }
  }

  const rejectedBetas = input.retryRejectedBetas && response.status === 400
    ? parseRejectedBetaFlags(bodyText)
    : [];
  const longContextRetryBetas = input.retryContext1m && isLongContextBetaError(bodyText)
    ? LONG_CONTEXT_BETAS.filter((flag) => !excludedBetas.has(flag))
    : [];
  const retryBetas = [
    ...rejectedBetas.filter((flag) => !excludedBetas.has(flag)),
    ...longContextRetryBetas,
  ];

  if (retryBetas.length === 0) return response;

  for (const beta of retryBetas) {
    excludedBetas.add(beta);
  }
  return dispatchClaudeRequest(dispatchInput(body), excludedBetas, 1);
}

async function dispatchClaudeRequest(
  input: Parameters<typeof fetchWithClaudeRetries>[0],
  excludedBetas: Set<string>,
  retryCount: number,
): Promise<Response> {
  const headers = buildUpstreamHeaders({
    headers: input.context.request.headers,
    accessToken: input.accessToken,
    excludedBetas,
    fingerprint: input.fingerprint,
    retryCount,
    sessionId: input.sessionId,
    trustClientFingerprint: input.trustClientFingerprint,
    model: input.context.model,
  });

  await input.pacer();
  return input.fetchImpl(input.url, {
    method: input.context.request.method,
    headers,
    body: input.body,
    duplex: "half",
  } as RequestInit);
}

async function normalizeClaudeCodeStartupFailure(response: Response): Promise<AccountExecutionResult> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    return { response };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let pendingText = "";
  let failure: AccountFailureSignal | undefined;
  let downstreamVisible = false;
  let done = false;

  while (byteLength(chunks) < CLAUDE_STARTUP_PROBE_MAX_BYTES && !failure && !downstreamVisible) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    chunks.push(next.value);
    pendingText += decoder.decode(next.value, { stream: true });
    pendingText = drainSseFrames(pendingText, (frame) => {
      if (failure || downstreamVisible) return;
      const frameFailure = classifyClaudeCodeSseStartupFailure(frame);
      if (frameFailure) {
        failure = withClaudeCodeRateLimitReset(frameFailure, response.headers);
        return;
      }
      if (isClaudeCodeStartupOutputFrame(frame)) downstreamVisible = true;
    });
  }

  if (done && !failure && !downstreamVisible) {
    pendingText += decoder.decode();
    if (pendingText.trim()) {
      const pendingFailure = classifyClaudeCodeSseStartupFailure(pendingText);
      if (pendingFailure) {
        failure = withClaudeCodeRateLimitReset(pendingFailure, response.headers);
      } else if (isClaudeCodeStartupOutputFrame(pendingText)) {
        downstreamVisible = true;
      }
    }
  }

  if (failure) {
    await reader.cancel().catch(() => undefined);
    return {
      failure,
      downstreamVisible: false,
      response: jsonResponse(
        {
          error: {
            type: failure.code ?? "upstream_error",
            message: failure.message ?? "Claude Code upstream failed before producing output.",
            upstream_status: "error",
          },
        },
        {
          status: failure.httpStatus ?? 502,
          headers: createClaudeCodeFailureHeaders(failure, response.headers),
        },
      ),
    };
  }

  return {
    downstreamVisible,
    response: new Response(replayResponseBody(chunks, reader), {
      status: response.status,
      statusText: response.statusText,
      headers: filterStreamingResponseHeaders(response.headers),
    }),
  };
}

function withClaudeCodeRateLimitReset(
  failure: AccountFailureSignal,
  headers: Headers,
): AccountFailureSignal {
  if (failure.class !== "rate_limit" && failure.class !== "quota") return failure;

  const resetAt = readClaudeCodeRateLimitResetAt(headers) ?? failure.resetAt;
  return {
    ...failure,
    metadata: {
      ...failure.metadata,
      ...readClaudeCodeRateLimitMetadata(headers),
    },
    resetAt,
    retryAfterSeconds: secondsUntilIso(resetAt) ?? failure.retryAfterSeconds,
  };
}

function inferClaudeCodeHttpFailure(response: Response): AccountFailureSignal | undefined {
  if (response.status !== 429) return undefined;
  const resetAt = readClaudeCodeRateLimitResetAt(response.headers);
  return {
    class: "rate_limit",
    code: "rate_limit",
    httpStatus: 429,
    metadata: readClaudeCodeRateLimitMetadata(response.headers),
    phase: "startup",
    resetAt,
    retryAfterSeconds: secondsUntilIso(resetAt),
    retryScope: "next_account",
  };
}

function createClaudeCodeFailureHeaders(
  failure: AccountFailureSignal,
  upstreamHeaders: Headers,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of upstreamHeaders.entries()) {
    if (key.startsWith("anthropic-ratelimit") || key.startsWith("x-ratelimit") || key === "request-id") {
      headers[key] = value;
    }
  }
  if (failure.retryAfterSeconds) headers["retry-after"] = String(failure.retryAfterSeconds);
  if (failure.resetAt) headers["x-kyoli-account-reset-at"] = failure.resetAt;
  return headers;
}

function replayResponseBody(
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
        return;
      }
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function drainSseFrames(buffer: string, onFrame: (frame: string) => void): string {
  let remainder = buffer;

  while (true) {
    const normalizedIndex = remainder.indexOf("\n\n");
    const windowsIndex = remainder.indexOf("\r\n\r\n");
    const indexes = [normalizedIndex, windowsIndex].filter((index) => index >= 0);
    if (indexes.length === 0) return remainder;

    const index = Math.min(...indexes);
    const separatorLength = remainder.startsWith("\r\n\r\n", index) ? 4 : 2;
    const frame = remainder.slice(0, index);
    remainder = remainder.slice(index + separatorLength);
    if (frame.trim()) onFrame(frame);
  }
}

function filterStreamingResponseHeaders(headers: Headers): Headers {
  const filtered = new Headers(headers);
  filtered.delete("content-encoding");
  filtered.delete("content-length");
  filtered.delete("transfer-encoding");
  filtered.delete("connection");
  return filtered;
}

function byteLength(chunks: Uint8Array[]): number {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}

function parseRejectedBetaFlags(body: string): string[] {
  if (!body.includes("anthropic-beta")) return [];

  const flags: string[] = [];
  const match = body.match(/Unexpected value\(s\)\s+((?:`[^`]+`(?:\s*,\s*)?)+)\s+for the `anthropic-beta` header/);
  if (!match?.[1]) return flags;

  for (const token of match[1].matchAll(/`([^`]+)`/g)) {
    if (token[1]) flags.push(token[1]);
  }
  return flags;
}

function isLongContextBetaError(body: string): boolean {
  return body.includes("long context") ||
    body.includes("Extra usage is required") ||
    body.includes("long_context");
}

function getRejectedBetaSet(
  rejectedBetasByAccount: Map<string, Set<string>>,
  accountKey: string,
): Set<string> {
  const existing = rejectedBetasByAccount.get(accountKey);
  if (existing) return existing;

  const next = new Set<string>();
  rejectedBetasByAccount.set(accountKey, next);
  return next;
}

async function readOAuthCredential(input: {
  accounts: AccountPool | undefined;
  sessionKey: string;
  excludeAccountIds: string[];
  tokenRefresh: ClaudeCodeTokenRefresh;
}): Promise<ClaudeCodeCredential | undefined> {
  const selection = input.accounts?.selectWithDiagnostics
    ? await input.accounts.selectWithDiagnostics({
      provider: "claude-code",
      kind: "oauth",
      sessionKey: input.sessionKey,
      excludeAccountIds: input.excludeAccountIds,
    })
    : {
      account: await input.accounts?.select({
        provider: "claude-code",
        kind: "oauth",
        sessionKey: input.sessionKey,
        excludeAccountIds: input.excludeAccountIds,
      }),
      diagnostics: undefined,
    };
  const account = selection?.account;
  if (!account) return undefined;

  const refreshToken = readString(account.credentials.refreshToken);
  let accessToken = readString(account.credentials.accessToken);
  let expiresAt = readNumber(account.credentials.expiresAt);

  if (!refreshToken && !accessToken) return undefined;

  if (!accessToken || !expiresAt || expiresAt <= Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    if (!refreshToken) return undefined;

    const refreshed = await input.tokenRefresh(refreshToken).catch(async (error) => {
      await input.accounts?.recordFailure(account.id, {
        status: 401,
        message: error instanceof Error ? error.message : String(error),
        reauthRequiredReason: "Claude Code OAuth token refresh failed",
      });
      throw new CredentialUnavailableError("Claude Code OAuth token refresh failed", account.id);
    });

    accessToken = refreshed.accessToken;
    expiresAt = refreshed.expiresAt;

    await input.accounts?.update(account.id, {
      credentials: {
        ...account.credentials,
        accessToken,
        expiresAt,
        refreshToken: refreshed.refreshToken ?? refreshToken,
        accountId: refreshed.accountId ?? account.credentials.accountId,
      },
      metadata: {
        ...account.metadata,
        email: refreshed.email ?? account.metadata.email,
        accountId: refreshed.accountId ?? account.metadata.accountId,
      },
    });
  }

  return {
    value: accessToken,
    accountId: account.id,
    selectionDiagnostics: selection?.diagnostics as Record<string, unknown> | undefined,
    metadata: {
      ...account.metadata,
      accountId: account.metadata.accountId ?? account.credentials.accountId,
    },
  };
}

async function refreshClaudeCodeUsageForAccount(input: {
  account: AccountRecord;
  tokenRefresh: ClaudeCodeTokenRefresh;
  usageRefresh: ClaudeCodeUsageRefresh;
}): Promise<ProviderUsageRefreshResult> {
  const refreshToken = readString(input.account.credentials.refreshToken);
  let accessToken = readString(input.account.credentials.accessToken);
  let expiresAt = readNumber(input.account.credentials.expiresAt);
  let credentials = input.account.credentials;
  let metadata = input.account.metadata;

  if (!accessToken || !expiresAt || expiresAt <= Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    if (!refreshToken) {
      return {
        ok: false,
        status: 401,
        message: "Claude Code account has no refresh token for usage refresh.",
        reauthRequiredReason: "Claude Code OAuth token refresh failed",
      };
    }

    const refreshed = await input.tokenRefresh(refreshToken).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    if ("error" in refreshed) {
      return {
        ok: false,
        status: 401,
        message: refreshed.error,
        reauthRequiredReason: "Claude Code OAuth token refresh failed",
      };
    }

    accessToken = refreshed.accessToken;
    expiresAt = refreshed.expiresAt;
    credentials = {
      ...credentials,
      accessToken,
      expiresAt,
      refreshToken: refreshed.refreshToken ?? refreshToken,
      accountId: refreshed.accountId ?? credentials.accountId,
    };
    metadata = {
      ...metadata,
      email: refreshed.email ?? metadata.email,
      accountId: refreshed.accountId ?? metadata.accountId,
    };
  }

  if (!accessToken) {
    return {
      ok: false,
      status: 401,
      message: "Claude Code account has no access token for usage refresh.",
      reauthRequiredReason: "Claude Code OAuth token refresh failed",
    };
  }

  const refreshed = await input.usageRefresh(accessToken).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  if ("error" in refreshed) {
    return {
      ok: false,
      status: 0,
      message: refreshed.error,
    };
  }

  return {
    ok: true,
    credentials,
    metadata: {
      ...metadata,
      email: refreshed.email ?? metadata.email,
      planTier: refreshed.planTier ?? metadata.planTier,
      cachedUsage: refreshed.cachedUsage ?? metadata.cachedUsage,
      cachedUsageAt: refreshed.cachedUsageAt ?? metadata.cachedUsageAt,
    },
  };
}

function readClaudeCodeRateLimitResetAt(headers: Headers): string | undefined {
  const reset = headers.get("anthropic-ratelimit-unified-reset");
  if (reset) {
    const seconds = Number.parseInt(reset, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(seconds * 1000).toISOString();
    }
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;

  const retryAfterSeconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return new Date(Date.now() + retryAfterSeconds * 1000).toISOString();
  }

  const retryAfterDate = new Date(retryAfter);
  return Number.isNaN(retryAfterDate.getTime()) ? undefined : retryAfterDate.toISOString();
}

function readClaudeCodeRateLimitMetadata(headers: Headers): Record<string, unknown> {
  const parsed = parseClaudeCodeRateLimitHeaders(headers);
  if (!parsed) return {};

  return {
    cachedUsage: parsed.cachedUsage,
    cachedUsageAt: Date.now(),
    rateLimitClaim: parsed.claim,
    rateLimitStatus: parsed.status,
    rateLimitResetAt: parsed.resetAt,
  };
}

function parseClaudeCodeRateLimitHeaders(headers: Headers): {
  cachedUsage: Record<string, unknown>;
  claim: string;
  resetAt?: string;
  status: string;
} | undefined {
  const status = headers.get("anthropic-ratelimit-unified-status");
  const util5h = readUtilization(headers.get("anthropic-ratelimit-unified-5h-utilization"));
  const util7d = readUtilization(headers.get("anthropic-ratelimit-unified-7d-utilization"));
  const claim = headers.get("anthropic-ratelimit-unified-representative-claim") ?? "unknown";
  const resetAt = readClaudeCodeRateLimitResetAt(headers);
  const cachedUsage: Record<string, unknown> = {};

  if (util5h !== undefined) {
    cachedUsage.five_hour = { utilization: util5h, resets_at: resetAt ?? null };
  }
  if (util7d !== undefined) {
    cachedUsage.seven_day = { utilization: util7d, resets_at: resetAt ?? null };
  }

  for (const [name, value] of headers.entries()) {
    const match = name.match(/^anthropic-ratelimit-unified-7d_([a-z0-9-]+)-utilization$/i);
    if (!match?.[1]) continue;
    const utilization = readUtilization(value);
    if (utilization === undefined) continue;
    cachedUsage[`seven_day_${match[1].toLowerCase()}`] = {
      utilization,
      resets_at: resetAt ?? null,
    };
  }

  if (!status && Object.keys(cachedUsage).length === 0) return undefined;

  return {
    cachedUsage,
    claim,
    resetAt,
    status: status ?? "unknown",
  };
}

function resolvePacingOptions(
  explicit: Partial<ClaudeCodePacingOptions> | false | undefined,
): ClaudeCodePacingOptions {
  if (explicit === false) return { jitterMs: 0, minGapMs: 0 };

  return {
    jitterMs: readNonNegativeInteger(explicit?.jitterMs) ??
      readNonNegativeInteger(process.env.KYOLI_CLAUDE_PACE_JITTER_MS) ??
      0,
    minGapMs: readNonNegativeInteger(explicit?.minGapMs) ??
      readNonNegativeInteger(process.env.KYOLI_CLAUDE_PACE_MIN_MS) ??
      0,
  };
}

function createClaudeCodePacer(options: ClaudeCodePacingOptions): () => Promise<void> {
  let nextStartAt = 0;
  const minGapMs = Math.max(0, options.minGapMs);
  const jitterMs = Math.max(0, options.jitterMs);

  return async () => {
    if (minGapMs === 0 && jitterMs === 0) return;

    const now = Date.now();
    const delayMs = Math.max(0, nextStartAt - now);
    const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
    nextStartAt = Math.max(now, nextStartAt) + minGapMs + jitter;
    if (delayMs > 0) {
      await sleep(delayMs);
    }
  };
}

function resolveSessionRotationOptions(
  explicit: Partial<ClaudeCodeSessionRotationOptions> | undefined,
): ClaudeCodeSessionRotationOptions {
  return {
    idleTtlMs: readNonNegativeInteger(explicit?.idleTtlMs) ??
      readNonNegativeInteger(process.env.KYOLI_CLAUDE_SESSION_IDLE_MS) ??
      0,
    idleJitterMs: readNonNegativeInteger(explicit?.idleJitterMs) ??
      readNonNegativeInteger(process.env.KYOLI_CLAUDE_SESSION_JITTER_MS) ??
      0,
    maxAgeMs: readNonNegativeInteger(explicit?.maxAgeMs) ??
      readNonNegativeInteger(process.env.KYOLI_CLAUDE_SESSION_MAX_AGE_MS) ??
      0,
  };
}

function readBooleanEnv(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function readNonNegativeInteger(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transformRequestBody(
  body: unknown,
  options: {
    identity: Required<ClaudeCodeIdentity>;
    model?: string;
    route: string;
    sessionKey: string;
    sessionId: string;
  },
): {
  body: unknown;
  reverseLookup: ReverseToolLookup;
} {
  const reverseLookup: ReverseToolLookup = new Map();
  if (!body || typeof body !== "object") {
    return { body, reverseLookup };
  }

  let record = { ...(body as Record<string, unknown>) };
  const requestModel = readString(record.model) ?? options.model;
  if (typeof record.model === "string") {
    record.model = toClaudeCodeWireModelId(record.model);
  }

  const hadIncomingTools = Array.isArray(record.tools) && record.tools.length > 0;
  stripCacheControl(record);
  removeUnsupportedClaudeCodeFields(record);
  if (options.route === "/v1/messages") {
    record = applyClaudeCodeUpstreamBodyFields(record, {
      agentIdentity: CLAUDE_CODE_AGENT_IDENTITY,
      bodyFieldOrder: templateMetadata.bodyFieldOrder,
      ccVersion: CLAUDE_CODE_VERSION,
      cch: randomCch(),
      defaultTools: getClaudeCodeTemplateTools(),
      identity: {
        accountUuid: options.identity.accountUuid,
        deviceId: options.identity.deviceId,
      },
      sessionId: options.sessionId,
      systemPrompt: CLAUDE_CODE_SYSTEM_PROMPT,
    });
    if (requestModel && isClaudeFableModel(requestModel) && !hadIncomingTools && Array.isArray(record.tools) && record.tools.length > 0) {
      record.tool_choice = { type: "none" };
    }
  }

  const transformed = applyClaudeToolFlow(record);
  return {
    body: transformed.payload,
    reverseLookup: transformed.reverseLookup,
  };
}

function randomCch(): string {
  return randomBytes(3).toString("hex").slice(0, 5);
}

function buildUpstreamHeaders(input: {
  headers: Headers;
  accessToken: string;
  excludedBetas?: Set<string>;
  fingerprint: ClaudeCodeRequestFingerprint;
  retryCount?: number;
  sessionId: string;
  trustClientFingerprint: boolean;
  model: string | undefined;
}): HeadersInit {
  const { headers, accessToken, fingerprint } = input;
  const upstream = new Headers(headers);
  upstream.delete("authorization");
  upstream.delete("x-api-key");
  upstream.delete("host");
  upstream.delete("content-length");
  upstream.delete("connection");
  upstream.delete("accept-encoding");
  deleteClaudeCodeFingerprintHeaders(upstream);

  upstream.set("accept", "application/json");
  upstream.set("authorization", `Bearer ${accessToken}`);
  upstream.set("content-type", "application/json");

  upstream.set("anthropic-version", readTrustedHeader(input, "anthropic-version", fingerprint.anthropicVersion));
  upstream.set(
    "anthropic-dangerous-direct-browser-access",
    readTrustedHeader(input, "anthropic-dangerous-direct-browser-access", fingerprint.browserAccess),
  );
  upstream.set("user-agent", readTrustedHeader(input, "user-agent", fingerprint.userAgent));
  upstream.set("x-app", readTrustedHeader(input, "x-app", fingerprint.xApp));
  upstream.set(
    "anthropic-beta",
    mergeBetaHeaders(
      input.trustClientFingerprint ? headers.get("anthropic-beta") : null,
      getClaudeCodeBetasForModel(fingerprint.anthropicBeta, input.model, input.excludedBetas),
      input.excludedBetas,
    ),
  );
  upstream.set(
    "x-claude-code-session-id",
    readTrustedHeader(input, "x-claude-code-session-id", input.sessionId),
  );
  upstream.set("x-client-request-id", readTrustedHeader(input, "x-client-request-id", randomUUID()));
  upstream.set("x-stainless-arch", readTrustedHeader(input, "x-stainless-arch", fingerprint.stainlessArch));
  upstream.set("x-stainless-lang", readTrustedHeader(input, "x-stainless-lang", fingerprint.stainlessLang));
  upstream.set("x-stainless-os", readTrustedHeader(input, "x-stainless-os", fingerprint.stainlessOs));
  upstream.set(
    "x-stainless-package-version",
    readTrustedHeader(input, "x-stainless-package-version", fingerprint.packageVersion),
  );
  upstream.set("x-stainless-retry-count", readTrustedHeader(input, "x-stainless-retry-count", String(input.retryCount ?? 0)));
  upstream.set("x-stainless-runtime", readTrustedHeader(input, "x-stainless-runtime", fingerprint.runtime));
  upstream.set(
    "x-stainless-runtime-version",
    readTrustedHeader(input, "x-stainless-runtime-version", fingerprint.runtimeVersion),
  );
  upstream.set("x-stainless-timeout", readTrustedHeader(input, "x-stainless-timeout", fingerprint.timeoutSeconds));
  return orderHeadersForOutbound(upstream, templateMetadata.headerOrder);
}

function orderHeadersForOutbound(
  headers: Headers,
  headerOrder: string[] | undefined,
): HeadersInit {
  if (!Array.isArray(headerOrder) || headerOrder.length === 0) return headers;

  const ordered: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const name of headerOrder) {
    const key = name.toLowerCase();
    const value = headers.get(key);
    if (value === null || seen.has(key)) continue;
    ordered.push([name, value]);
    seen.add(key);
  }

  for (const [key, value] of headers) {
    if (seen.has(key)) continue;
    ordered.push([key, value]);
  }
  return ordered;
}

function createClaudeCodeRequestFingerprint(
  override: Partial<ClaudeCodeRequestFingerprint> = {},
): ClaudeCodeRequestFingerprint {
  return {
    anthropicBeta: CLAUDE_CODE_BETA,
    anthropicVersion: CLAUDE_CODE_ANTHROPIC_VERSION,
    browserAccess: CLAUDE_CODE_BROWSER_ACCESS,
    packageVersion: templateHeaders["x-stainless-package-version"] ?? STAINLESS_PACKAGE_VERSION,
    runtime: "node",
    runtimeVersion: process.version,
    stainlessArch: process.arch,
    stainlessLang: "js",
    stainlessOs: getOsName(),
    timeoutSeconds: CLAUDE_CODE_TIMEOUT_SECONDS,
    userAgent: CLAUDE_CODE_USER_AGENT,
    xApp: CLAUDE_CODE_X_APP,
    ...override,
  };
}

function readTrustedHeader(
  input: { headers: Headers; trustClientFingerprint: boolean },
  name: string,
  fallback: string,
): string {
  if (!input.trustClientFingerprint) return fallback;
  return input.headers.get(name) ?? fallback;
}

function deleteClaudeCodeFingerprintHeaders(headers: Headers): void {
  for (const header of [
    "anthropic-beta",
    "anthropic-dangerous-direct-browser-access",
    "anthropic-version",
    "user-agent",
    "x-app",
    "x-claude-code-session-id",
    "x-client-request-id",
    "x-stainless-arch",
    "x-stainless-lang",
    "x-stainless-os",
    "x-stainless-package-version",
    "x-stainless-retry-count",
    "x-stainless-runtime",
    "x-stainless-runtime-version",
    "x-stainless-timeout",
  ]) {
    headers.delete(header);
  }
}

async function transformResponse(
  response: Response,
  reverseLookup: ReverseToolLookup,
  options: {
    drainOnCancel: boolean;
    drainTimeoutMs: number;
  } = { drainOnCancel: false, drainTimeoutMs: 5 * 60 * 1000 },
): Promise<Response> {
  if (!response.body) return response;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return transformEventStreamResponse(response, reverseLookup, options);
  }

  if (!contentType.includes("application/json")) return response;

  try {
    const payload = await response.clone().json();
    const transformed = reverseClaudeToolFlow(enrichClaudeCodeErrorPayload(payload, response), reverseLookup);
    return new Response(JSON.stringify(transformed), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    return response;
  }
}

function enrichClaudeCodeErrorPayload(payload: unknown, response: Response): unknown {
  if (response.status !== 429 || !payload || typeof payload !== "object") return payload;

  const record = payload as Record<string, unknown>;
  const error = readRecord(record.error);
  if (!error || (error.message && error.message !== "Error")) return payload;

  error.message = describeClaudeCodeRateLimit(response.headers);
  return payload;
}

function describeClaudeCodeRateLimit(headers: Headers): string {
  const claim = headers.get("anthropic-ratelimit-unified-representative-claim") ?? "unknown";
  const status = headers.get("anthropic-ratelimit-unified-status") ?? "rejected";
  const parts = [`Rate limited (${status}). Limiting window: ${claim}`];
  const util5h = readUtilization(headers.get("anthropic-ratelimit-unified-5h-utilization"));
  const util7d = readUtilization(headers.get("anthropic-ratelimit-unified-7d-utilization"));
  const resetAt = readClaudeCodeRateLimitResetAt(headers);

  if (util5h !== undefined) parts.push(`5h utilization: ${Math.round(util5h * 100)}%`);
  if (util7d !== undefined) parts.push(`7d utilization: ${Math.round(util7d * 100)}%`);
  if (resetAt) parts.push(`resets in ${formatMinutesUntil(resetAt)}m`);
  return parts.join(". ");
}

function readUtilization(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatMinutesUntil(iso: string): number {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.round((timestamp - Date.now()) / 60_000));
}

function secondsUntilIso(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : undefined;
}

function transformEventStreamResponse(
  response: Response,
  reverseLookup: ReverseToolLookup,
  options: {
    drainOnCancel: boolean;
    drainTimeoutMs: number;
  },
): Response {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(remapSseChunk(buffer, reverseLookup)));
        controller.close();
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (lines.length > 0) {
        controller.enqueue(encoder.encode(`${remapSseChunk(lines.join("\n"), reverseLookup)}\n`));
      }
    },
    async cancel(reason) {
      if (options.drainOnCancel) {
        void drainReader(reader, options.drainTimeoutMs);
        return;
      }
      await reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function drainReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<void> {
  let timedOut = false;
  const timeoutAt = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  try {
    while (Date.now() < timeoutAt) {
      const remainingMs = timeoutAt - Date.now();
      const result = await readWithTimeout(reader, remainingMs);
      if (result === "timeout") {
        timedOut = true;
        break;
      }
      if (result.done) return;
      // Drain upstream to EOF after the downstream consumer has gone away.
    }
  } catch {
    // Downstream cancellation should not surface background drain errors.
  }
  if (timedOut || Date.now() >= timeoutAt) {
    await reader.cancel("claude-drain-timeout").catch(() => undefined);
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array> | "timeout"> {
  if (!Number.isFinite(timeoutMs)) return reader.read();
  if (timeoutMs <= 0) return "timeout";

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remapSseChunk(chunk: string, reverseLookup: ReverseToolLookup): string {
  return chunk
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const payload = line.slice(5).trimStart();
      if (!payload || payload === "[DONE]") return line;

      try {
        return `data: ${JSON.stringify(reverseClaudeToolFlow(JSON.parse(payload), reverseLookup))}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

function stripCacheControl(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripCacheControl(item);
    return;
  }

  if (!value || typeof value !== "object") return;
  delete (value as Record<string, unknown>).cache_control;

  for (const nested of Object.values(value as Record<string, unknown>)) {
    stripCacheControl(nested);
  }
}

function removeUnsupportedClaudeCodeFields(body: Record<string, unknown>): void {
  delete body.temperature;
  delete body.top_p;
  delete body.top_k;
}

function splitBetaHeader(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function getClaudeCodeBetasForModel(
  defaults: string,
  model: string | undefined,
  excludedBetas: Set<string> = new Set(),
): string {
  const normalizedModel = model ? resolveClaudeCodeModelAlias(model).toLowerCase() : "";
  const values = splitBetaHeader(defaults);
  const add = (beta: string): void => {
    if (!excludedBetas.has(beta) && !values.includes(beta)) values.push(beta);
  };
  const drop = (beta: string): void => {
    const index = values.indexOf(beta);
    if (index !== -1) values.splice(index, 1);
  };

  if (model && isClaudeFableModel(model)) {
    add(FABLE_FALLBACK_CREDIT_BETA);
  }
  if (model && isClaudeCode1mModelLabel(model)) {
    add(CONTEXT_1M_BETA);
  }
  if (normalizedModel.includes("haiku")) {
    drop(MID_CONVERSATION_SYSTEM_BETA);
    drop(EFFORT_BETA);
  } else if (normalizedModel.includes("sonnet")) {
    drop(MID_CONVERSATION_SYSTEM_BETA);
  }

  return values.filter((beta) => !excludedBetas.has(beta)).join(",");
}

function mergeBetaHeaders(
  incoming: string | null,
  defaults: string,
  excludedBetas: Set<string> = new Set(),
): string {
  const values = [
    ...defaults.split(","),
    ...(incoming ? incoming.split(",") : []),
  ]
    .map((value) => value.trim())
    .filter(
      (value) =>
        value.length > 0 &&
        !excludedBetas.has(value) &&
        !BILLABLE_BETA_PREFIXES.some((prefix) => value.startsWith(prefix)),
    );

  return [...new Set(values)].join(",");
}

function getClaudeSessionId(
  sessionKey: string,
  options: ClaudeCodeSessionRotationOptions,
): string {
  const now = Date.now();
  const existing = sessionIdsByKey.get(sessionKey);
  if (existing && !shouldRotateSession(existing, options, now)) {
    existing.lastUsedAt = now;
    return existing.id;
  }

  const next = randomUUID();
  sessionIdsByKey.set(sessionKey, {
    createdAt: now,
    id: next,
    idleJitterMs: sampleJitter(options.idleJitterMs),
    lastUsedAt: now,
  });
  return next;
}

function shouldRotateSession(
  state: ClaudeSessionState,
  options: ClaudeCodeSessionRotationOptions,
  now: number,
): boolean {
  if (options.maxAgeMs > 0 && now - state.createdAt >= options.maxAgeMs) return true;
  const idleTtlMs = options.idleTtlMs + state.idleJitterMs;
  if (options.idleTtlMs > 0 && now - state.lastUsedAt >= idleTtlMs) return true;
  return false;
}

function sampleJitter(jitterMs: number): number {
  if (jitterMs <= 0) return 0;
  return Math.floor(Math.random() * jitterMs);
}

function getOsName(): string {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "darwin") return "MacOS";
  return "Linux";
}

function createUpstreamUrl(baseUrl: string, route: string): string {
  const url = new URL(`${baseUrl}${route}`);
  if (route === "/v1/messages" && !url.searchParams.has("beta")) {
    url.searchParams.set("beta", "true");
  }
  return url.toString();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function readCredentialAccountUuid(credential: ClaudeCodeCredential): string {
  return readString(credential.metadata.accountId) ?? credential.accountId ?? "unknown";
}

function readCredentialCacheKey(credential: ClaudeCodeCredential): string {
  return credential.accountId ?? createHash("sha256").update(credential.value).digest("hex").slice(0, 16);
}

function resolveRequestIdentity(
  credential: ClaudeCodeCredential,
  override: ClaudeCodeIdentity | undefined,
): Required<ClaudeCodeIdentity> {
  const local = override ?? loadClaudeCodeIdentity();
  return {
    accountUuid: readCredentialAccountUuid(credential) ?? local.accountUuid ?? "unknown",
    deviceId: readString(credential.metadata.deviceId) ?? local.deviceId ?? fallbackDeviceId,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
