import type {
  AccountExecutionResult,
  AccountFailureSignal,
  AccountExecutionTraceEvent,
  AccountPool,
  GatewayWebSocketContext,
  GatewayWebSocketMessage,
  ModelInfo,
  ProviderAdapter,
} from "@kyoli-gam/core";
import {
  executeWithAccountFailover,
  CredentialUnavailableError,
  jsonResponse,
  stripProviderPrefix,
  type SelectedCredential,
} from "@kyoli-gam/core";
import { WebSocket as WsWebSocket } from "ws";
import {
  classifyCodexJsonEventFailure,
  classifyCodexSseStartupFailure,
  CODEX_UNKNOWN_RATE_LIMIT_BACKOFF_MS,
  isCodexStartupOutputEvent,
  isCodexStartupOutputFrame,
} from "./failures";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_WEBSOCKET_ENDPOINT = "wss://chatgpt.com/backend-api/codex/responses";
const CODEX_COMPACT_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses/compact";
const CODEX_BACKEND_API_BASE = "https://chatgpt.com/backend-api";
const CODEX_TRANSCRIBE_ENDPOINT = "https://chatgpt.com/backend-api/transcribe";
const DEFAULT_IMAGE_HOST_MODEL = "gpt-5.5";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_BRIDGE_ORIGINATOR = "codex_chatgpt_desktop";
const CODEX_USER_AGENT = "codex_cli_rs/0.0.0";
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
const CODEX_STARTUP_PROBE_MAX_BYTES = 64 * 1024;
const MAX_CODEX_FILE_SIZE_BYTES = 512 * 1024 * 1024;
const MAX_CHAT_IMAGE_DATA_URL_BYTES = 8 * 1024 * 1024;
const STREAM_TEXT_DECODER = new TextDecoder();
const STREAM_TEXT_ENCODER = new TextEncoder();
const DEFAULT_CHAT_COMPLETIONS_INSTRUCTIONS = "You are a helpful assistant.";
const CODEX_REASONING_INCLUDE = "reasoning.encrypted_content";
const RESPONSES_WEBSOCKET_BETA_HEADER = "responses_websockets=2026-02-06";
const WEBSOCKET_HOP_BY_HOP_HEADERS = new Set([
  "accept",
  "connection",
  "content-type",
  "content-length",
  "cookie",
  "host",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "upgrade",
]);
const NATIVE_CODEX_ORIGINATORS = new Set([
  "Codex Desktop",
  "codex_atlas",
  "codex_chatgpt_desktop",
  "codex_cli_rs",
  "codex_exec",
  "codex_vscode",
]);
const NATIVE_CODEX_STREAM_HEADERS = new Set([
  "x-codex-turn-state",
  "x-codex-turn-metadata",
  "x-codex-beta-features",
]);
const BRIDGE_FORWARD_HEADERS = new Set([
  "accept",
  "request-id",
  "x-request-id",
  "x-codex-conversation-id",
  "x-codex-session-id",
]);

const models: ModelInfo[] = [
  {
    id: "openai/gpt-5.3-codex",
    provider: "codex",
    upstreamId: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    aliases: ["gpt-5.3-codex", "codex/gpt-5.3-codex"],
    capabilities: ["chat", "responses", "tools", "streaming", "reasoning", "codex"],
  },
];

export interface CodexChatGPTProviderOptions {
  accounts?: AccountPool;
  fetch?: typeof fetch;
  webSocketFactory?: CodexWebSocketFactory;
  maxAccountAttempts?: number;
  tokenRefresh?: CodexTokenRefresh;
  onTrace?: (event: AccountExecutionTraceEvent) => void;
  fileFinalizePollDelayMs?: number;
  fileFinalizeBudgetMs?: number;
  compactTimeoutMs?: number;
  compactRequestBudgetMs?: number;
  compactRetryDelayMs?: number;
}

export { startCodexOAuthLogin, type CodexOAuthTokens } from "./oauth";

interface CodexCredential extends SelectedCredential {
  accountId?: string;
  chatgptAccountId?: string;
}

interface CodexTokenRefreshResult {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  accountId?: string;
}

type CodexTokenRefresh = (refreshToken: string) => Promise<CodexTokenRefreshResult>;

export interface CodexWebSocketLike {
  readyState?: number;
  binaryType?: string;
  send(data: string | Uint8Array | ArrayBuffer | Buffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: unknown) => void, options?: { once?: boolean }): void;
}

export type CodexWebSocketFactory = (
  url: string,
  protocols: string[],
  init: { headers: Record<string, string> },
) => CodexWebSocketLike;

interface ActiveCodexWebSocket {
  upstream: CodexWebSocketLike;
  credential: CodexCredential;
}

interface WebSocketRelayState {
  active: ActiveCodexWebSocket;
  context: GatewayWebSocketContext;
  options: CodexChatGPTProviderOptions;
  websocketFactory: CodexWebSocketFactory;
  excludedAccountIds: string[];
  replayableMessages: GatewayWebSocketMessage[];
  upstreamStartupText: string[];
  downstreamVisible: boolean;
  replayAttempts: number;
  retiredUpstreams: Set<CodexWebSocketLike>;
}

export function createCodexChatGPTProvider(
  options: CodexChatGPTProviderOptions = {},
): ProviderAdapter {
  const fetchImpl = options.fetch ?? fetch;
  const fileAccountById = new Map<string, string>();

  return {
    id: "codex",
    displayName: "Codex ChatGPT OAuth",
    routes: [
      "/v1/responses",
      "/v1/responses/compact",
      "/v1/chat/completions",
      "/v1/audio/transcriptions",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/images/variations",
      "/backend-api/codex/responses",
      "/backend-api/codex/responses/compact",
      "/backend-api/transcribe",
      "/backend-api/files",
      "/backend-api/files/uploaded",
    ],
    async listModels() {
      return models;
    },
    async handleRequest(context) {
      if (
        context.route !== "/v1/responses" &&
        context.route !== "/v1/responses/compact" &&
        context.route !== "/v1/chat/completions" &&
        context.route !== "/v1/audio/transcriptions" &&
        context.route !== "/v1/images/generations" &&
        context.route !== "/v1/images/edits" &&
        context.route !== "/v1/images/variations" &&
        context.route !== "/backend-api/codex/responses" &&
        context.route !== "/backend-api/codex/responses/compact" &&
        context.route !== "/backend-api/transcribe" &&
        context.route !== "/backend-api/files" &&
        context.route !== "/backend-api/files/uploaded"
      ) {
        return jsonResponse(
          {
            error: {
              type: "route_not_supported",
              message: `Codex OAuth passthrough is not implemented for ${context.route}.`,
            },
          },
          { status: 501 },
        );
      }

      if (context.route === "/v1/chat/completions") {
        return handleChatCompletionsRequest({ context, fetchImpl, options });
      }

      if (context.route === "/backend-api/transcribe" || context.route === "/v1/audio/transcriptions") {
        return handleTranscriptionRequest({ context, fetchImpl, options });
      }

      if (
        context.route === "/v1/images/generations" ||
        context.route === "/v1/images/edits" ||
        context.route === "/v1/images/variations"
      ) {
        return handleImagesRequest({ context, fetchImpl, options });
      }

      if (context.route === "/v1/responses") {
        return handleResponsesRequest({ context, fetchImpl, options, fileAccountById });
      }

      if (context.route === "/v1/responses/compact" || context.route === "/backend-api/codex/responses/compact") {
        return handleCompactRequest({ context, fetchImpl, options });
      }

      if (context.route === "/backend-api/files" || context.route === "/backend-api/files/uploaded") {
        return handleCodexFileRequest({
          context,
          fetchImpl,
          options,
          fileAccountById,
        });
      }

      const body = rewriteBodyModel(context.body);

      return executeWithAccountFailover({
        provider: "codex",
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
                  "Codex requests require a stored codex/oauth account. Add one with kyoli login codex.",
              },
            },
            { status: 401 },
          ),
        selectCredential: (excludeAccountIds) =>
          readOAuthCredential({
            accounts: options.accounts,
            sessionKey: context.sessionKey,
            excludeAccountIds,
            tokenRefresh: options.tokenRefresh ?? refreshCodexToken,
          }),
        execute: async (credential) =>
          normalizeCodexStartupFailure(await fetchImpl(createUpstreamUrl(context.route), {
            method: context.request.method,
            headers: buildUpstreamHeaders(
              context.request.headers,
              credential.value,
              (credential as CodexCredential).chatgptAccountId,
              { bridge: context.route.startsWith("/v1/") },
            ),
            body: body === undefined ? context.request.body : JSON.stringify(body),
            duplex: "half",
          } as RequestInit)),
        failureMessage: (status) => `Codex upstream returned ${status}`,
        readRateLimitResetAt: readCodexRateLimitResetAt,
        onTrace: options.onTrace,
        traceRoute: context.route,
        traceModel: typeof body === "object" && body && "model" in body
          ? readString((body as Record<string, unknown>).model)
          : context.model,
      });
    },
    async handleWebSocket(context) {
      if (context.route !== "/backend-api/codex/responses" && context.route !== "/v1/responses") {
        await context.websocket.accept();
        await sendWebSocketError(context, "route_not_supported", `Codex WebSocket is not implemented for ${context.route}.`);
        await context.websocket.close(1008, "Unsupported route");
        return;
      }
      await handleResponsesWebSocket({ context, options });
    },
  };
}

async function handleResponsesWebSocket(input: {
  context: GatewayWebSocketContext;
  options: CodexChatGPTProviderOptions;
}): Promise<void> {
  const { context, options } = input;
  const websocketFactory = options.webSocketFactory ?? createGlobalWebSocket;
  const turnState = context.request.headers.get("x-codex-turn-state") ?? crypto.randomUUID();
  const excludedAccountIds: string[] = [];

  await context.websocket.accept({ "x-codex-turn-state": turnState });

  const upstreamResult = await openResponsesWebSocketWithFailover({
    context,
    options,
    websocketFactory,
    excludeAccountIds: excludedAccountIds,
  });

  if (!upstreamResult.credential) {
    await sendWebSocketError(
      context,
      "missing_oauth_account",
      "Codex WebSocket requests require a stored codex/oauth account. Add one with kyoli login codex.",
    );
    await context.websocket.close(1008, "Missing OAuth account");
    return;
  }

  if (!upstreamResult.upstream) {
    await sendWebSocketError(
      context,
      "upstream_unavailable",
      upstreamResult.error?.message ?? "Codex WebSocket upstream connection failed.",
    );
    await context.websocket.close(1011, "Upstream unavailable");
    return;
  }

  const relayState: WebSocketRelayState = {
    active: { upstream: upstreamResult.upstream, credential: upstreamResult.credential },
    context,
    options,
    websocketFactory,
    excludedAccountIds,
    replayableMessages: [],
    upstreamStartupText: [],
    downstreamVisible: false,
    replayAttempts: 0,
    retiredUpstreams: new Set(),
  };
  relayUpstreamMessages(relayState, upstreamResult.upstream, upstreamResult.credential);

  while (true) {
    const message = await context.websocket.receive();
    if (message.type === "close") {
      relayState.active.upstream.close(message.code, message.reason);
      return;
    }
    if (message.type === "text") {
      rememberReplayableWebSocketMessage(relayState, message);
      relayState.active.upstream.send(message.data);
    } else {
      rememberReplayableWebSocketMessage(relayState, message);
      relayState.active.upstream.send(message.data);
    }
  }
}

async function openResponsesWebSocketWithFailover(input: {
  context: GatewayWebSocketContext;
  options: CodexChatGPTProviderOptions;
  websocketFactory: CodexWebSocketFactory;
  excludeAccountIds?: string[];
}): Promise<{
  credential?: CodexCredential;
  upstream?: CodexWebSocketLike;
  error?: Error;
}> {
  const excludedAccountIds = [...(input.excludeAccountIds ?? [])];
  const maxAttempts = Math.max(1, input.options.maxAccountAttempts ?? 10);
  let lastCredential: CodexCredential | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const credential = await readOAuthCredential({
      accounts: input.options.accounts,
      sessionKey: input.context.sessionKey,
      excludeAccountIds: excludedAccountIds,
      tokenRefresh: input.options.tokenRefresh ?? refreshCodexToken,
    }).catch((error) => {
      if (error instanceof CredentialUnavailableError) {
        excludedAccountIds.push(error.accountId);
        return undefined;
      }
      throw error;
    });
    if (!credential) {
      if (excludedAccountIds.length > 0) continue;
      return {};
    }

    lastCredential = credential;
    const upstream = input.websocketFactory(CODEX_WEBSOCKET_ENDPOINT, [], {
      headers: buildUpstreamWebSocketHeaders(
        input.context.request.headers,
        credential.value,
        credential.chatgptAccountId,
      ),
    });
    upstream.binaryType = "arraybuffer";

    try {
      await waitForWebSocketOpen(upstream);
      if (credential.accountId) {
        await input.options.accounts?.recordSuccess(credential.accountId, { kind: "transport" });
      }
      return { credential, upstream };
    } catch (error) {
      upstream.close();
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!credential.accountId) return { credential, error: lastError };
      await input.options.accounts?.recordFailure(credential.accountId, {
        status: 502,
        message: lastError.message,
      });
      excludedAccountIds.push(credential.accountId);
    }
  }

  return { credential: lastCredential, error: lastError };
}

async function handleResponsesRequest(input: {
  context: Parameters<ProviderAdapter["handleRequest"]>[0];
  fetchImpl: typeof fetch;
  options: CodexChatGPTProviderOptions;
  fileAccountById: Map<string, string>;
}): Promise<Response> {
  const requestBody = readRecord(input.context.body);
  const upstreamBody = applyOpenAIResponsesCodexDefaults(
    rewriteBodyModel({
      ...(requestBody ?? {}),
      stream: true,
    }),
  );
  const preferredAccountId = input.context.sessionKey.startsWith("fallback:")
    ? resolveFileAccountForInput(requestBody?.input, input.fileAccountById)
    : undefined;
  const upstream = await executeWithAccountFailover({
    provider: "codex",
    kind: "oauth",
    accounts: input.options.accounts,
    sessionKey: input.context.sessionKey,
    maxAttempts: input.options.maxAccountAttempts,
    sameAccountMaxRetries: 1,
    missingCredentialResponse: () =>
      jsonResponse(
        {
          error: {
            type: "missing_oauth_account",
            message:
              "Codex requests require a stored codex/oauth account. Add one with kyoli login codex.",
          },
        },
        { status: 401 },
      ),
    selectCredential: (excludeAccountIds) =>
      readOAuthCredential({
        accounts: input.options.accounts,
        sessionKey: input.context.sessionKey,
        excludeAccountIds,
        preferredAccountId,
        tokenRefresh: input.options.tokenRefresh ?? refreshCodexToken,
      }),
    execute: async (credential) =>
      normalizeCodexStartupFailure(await input.fetchImpl(createUpstreamUrl(input.context.route), {
        method: input.context.request.method,
        headers: buildUpstreamHeaders(
          input.context.request.headers,
          credential.value,
          (credential as CodexCredential).chatgptAccountId,
          { bridge: true },
        ),
        body: JSON.stringify(upstreamBody),
        duplex: "half",
      } as RequestInit)),
    failureMessage: (status) => `Codex upstream returned ${status}`,
    readRateLimitResetAt: readCodexRateLimitResetAt,
    onTrace: input.options.onTrace,
    traceRoute: input.context.route,
    traceModel: typeof upstreamBody === "object" && upstreamBody && "model" in upstreamBody
      ? readString((upstreamBody as Record<string, unknown>).model)
      : input.context.model,
  });

  if (!upstream.ok || requestBody?.stream === true) return upstream;
  return jsonResponse(await convertResponsesStreamToResponsePayload(upstream, requestBody ?? {}), {
    status: upstream.status,
  });
}

async function handleChatCompletionsRequest(input: {
  context: Parameters<ProviderAdapter["handleRequest"]>[0];
  fetchImpl: typeof fetch;
  options: CodexChatGPTProviderOptions;
}): Promise<Response> {
  const body = readRecord(input.context.body);
  if (!body) {
    return validationError("Chat completions requires a JSON object body.").response;
  }
  const converted = convertChatCompletionBodyToResponses(body);
  if (!converted.ok) return converted.response;
  const responsesBody = applyOpenAIResponsesCodexDefaults(
    rewriteBodyModel({
      ...converted.value,
      stream: true,
    }),
  );
  const upstream = await executeWithAccountFailover({
    provider: "codex",
    kind: "oauth",
    accounts: input.options.accounts,
    sessionKey: input.context.sessionKey,
    maxAttempts: input.options.maxAccountAttempts,
    sameAccountMaxRetries: 1,
    missingCredentialResponse: () =>
      jsonResponse(
        {
          error: {
            type: "missing_oauth_account",
            message:
              "Codex requests require a stored codex/oauth account. Add one with kyoli login codex.",
          },
        },
        { status: 401 },
      ),
    selectCredential: (excludeAccountIds) =>
      readOAuthCredential({
        accounts: input.options.accounts,
        sessionKey: input.context.sessionKey,
        excludeAccountIds,
        tokenRefresh: input.options.tokenRefresh ?? refreshCodexToken,
      }),
    execute: async (credential) =>
      normalizeCodexStartupFailure(await input.fetchImpl(CODEX_API_ENDPOINT, {
        method: "POST",
        headers: buildUpstreamHeaders(
          input.context.request.headers,
          credential.value,
          (credential as CodexCredential).chatgptAccountId,
          { bridge: true },
        ),
        body: JSON.stringify(responsesBody),
        duplex: "half",
      } as RequestInit)),
    failureMessage: (status) => `Codex upstream returned ${status}`,
    readRateLimitResetAt: readCodexRateLimitResetAt,
    onTrace: input.options.onTrace,
    traceRoute: input.context.route,
    traceModel: typeof responsesBody === "object" && responsesBody && "model" in responsesBody
      ? readString((responsesBody as Record<string, unknown>).model)
      : input.context.model,
  });

  if (!upstream.ok) return upstream;
  if (body.stream === true) {
    return convertResponsesStreamToChatCompletions(upstream, body);
  }

  let payload = upstream.headers.get("content-type")?.includes("text/event-stream")
    ? await convertResponsesStreamToResponsePayload(upstream, body)
    : await readJsonRecord(upstream.clone());
  payload ??= await convertResponsesStreamToResponsePayload(upstream, body);
  if (!payload) return upstream;
  return jsonResponse(convertResponsesPayloadToChatCompletion(payload, body), {
    status: upstream.status,
  });
}

async function handleCompactRequest(input: {
  context: Parameters<ProviderAdapter["handleRequest"]>[0];
  fetchImpl: typeof fetch;
  options: CodexChatGPTProviderOptions;
}): Promise<Response> {
  const body = rewriteCompactBody(input.context.body);
  const bodyText = JSON.stringify(body);
  const budgetMs = input.options.compactRequestBudgetMs ?? input.options.compactTimeoutMs ?? 75_000;
  const deadline = Date.now() + Math.max(1, budgetMs);
  return executeWithAccountFailover({
    provider: "codex",
    kind: "oauth",
    accounts: input.options.accounts,
    sessionKey: input.context.sessionKey,
    maxAttempts: input.options.maxAccountAttempts,
    sameAccountMaxRetries: 1,
    missingCredentialResponse: () =>
      jsonResponse(
        {
          error: {
            type: "missing_oauth_account",
            message:
              "Codex compact requests require a stored codex/oauth account. Add one with kyoli login codex.",
          },
        },
        { status: 401 },
      ),
    selectCredential: (excludeAccountIds) =>
      readOAuthCredential({
        accounts: input.options.accounts,
        sessionKey: input.context.sessionKey,
        excludeAccountIds,
        tokenRefresh: input.options.tokenRefresh ?? refreshCodexToken,
      }),
    execute: async (credential) => {
      const postCompact = (selected: SelectedCredential) =>
        postCompactRequest({
          context: input.context,
          fetchImpl: input.fetchImpl,
          credential: selected as CodexCredential,
          bodyText,
          deadline,
        });

      let currentCredential = credential;
      let response = await postCompact(currentCredential);
      if (response.status === 401 && currentCredential.accountId) {
        const refreshed = await refreshOAuthCredentialForAccount({
          accounts: input.options.accounts,
          accountId: currentCredential.accountId,
          tokenRefresh: input.options.tokenRefresh ?? refreshCodexToken,
        });
        if (refreshed) {
          currentCredential = refreshed;
          response = await postCompact(currentCredential);
        }
      }
      if (!isRetryableCompactStatus(response.status)) return response;
      await sleep(input.options.compactRetryDelayMs ?? 250);
      return postCompact(currentCredential);
    },
    failureMessage: (status) => `Codex compact upstream returned ${status}`,
    readRateLimitResetAt: readCodexRateLimitResetAt,
    onTrace: input.options.onTrace,
    traceRoute: input.context.route,
    traceModel: typeof body === "object" && body && "model" in body
      ? readString((body as Record<string, unknown>).model)
      : input.context.model,
  });
}

async function postCompactRequest(input: {
  context: Parameters<ProviderAdapter["handleRequest"]>[0];
  fetchImpl: typeof fetch;
  credential: CodexCredential;
  bodyText: string;
  deadline: number;
}): Promise<Response> {
  const remainingMs = input.deadline - Date.now();
  if (remainingMs <= 0) {
    return jsonResponse(
      {
        error: {
          type: "upstream_timeout",
          message: "Codex compact request budget was exhausted before upstream completed.",
          retryable: true,
        },
      },
      { status: 504 },
    );
  }

  return input.fetchImpl(CODEX_COMPACT_ENDPOINT, {
    method: input.context.request.method,
    headers: buildUpstreamHeaders(
      input.context.request.headers,
      input.credential.value,
      input.credential.chatgptAccountId,
      { bridge: input.context.route.startsWith("/v1/") },
    ),
    body: input.bodyText,
    signal: AbortSignal.timeout(Math.max(1, remainingMs)),
    duplex: "half",
  } as RequestInit);
}

async function handleCodexFileRequest(input: {
  context: Parameters<ProviderAdapter["handleRequest"]>[0];
  fetchImpl: typeof fetch;
  options: CodexChatGPTProviderOptions;
  fileAccountById: Map<string, string>;
}): Promise<Response> {
  const { context, fetchImpl, options, fileAccountById } = input;
  const isCreate = context.route === "/backend-api/files";
  const fileId = isCreate ? undefined : readFileIdFromPath(new URL(context.request.url).pathname);
  if (!isCreate && !fileId) {
    return jsonResponse(
      { error: { type: "invalid_request", message: "File finalize route requires a file id." } },
      { status: 400 },
    );
  }

  const body = isCreate
    ? normalizeFileCreateBody(context.body)
    : ({ ok: true, value: {} } as const);
  if (!body.ok) return body.response;

  const sessionKey = isCreate ? context.sessionKey : `file:${fileId}`;
  const preferredAccountId = fileId ? fileAccountById.get(fileId) : undefined;
  const upstreamUrl = isCreate
    ? `${CODEX_BACKEND_API_BASE}/files`
    : `${CODEX_BACKEND_API_BASE}/files/${encodeURIComponent(fileId ?? "")}/uploaded`;

  return executeWithAccountFailover({
    provider: "codex",
    kind: "oauth",
    accounts: options.accounts,
    sessionKey,
    maxAttempts: options.maxAccountAttempts,
    missingCredentialResponse: () =>
      jsonResponse(
        {
          error: {
            type: "missing_oauth_account",
            message:
              "Codex file requests require a stored codex/oauth account. Add one with kyoli login codex.",
          },
        },
        { status: 401 },
      ),
    selectCredential: (excludeAccountIds) =>
      readOAuthCredential({
        accounts: options.accounts,
        sessionKey,
        excludeAccountIds,
        preferredAccountId,
        tokenRefresh: options.tokenRefresh ?? refreshCodexToken,
      }),
    execute: async (credential) => {
      const response = await fetchCodexFile({
        fetchImpl,
        request: context.request,
        accessToken: credential.value,
        chatgptAccountId: (credential as CodexCredential).chatgptAccountId,
        upstreamUrl,
        body: body.value,
        shouldPoll: !isCreate,
        pollDelayMs: options.fileFinalizePollDelayMs ?? 250,
        pollBudgetMs: options.fileFinalizeBudgetMs ?? 30_000,
      });

      if (isCreate && response.ok && credential.accountId) {
        const createdFileId = await readFileIdFromResponse(response.clone());
        if (createdFileId) fileAccountById.set(createdFileId, credential.accountId);
      }

      return response;
    },
    failureMessage: (status) => `Codex file upstream returned ${status}`,
    readRateLimitResetAt: readCodexRateLimitResetAt,
    onTrace: options.onTrace,
    traceRoute: context.route,
    traceModel: isCreate ? "files-create" : "files-finalize",
  });
}

async function handleTranscriptionRequest(input: {
  context: Parameters<ProviderAdapter["handleRequest"]>[0];
  fetchImpl: typeof fetch;
  options: CodexChatGPTProviderOptions;
}): Promise<Response> {
  const form = await input.context.request.clone().formData().catch(() => undefined);
  const file = form?.get("file");
  const prompt = form?.get("prompt");
  const model = form?.get("model");
  if (input.context.route === "/v1/audio/transcriptions" && model !== "gpt-4o-transcribe") {
    return validationError("model must be gpt-4o-transcribe.").response;
  }
  if (!(file instanceof Blob)) {
    return validationError("Transcription requests require a file multipart part.").response;
  }

  return executeWithAccountFailover({
    provider: "codex",
    kind: "oauth",
    accounts: input.options.accounts,
    sessionKey: input.context.sessionKey,
    maxAttempts: input.options.maxAccountAttempts,
    sameAccountMaxRetries: 1,
    missingCredentialResponse: () =>
      jsonResponse(
        {
          error: {
            type: "missing_oauth_account",
            message:
              "Codex transcription requests require a stored codex/oauth account. Add one with kyoli login codex.",
          },
        },
        { status: 401 },
      ),
    selectCredential: (excludeAccountIds) =>
      readOAuthCredential({
        accounts: input.options.accounts,
        sessionKey: input.context.sessionKey,
        excludeAccountIds,
        tokenRefresh: input.options.tokenRefresh ?? refreshCodexToken,
      }),
    execute: (credential) => {
      const upstreamForm = new FormData();
      upstreamForm.set(
        "file",
        file,
        file instanceof File && file.name ? file.name : "audio.wav",
      );
      if (typeof prompt === "string") upstreamForm.set("prompt", prompt);
      return input.fetchImpl(CODEX_TRANSCRIBE_ENDPOINT, {
        method: "POST",
        headers: buildUpstreamMultipartHeaders(
          input.context.request.headers,
          credential.value,
          (credential as CodexCredential).chatgptAccountId,
        ),
        body: upstreamForm,
        signal: AbortSignal.timeout(input.options.compactTimeoutMs ?? 75_000),
        duplex: "half",
      } as RequestInit);
    },
    failureMessage: (status) => `Codex transcription upstream returned ${status}`,
    readRateLimitResetAt: readCodexRateLimitResetAt,
    onTrace: input.options.onTrace,
    traceRoute: input.context.route,
    traceModel: "gpt-4o-transcribe",
  });
}

async function handleImagesRequest(input: {
  context: Parameters<ProviderAdapter["handleRequest"]>[0];
  fetchImpl: typeof fetch;
  options: CodexChatGPTProviderOptions;
}): Promise<Response> {
  const request = await buildImageResponsesRequest(input.context);
  if (!request.ok) return request.response;
  const responsesBody = applyOpenAIResponsesCodexDefaults(rewriteBodyModel(request.value)) as Record<string, unknown>;
  const upstream = await executeWithAccountFailover({
    provider: "codex",
    kind: "oauth",
    accounts: input.options.accounts,
    sessionKey: input.context.sessionKey,
    maxAttempts: input.options.maxAccountAttempts,
    sameAccountMaxRetries: 1,
    missingCredentialResponse: () =>
      jsonResponse(
        {
          error: {
            type: "missing_oauth_account",
            message:
              "Codex image requests require a stored codex/oauth account. Add one with kyoli login codex.",
          },
        },
        { status: 401 },
      ),
    selectCredential: (excludeAccountIds) =>
      readOAuthCredential({
        accounts: input.options.accounts,
        sessionKey: input.context.sessionKey,
        excludeAccountIds,
        tokenRefresh: input.options.tokenRefresh ?? refreshCodexToken,
      }),
    execute: async (credential) =>
      normalizeCodexStartupFailure(await input.fetchImpl(CODEX_API_ENDPOINT, {
        method: "POST",
        headers: buildUpstreamHeaders(
          input.context.request.headers,
          credential.value,
          (credential as CodexCredential).chatgptAccountId,
          { bridge: true },
        ),
        body: JSON.stringify(responsesBody),
        duplex: "half",
      } as RequestInit)),
    failureMessage: (status) => `Codex image upstream returned ${status}`,
    readRateLimitResetAt: readCodexRateLimitResetAt,
    onTrace: input.options.onTrace,
    traceRoute: input.context.route,
    traceModel: readString(request.value.model),
  });
  if (!upstream.ok) return upstream;
  const payload = await convertResponsesStreamToResponsePayload(upstream, responsesBody);
  return jsonResponse(convertResponsesPayloadToImageResponse(payload), { status: upstream.status });
}

function isRetryableCompactStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

async function buildImageResponsesRequest(
  context: Parameters<ProviderAdapter["handleRequest"]>[0],
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  if (context.route === "/v1/images/generations") {
    const body = readRecord(context.body);
    if (!body) return validationError("Image generation requests require a JSON object body.");
    const prompt = readString(body.prompt);
    if (!prompt) return validationError("prompt is required.");
    const imageModel = readString(body.model) ?? "gpt-image-1.5";
    const stream = body.stream === true;
    return {
      ok: true,
      value: {
        model: DEFAULT_IMAGE_HOST_MODEL,
        instructions:
          "You are an image generator. You MUST call the image_generation tool exactly once and return only that tool call.",
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        tools: [buildImageGenerationTool(body, imageModel, stream)],
        tool_choice: { type: "image_generation" },
        stream: true,
        store: false,
      },
    };
  }

  const form = await context.request.clone().formData().catch(() => undefined);
  const prompt = form?.get("prompt");
  const promptText = typeof prompt === "string" && prompt.length > 0
    ? prompt
    : context.route === "/v1/images/variations"
    ? "Create a high-quality variation of the attached image."
    : undefined;
  if (!promptText) return validationError("prompt is required.");
  const images = [...(form?.getAll("image") ?? []), ...(form?.getAll("image[]") ?? [])]
    .filter((value): value is File => value instanceof File);
  if (images.length === 0) return validationError("At least one image multipart part is required.");
  const imageModel = typeof form?.get("model") === "string" ? String(form.get("model")) : "gpt-image-1.5";
  const imageParts = await Promise.all(images.map(async (image) => ({
    type: "input_image",
    image_url: await blobToDataUrl(image),
  })));
  const mask = form?.get("mask");
  if (mask instanceof File) {
    imageParts.push({ type: "input_image", image_url: await blobToDataUrl(mask) });
  }
  return {
    ok: true,
    value: {
    model: DEFAULT_IMAGE_HOST_MODEL,
      instructions:
        "You are an image editor. You MUST call the image_generation tool exactly once and return only that tool call.",
      input: [{ role: "user", content: [{ type: "input_text", text: promptText }, ...imageParts] }],
      tools: [buildImageGenerationTool(Object.fromEntries(form?.entries() ?? []), imageModel, form?.get("stream") === "true", true)],
      tool_choice: { type: "image_generation" },
      stream: true,
      store: false,
    },
  };
}

function buildImageGenerationTool(
  body: Record<string, unknown>,
  model: string,
  stream: boolean,
  isEdit = false,
): Record<string, unknown> {
  return {
    type: "image_generation",
    model,
    size: readString(body.size) ?? "auto",
    quality: readString(body.quality) ?? "auto",
    background: readString(body.background) ?? "auto",
    output_format: readString(body.output_format) ?? "png",
    output_compression: readNumber(body.output_compression) ?? 100,
    moderation: readString(body.moderation) ?? "auto",
    ...(isEdit ? { action: "edit" } : {}),
    ...(stream && readNumber(body.partial_images) ? { partial_images: readNumber(body.partial_images) } : {}),
  };
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = Buffer.from(await blob.arrayBuffer());
  return `data:${blob.type || "image/png"};base64,${bytes.toString("base64")}`;
}

function convertResponsesPayloadToImageResponse(payload: Record<string, unknown>): Record<string, unknown> {
  const images = extractImageBase64(payload);
  return {
    created: readNumber(payload.created_at) ?? Math.floor(Date.now() / 1000),
    data: images.length > 0 ? images.map((b64_json) => ({ b64_json })) : [],
    usage: payload.usage,
  };
}

function extractImageBase64(value: unknown): string[] {
  const found: string[] = [];
  collectImageBase64(value, found);
  return [...new Set(found)];
}

function collectImageBase64(value: unknown, found: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectImageBase64(item, found);
    return;
  }
  const record = readRecord(value);
  if (!record) return;
  for (const key of ["b64_json", "result", "image_base64"]) {
    const raw = readString(record[key]);
    if (raw) found.push(raw.startsWith("data:") ? raw.split(",", 2)[1] ?? raw : raw);
  }
  for (const child of Object.values(record)) collectImageBase64(child, found);
}

async function readOAuthCredential(input: {
  accounts: AccountPool | undefined;
  sessionKey: string;
  excludeAccountIds: string[];
  preferredAccountId?: string;
  tokenRefresh: CodexTokenRefresh;
}): Promise<CodexCredential | undefined> {
  const account = await input.accounts?.select({
    provider: "codex",
    kind: "oauth",
    sessionKey: input.sessionKey,
    excludeAccountIds: input.excludeAccountIds,
    preferredAccountId: input.preferredAccountId,
  });
  if (!account) return undefined;

  const refreshToken = readString(account.credentials.refreshToken);
  let accessToken = readString(account.credentials.accessToken);
  let expiresAt = readNumber(account.credentials.expiresAt);
  let chatgptAccountId = readString(account.credentials.accountId);

  if (!refreshToken && !accessToken) return undefined;

  if (!accessToken || !expiresAt || expiresAt <= Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    if (!refreshToken) return undefined;

    const refreshed = await input.tokenRefresh(refreshToken).catch(async (error) => {
      await input.accounts?.recordFailure(account.id, {
        status: 401,
        message: error instanceof Error ? error.message : String(error),
        reauthRequiredReason: "Codex OAuth token refresh failed",
      });
      throw new CredentialUnavailableError("Codex OAuth token refresh failed", account.id);
    });
    accessToken = refreshed.accessToken;
    expiresAt = refreshed.expiresAt;
    chatgptAccountId = refreshed.accountId ?? chatgptAccountId;

    await input.accounts?.update(account.id, {
      credentials: {
        ...account.credentials,
        accessToken,
        expiresAt,
        refreshToken: refreshed.refreshToken ?? refreshToken,
        accountId: chatgptAccountId,
      },
    });
  }

  return {
    value: accessToken,
    accountId: account.id,
    chatgptAccountId,
  };
}

async function refreshOAuthCredentialForAccount(input: {
  accounts: AccountPool | undefined;
  accountId: string;
  tokenRefresh: CodexTokenRefresh;
}): Promise<CodexCredential | undefined> {
  const account = (await input.accounts?.listByProvider("codex"))
    ?.find((candidate) => candidate.id === input.accountId && candidate.kind === "oauth");
  if (!account) return undefined;

  const refreshToken = readString(account.credentials.refreshToken);
  if (!refreshToken) return undefined;

  const refreshed = await input.tokenRefresh(refreshToken).catch(async (error) => {
    await input.accounts?.recordFailure(account.id, {
      status: 401,
      message: error instanceof Error ? error.message : String(error),
      reauthRequiredReason: "Codex OAuth token refresh failed",
    });
    return undefined;
  });
  if (!refreshed) return undefined;

  const chatgptAccountId = refreshed.accountId ?? readString(account.credentials.accountId);
  await input.accounts?.update(account.id, {
    credentials: {
      ...account.credentials,
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      refreshToken: refreshed.refreshToken ?? refreshToken,
      accountId: chatgptAccountId,
    },
  });

  return {
    value: refreshed.accessToken,
    accountId: account.id,
    chatgptAccountId,
  };
}

async function refreshCodexToken(refreshToken: string): Promise<CodexTokenRefreshResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REFRESH_TIMEOUT_MS);

  try {
    const startedAt = Date.now();
    const response = await fetch(OPENAI_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OPENAI_CLIENT_ID,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Codex token refresh failed with ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = readString(payload.access_token);
    const expiresIn = readNumber(payload.expires_in);
    if (!accessToken || !expiresIn) {
      throw new Error("Codex token refresh response is missing access_token or expires_in.");
    }

    return {
      accessToken,
      expiresAt: startedAt + expiresIn * 1000,
      refreshToken: readString(payload.refresh_token),
      accountId: extractAccountId(payload),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCodexFile(input: {
  fetchImpl: typeof fetch;
  request: Request;
  accessToken: string;
  chatgptAccountId: string | undefined;
  upstreamUrl: string;
  body: Record<string, unknown>;
  shouldPoll: boolean;
  pollDelayMs: number;
  pollBudgetMs: number;
}): Promise<Response> {
  const startedAt = Date.now();
  let response = await postCodexFile(input);

  while (input.shouldPoll && response.ok && await isRetryFileResponse(response.clone())) {
    if (Date.now() - startedAt >= input.pollBudgetMs) return response;
    await sleep(input.pollDelayMs);
    response = await postCodexFile(input);
  }

  return response;
}

function postCodexFile(input: {
  fetchImpl: typeof fetch;
  request: Request;
  accessToken: string;
  chatgptAccountId: string | undefined;
  upstreamUrl: string;
  body: Record<string, unknown>;
}): Promise<Response> {
  return input.fetchImpl(input.upstreamUrl, {
    method: "POST",
    headers: buildUpstreamHeaders(input.request.headers, input.accessToken, input.chatgptAccountId),
    body: JSON.stringify(input.body),
    duplex: "half",
  } as RequestInit);
}

function normalizeFileCreateBody(
  body: unknown,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response } {
  const record = readRecord(body);
  if (!record) {
    return validationError("Codex file create requires a JSON object body.");
  }

  const fileName = readString(record.file_name);
  const fileSize = readNumber(record.file_size);
  if (!fileName) return validationError("file_name is required.");
  if (!fileSize || fileSize <= 0 || fileSize > MAX_CODEX_FILE_SIZE_BYTES) {
    return validationError("file_size must be between 1 byte and 512 MiB.");
  }

  return {
    ok: true,
    value: {
      ...record,
      file_name: fileName,
      file_size: fileSize,
      use_case: readString(record.use_case) ?? "codex",
    },
  };
}

function validationError(message: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: jsonResponse({ error: { type: "invalid_request", message } }, { status: 400 }),
  };
}

function convertChatCompletionBodyToResponses(
  body: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; response: Response } {
  try {
    const input = convertChatMessagesToResponsesInput(body.messages);
    const converted: Record<string, unknown> = {
      ...body,
      input,
    };
    converted.instructions =
      readString(converted.instructions) ??
      convertChatMessagesToInstructions(body.messages) ??
      DEFAULT_CHAT_COMPLETIONS_INSTRUCTIONS;
    converted.store = body.store === undefined ? false : body.store;
    delete converted.messages;

    if (Array.isArray(body.tools)) {
      converted.tools = body.tools.map(convertChatToolToResponsesTool);
    }
    if (body.tool_choice !== undefined) {
      converted.tool_choice = normalizeToolChoice(body.tool_choice);
    }
    const textFormat = convertResponseFormatToText(body.response_format);
    if (textFormat) {
      converted.text = {
        ...(readRecord(body.text) ?? {}),
        format: textFormat,
      };
      delete converted.response_format;
    }

    return { ok: true, value: converted };
  } catch (error) {
    return validationError(error instanceof Error ? error.message : String(error));
  }
}

function convertChatMessagesToResponsesInput(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];

  return messages.flatMap((message) => {
    const record = readRecord(message);
    if (!record) throw new Error("Chat messages must contain objects.");
    const role = readString(record.role) ?? "user";
    if (role === "system" || role === "developer") return [];
    if (role === "tool") return [convertChatToolMessageToFunctionOutput(record)];
    if (role === "assistant") return convertAssistantMessageToResponsesItems(record);
    if (role !== "user") throw new Error(`Unsupported chat message role: ${role}`);

    const content = convertChatContentToResponsesContent(record.content, role);
    return content.length > 0 ? [{ role, content }] : [];
  });
}

function convertAssistantMessageToResponsesItems(message: Record<string, unknown>): unknown[] {
  const items: unknown[] = [];
  const content = convertChatContentToResponsesContent(message.content, "assistant");
  const refusal = readString(message.refusal);
  if (refusal) {
    content.push({ type: "output_text", text: refusal });
  }
  if (content.length > 0) {
    items.push({ role: "assistant", content });
  }

  if (!Array.isArray(message.tool_calls)) return items;
  for (const toolCall of message.tool_calls) {
    const record = readRecord(toolCall);
    const fn = readRecord(record?.function);
    const callId = readString(record?.id);
    const name = readString(fn?.name);
    const args = fn?.arguments;
    if (!callId) throw new Error("assistant tool_calls entries must include a non-empty id.");
    if (!name) throw new Error("assistant tool_calls entries must include function.name.");
    if (typeof args !== "string") throw new Error("assistant tool_calls function.arguments must be a string.");
    items.push({
      type: "function_call",
      call_id: callId,
      name,
      arguments: args,
    });
  }
  return items;
}

function convertChatToolMessageToFunctionOutput(message: Record<string, unknown>): Record<string, unknown> {
  const callId = readString(message.tool_call_id) ?? readString(message.toolCallId) ?? readString(message.call_id);
  if (!callId) throw new Error("tool messages must include tool_call_id.");
  return {
    type: "function_call_output",
    call_id: callId,
    output: convertToolContentToOutput(message.content),
  };
}

function convertToolContentToOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) throw new Error("tool message content is required.");
  if (!Array.isArray(content)) throw new Error("tool message content must be a string or array.");
  const output = content.flatMap((part) => {
    if (typeof part === "string") return [part];
    const record = readRecord(part);
    const text = readString(record?.text);
    return text !== undefined ? [text] : [];
  }).join("");
  if (!output && content.length > 0) {
    throw new Error("tool message content array contains no valid text parts.");
  }
  return output;
}

function convertChatContentToResponsesContent(
  content: unknown,
  role = "user",
): Array<Record<string, unknown>> {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (content === null || content === undefined) return [];
  if (typeof content === "string") {
    return [{ type: textType, text: content }];
  }

  const parts = Array.isArray(content) ? content : [content];
  return parts.flatMap((part) => {
    if (typeof part === "string") return [{ type: textType, text: part }];
    const record = readRecord(part);
    if (!record) return [];
    const partType = readString(record.type) ?? (typeof record.text === "string" ? "text" : undefined);
    if (partType === "text" || partType === "input_text" || partType === "output_text") {
      return typeof record.text === "string" ? [{ type: textType, text: record.text }] : [];
    }
    if (role === "assistant") return [record];
    if (partType === "image_url") {
      return convertChatImageUrlPart(record);
    }
    if (partType === "input_image") {
      return [record];
    }
    if (partType === "input_audio") {
      const fileUrl = convertAudioInputToDataUrl(record.input_audio);
      return fileUrl ? [{ type: "input_file", file_url: fileUrl }] : [record];
    }
    if (partType === "file") {
      return [convertChatFilePart(record.file)];
    }
    return [record];
  });
}

function convertChatImageUrlPart(part: Record<string, unknown>): Array<Record<string, unknown>> {
  const image = readRecord(part.image_url);
  const imageUrl = typeof part.image_url === "string" ? part.image_url : readString(image?.url);
  if (!imageUrl || isOversizedDataUrl(imageUrl, MAX_CHAT_IMAGE_DATA_URL_BYTES)) return [];
  return [{
    type: "input_image",
    image_url: imageUrl,
    ...(readString(image?.detail) ? { detail: readString(image?.detail) } : {}),
  }];
}

function convertAudioInputToDataUrl(inputAudio: unknown): string | undefined {
  const record = readRecord(inputAudio);
  const data = readString(record?.data);
  const format = readString(record?.format);
  if (!data || !format) return undefined;
  const mime = format === "mp3" ? "audio/mpeg" : format === "wav" ? "audio/wav" : `audio/${format}`;
  return `data:${mime};base64,${data}`;
}

function convertChatFilePart(file: unknown): Record<string, unknown> {
  const record = readRecord(file);
  if (!record) return { type: "input_file" };
  const fileId = readString(record.file_id);
  if (fileId) throw new Error("Chat file content with file_id is not supported; use Responses input_file instead.");
  const fileUrl = readString(record.file_url);
  if (fileUrl) return { type: "input_file", file_url: fileUrl };
  const fileData = readString(record.file_data) ?? readString(record.data);
  if (fileData) {
    const mime = readString(record.mime_type) ?? readString(record.content_type) ?? "application/octet-stream";
    return { type: "input_file", file_url: `data:${mime};base64,${fileData}` };
  }
  return { type: "input_file" };
}

function isOversizedDataUrl(url: string, limitBytes: number): boolean {
  if (!url.startsWith("data:")) return false;
  const [header, data] = url.split(",", 2);
  if (!header || !data || !header.includes(";base64")) return false;
  const padding = (data.match(/=/g) ?? []).length;
  return Math.floor((data.length * 3) / 4) - padding > limitBytes;
}

function convertChatMessagesToInstructions(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;

  const instructions = messages
    .flatMap((message) => {
      const record = readRecord(message);
      if (!record) return [];
      const role = readString(record?.role);
      if (role !== "system" && role !== "developer") return [];
      const text = convertChatContentToText(record.content).trim();
      return text ? [text] : [];
    })
    .join("\n\n")
    .trim();
  return instructions || undefined;
}

function convertChatContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((part) => {
      const record = readRecord(part);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n");
}

function convertChatToolToResponsesTool(tool: unknown): unknown {
  const record = readRecord(tool);
  const fn = readRecord(record?.function);
  if (record?.type !== "function" || !fn) return tool;

  return {
    type: "function",
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters,
  };
}

function normalizeToolChoice(toolChoice: unknown): unknown {
  const record = readRecord(toolChoice);
  const fn = readRecord(record?.function);
  if (record?.type === "function" && typeof fn?.name === "string") {
    return {
      type: "function",
      name: fn.name,
    };
  }
  const toolType = readString(record?.type);
  let normalized: Record<string, unknown> | undefined;
  if (toolType && normalizeCodexBuiltinToolType(toolType) !== toolType) {
    normalized = {
      ...record,
      type: normalizeCodexBuiltinToolType(toolType),
    };
  }
  if (Array.isArray(record?.tools)) {
    normalized = normalized ?? { ...record };
    normalized["tools"] = record.tools.map(normalizeCodexBuiltinTool);
  }
  if (normalized) {
    return normalized;
  }
  return toolChoice;
}

function convertResponseFormatToText(responseFormat: unknown): Record<string, unknown> | undefined {
  const record = readRecord(responseFormat);
  if (!record) return undefined;

  if (record.type === "json_object") {
    return { type: "json_object" };
  }

  const jsonSchema = readRecord(record.json_schema);
  if (record.type === "json_schema" && jsonSchema) {
    return {
      type: "json_schema",
      name: jsonSchema.name,
      schema: jsonSchema.schema,
      strict: jsonSchema.strict,
    };
  }

  return undefined;
}

function convertResponsesPayloadToChatCompletion(
  payload: Record<string, unknown>,
  requestBody: Record<string, unknown>,
): Record<string, unknown> {
  const text = extractResponsesText(payload);
  const toolCalls = extractChatToolCalls(payload);
  return {
    id: readString(payload.id) ?? `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: readString(requestBody.model) ?? readString(payload.model) ?? "unknown",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0
          ? "tool_calls"
          : readString(payload.status) === "incomplete"
          ? "length"
          : "stop",
      },
    ],
    usage: payload.usage,
  };
}

function convertResponsesStreamToChatCompletions(
  upstream: Response,
  requestBody: Record<string, unknown>,
): Response {
  if (!upstream.body) return upstream;

  const id = `chatcmpl_${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = readString(requestBody.model) ?? "unknown";
  const includeUsage = readRecord(requestBody.stream_options)?.include_usage === true;
  const state = createChatToolCallState();
  let buffer = "";
  let done = false;

  const stream = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(encodeSseData(createChatCompletionChunk({
        id,
        created,
        model,
        delta: { role: "assistant" },
        finishReason: null,
        includeUsage,
      })));
    },
    transform(chunk, controller) {
      buffer += STREAM_TEXT_DECODER.decode(chunk, { stream: true });
      buffer = drainSseFrames(buffer, (frame) => {
        for (const output of convertResponsesSseFrame(frame, { id, created, model }, { includeUsage, state })) {
          if (output === "[DONE]") {
            if (!done) {
              done = true;
              controller.enqueue(encodeSseData("[DONE]"));
            }
            continue;
          }
          controller.enqueue(encodeSseData(output));
        }
      });
    },
    flush(controller) {
      if (buffer.trim()) {
        for (const output of convertResponsesSseFrame(buffer, { id, created, model }, { includeUsage, state })) {
          if (output === "[DONE]") {
            if (!done) {
              done = true;
              controller.enqueue(encodeSseData("[DONE]"));
            }
            continue;
          }
          controller.enqueue(encodeSseData(output));
        }
      }
      if (!done) {
        controller.enqueue(encodeSseData(createChatCompletionChunk({
          id,
          created,
          model,
          delta: {},
          finishReason: "stop",
          includeUsage,
        })));
        controller.enqueue(encodeSseData("[DONE]"));
      }
    },
  }));

  return new Response(stream, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

async function convertResponsesStreamToResponsePayload(
  upstream: Response,
  requestBody: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const responseText = await upstream.text();
  const outputTextParts: string[] = [];
  const outputItems = new Map<number, Record<string, unknown>>();
  let finalResponse: Record<string, unknown> | undefined;
  let status = "completed";

  for (const frame of splitSseFrames(responseText)) {
    const data = readSseData(frame);
    if (!data || data === "[DONE]") continue;

    let payload: Record<string, unknown> | undefined;
    try {
      payload = readRecord(JSON.parse(data));
    } catch {
      continue;
    }
    if (!payload) continue;

    const payloadType = readString(payload.type);
    const delta = readString(payload.delta);
    if (delta && payloadType === "response.output_text.delta") outputTextParts.push(delta);

    const outputIndex = readNumber(payload.output_index);
    const item = readRecord(payload.item);
    if (outputIndex !== undefined && item) {
      outputItems.set(outputIndex, item);
    }

    const response = readRecord(payload.response);
    if (response) {
      finalResponse = response;
      status = readString(response.status) ?? status;
    }
    if (payloadType === "response.incomplete") status = "incomplete";
  }

  const outputText = outputTextParts.join("") || (finalResponse ? extractResponsesText(finalResponse) : "");
  const id = readString(finalResponse?.id) ?? `resp_${crypto.randomUUID()}`;
  const finalOutput = finalResponse?.output;
  const output = Array.isArray(finalOutput) && finalOutput.length > 0
    ? finalOutput
    : outputItems.size > 0
    ? [...outputItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item)
    : [{
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      status,
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: outputText,
          annotations: [],
        },
      ],
    }];

  return {
    id,
    object: "response",
    created_at: readNumber(finalResponse?.created_at) ?? Math.floor(Date.now() / 1000),
    model: readString(finalResponse?.model) ?? readString(requestBody.model) ?? "unknown",
    status,
    output,
    output_text: outputText,
    usage: finalResponse?.usage,
  };
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

function splitSseFrames(value: string): string[] {
  const frames: string[] = [];
  drainSseFrames(`${value}\n\n`, (frame) => frames.push(frame));
  return frames;
}

function convertResponsesSseFrame(
  frame: string,
  chunkBase: { id: string; created: number; model: string },
  options: { includeUsage?: boolean; state?: ChatToolCallState } = {},
): Array<Record<string, unknown> | "[DONE]"> {
  const event = readSseEvent(frame);
  const data = readSseData(frame);
  if (!data || data === "[DONE]") return ["[DONE]"];

  let payload: Record<string, unknown> | undefined;
  try {
    payload = readRecord(JSON.parse(data));
  } catch {
    return [];
  }
  if (!payload) return [];

  const outputs: Array<Record<string, unknown> | "[DONE]"> = [];
  const state = options.state;
  const failure = classifyCodexJsonEventFailure(payload, "mid_stream");
  if (failure) {
    outputs.push(createChatCompletionError(failure));
    outputs.push("[DONE]");
    return outputs;
  }

  const toolDelta = state ? extractToolCallDelta(payload, state.index) : undefined;
  if (state && toolDelta) {
    const toolState = mergeToolCallDelta(state.toolCalls, toolDelta);
    const streamDelta = buildPendingToolCallStreamDelta(toolState);
    if (streamDelta) {
      state.sawToolCall = true;
      outputs.push(createChatCompletionChunk({
        ...chunkBase,
        delta: {
          tool_calls: [formatChatToolCallDelta(streamDelta)],
        },
        finishReason: null,
        includeUsage: options.includeUsage,
      }));
    }
  }

  const payloadType = readString(payload.type);
  const delta = readString(payload.delta);
  if (delta && payloadType === "response.output_text.delta") {
    outputs.push(createChatCompletionChunk({
        ...chunkBase,
        delta: { content: delta },
        finishReason: null,
        includeUsage: options.includeUsage,
    }));
  }

  if (isResponsesCompletionEvent(event, payload)) {
    if (state) {
      for (const toolState of state.toolCalls) {
        const streamDelta = buildPendingToolCallStreamDelta(toolState);
        if (!streamDelta) continue;
        state.sawToolCall = true;
        outputs.push(createChatCompletionChunk({
          ...chunkBase,
          delta: {
            tool_calls: [formatChatToolCallDelta(streamDelta)],
          },
          finishReason: null,
          includeUsage: options.includeUsage,
        }));
      }
    }
    outputs.push(createChatCompletionChunk({
        ...chunkBase,
        delta: {},
        finishReason: state?.sawToolCall
          ? "tool_calls"
          : readString(payload.status) === "incomplete"
          ? "length"
          : "stop",
        includeUsage: options.includeUsage,
    }));
    if (options.includeUsage) {
      const response = readRecord(payload.response);
      outputs.push(createChatCompletionUsageChunk({
        ...chunkBase,
        usage: response?.usage ?? payload.usage ?? null,
      }));
    }
    outputs.push("[DONE]");
    return outputs;
  }

  return outputs;
}

type ChatToolCallState = {
  index: ToolCallIndexState;
  toolCalls: ToolCallItemState[];
  sawToolCall: boolean;
};

type ToolCallIndexState = {
  byKey: Map<string, number>;
  byOutputIndex: Map<number, number>;
  nextIndex: number;
};

type ToolCallDeltaState = {
  index: number;
  callId?: string;
  name?: string;
  arguments?: string;
  argumentsMode: "append" | "replace";
  toolType?: string;
};

type ToolCallItemState = {
  index: number;
  callId?: string;
  name?: string;
  arguments: string;
  toolType: string;
  emittedCallId?: string;
  emittedName?: string;
  emittedArguments: string;
  emittedToolType?: string;
};

function createChatToolCallState(): ChatToolCallState {
  return {
    index: {
      byKey: new Map(),
      byOutputIndex: new Map(),
      nextIndex: 0,
    },
    toolCalls: [],
    sawToolCall: false,
  };
}

function extractToolCallDelta(
  payload: Record<string, unknown>,
  indexState: ToolCallIndexState,
): ToolCallDeltaState | undefined {
  const type = readString(payload.type);
  const outputIndex = readNumber(payload.output_index);

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = readRecord(payload.item);
    if (readString(item?.type) !== "function_call") return undefined;
    const itemId = readString(item?.id);
    const routeId = readString(item?.call_id) ?? itemId;
    const callId = publicToolCallId(readString(item?.call_id) ?? itemId);
    const name = readString(item?.name);
    const args = typeof item?.arguments === "string" ? item.arguments : undefined;
    const index = indexForToolCall(indexState, outputIndex, routeId, name);
    if (itemId) registerToolCallAlias(indexState, itemId, index);
    if (readString(item?.call_id)) registerToolCallAlias(indexState, readString(item?.call_id)!, index);
    if (outputIndex !== undefined) registerToolCallOutputIndex(indexState, outputIndex, index);
    return {
      index,
      callId,
      name,
      arguments: args,
      argumentsMode: "replace",
      toolType: "function",
    };
  }

  if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
    const itemId = readString(payload.item_id);
    const routeId = readString(payload.call_id) ?? itemId;
    const callId = publicToolCallId(readString(payload.call_id));
    const name = readString(payload.name);
    const args = type.endsWith(".delta")
      ? (typeof payload.delta === "string" ? payload.delta : undefined)
      : (typeof payload.arguments === "string" ? payload.arguments : undefined);
    return {
      index: indexForToolCall(indexState, outputIndex, routeId, name),
      callId,
      name,
      arguments: args,
      argumentsMode: type.endsWith(".delta") ? "append" : "replace",
      toolType: "function",
    };
  }

  if (type === "response.output_tool_call.delta") {
    const callId = publicToolCallId(readString(payload.call_id));
    const name = readString(payload.name);
    return {
      index: indexForToolCall(indexState, outputIndex, readString(payload.call_id), name),
      callId,
      name,
      arguments: typeof payload.delta === "string" ? payload.delta : undefined,
      argumentsMode: "append",
      toolType: "function",
    };
  }

  return undefined;
}

function indexForToolCall(
  state: ToolCallIndexState,
  outputIndex: number | undefined,
  routeId: string | undefined,
  name: string | undefined,
): number {
  const key = toolCallKey(routeId, name);
  if (outputIndex !== undefined && state.byOutputIndex.has(outputIndex)) {
    const index = state.byOutputIndex.get(outputIndex)!;
    if (key && !state.byKey.has(key)) state.byKey.set(key, index);
    return index;
  }

  if (!key) {
    if (outputIndex === undefined) return 0;
    const index = state.nextIndex++;
    state.byOutputIndex.set(outputIndex, index);
    return index;
  }

  if (!state.byKey.has(key)) state.byKey.set(key, state.nextIndex++);
  const index = state.byKey.get(key)!;
  if (outputIndex !== undefined && !state.byOutputIndex.has(outputIndex)) {
    state.byOutputIndex.set(outputIndex, index);
  }
  return index;
}

function toolCallKey(routeId: string | undefined, name: string | undefined): string | undefined {
  if (routeId) return `id:${routeId}`;
  if (name) return `name:${name}`;
  return undefined;
}

function registerToolCallAlias(state: ToolCallIndexState, id: string, index: number): void {
  const key = `id:${id}`;
  if (!state.byKey.has(key)) state.byKey.set(key, index);
}

function registerToolCallOutputIndex(state: ToolCallIndexState, outputIndex: number, index: number): void {
  if (!state.byOutputIndex.has(outputIndex)) state.byOutputIndex.set(outputIndex, index);
}

function publicToolCallId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.startsWith("fc_") ? undefined : id;
}

function mergeToolCallDelta(toolCalls: ToolCallItemState[], delta: ToolCallDeltaState): ToolCallItemState {
  let state = toolCalls.find((item) => item.index === delta.index);
  if (!state) {
    state = {
      index: delta.index,
      arguments: "",
      toolType: "function",
      emittedArguments: "",
    };
    toolCalls.push(state);
    toolCalls.sort((left, right) => left.index - right.index);
  }

  if (delta.callId) state.callId = delta.callId;
  if (delta.name) state.name = delta.name;
  if (delta.arguments !== undefined) {
    state.arguments = delta.argumentsMode === "replace"
      ? delta.arguments
      : state.arguments + delta.arguments;
  }
  if (delta.toolType) state.toolType = delta.toolType;
  return state;
}

function buildPendingToolCallStreamDelta(state: ToolCallItemState): ToolCallDeltaState | undefined {
  const callId = pendingValue(state.emittedCallId, state.callId);
  const name = pendingValue(state.emittedName, state.name);
  const args = pendingArguments(state.emittedArguments, state.arguments);
  const toolType = state.toolType || "function";
  const typeChanged = state.emittedToolType !== toolType;
  if (callId === undefined && name === undefined && args === undefined && !typeChanged) {
    return undefined;
  }

  if (callId !== undefined) state.emittedCallId = state.callId;
  if (name !== undefined) state.emittedName = state.name;
  if (args !== undefined) state.emittedArguments = state.arguments;
  state.emittedToolType = toolType;

  return {
    index: state.index,
    callId,
    name,
    arguments: args,
    argumentsMode: "append",
    toolType,
  };
}

function pendingValue(previous: string | undefined, current: string | undefined): string | undefined {
  return current !== undefined && current !== previous ? current : undefined;
}

function pendingArguments(previous: string, current: string): string | undefined {
  return current.length > previous.length && current.startsWith(previous)
    ? current.slice(previous.length)
    : current !== previous
    ? current
    : undefined;
}

function formatChatToolCallDelta(delta: ToolCallDeltaState): Record<string, unknown> {
  const toolCall: Record<string, unknown> = {
    index: delta.index,
    type: delta.toolType ?? "function",
  };
  if (delta.callId) toolCall.id = delta.callId;
  const fn: Record<string, unknown> = {};
  if (delta.name) fn.name = delta.name;
  if (delta.arguments !== undefined) fn.arguments = delta.arguments;
  if (Object.keys(fn).length > 0) toolCall.function = fn;
  return toolCall;
}

function extractChatToolCalls(payload: Record<string, unknown>): Record<string, unknown>[] {
  const output = payload.output;
  if (!Array.isArray(output)) return [];
  return output.flatMap((item) => {
    const record = readRecord(item);
    if (readString(record?.type) !== "function_call") return [];
    const callId = publicToolCallId(readString(record?.call_id) ?? readString(record?.id));
    const name = readString(record?.name);
    const args = typeof record?.arguments === "string" ? record.arguments : "";
    if (!callId && !name) return [];
    return [{
      ...(callId ? { id: callId } : {}),
      type: "function",
      function: {
        ...(name ? { name } : {}),
        arguments: args,
      },
    }];
  });
}

function readSseEvent(frame: string): string | undefined {
  return frame
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("event:"))
    ?.slice("event:".length)
    .trim();
}

function readSseData(frame: string): string | undefined {
  const lines = frame
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function isResponsesCompletionEvent(event: string | undefined, payload: Record<string, unknown>): boolean {
  const type = readString(payload.type);
  return event === "response.completed" ||
    event === "response.incomplete" ||
    type === "response.completed" ||
    type === "response.incomplete" ||
    readRecord(payload.response)?.status === "completed" ||
    readRecord(payload.response)?.status === "incomplete";
}

function createChatCompletionChunk(input: {
  id: string;
  created: number;
  model: string;
  delta: Record<string, unknown>;
  finishReason: string | null;
  includeUsage?: boolean;
}): Record<string, unknown> {
  const chunk: Record<string, unknown> = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        delta: input.delta,
        finish_reason: input.finishReason,
      },
    ],
  };
  if (input.includeUsage) chunk.usage = null;
  return chunk;
}

function createChatCompletionUsageChunk(input: {
  id: string;
  created: number;
  model: string;
  usage: unknown;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    choices: [],
    usage: input.usage,
  };
}

function createChatCompletionError(failure: AccountFailureSignal): Record<string, unknown> {
  return {
    error: {
      type: failure.code ?? "upstream_response_failed",
      message: failure.message ?? "Codex upstream failed while streaming.",
      code: failure.code,
    },
  };
}

function encodeSseData(value: Record<string, unknown> | "[DONE]"): Uint8Array {
  const data = value === "[DONE]" ? "[DONE]" : JSON.stringify(value);
  return STREAM_TEXT_ENCODER.encode(`data: ${data}\n\n`);
}

function extractResponsesText(payload: Record<string, unknown>): string {
  const outputText = readString(payload.output_text);
  if (outputText) return outputText;

  const output = payload.output;
  if (!Array.isArray(output)) return "";
  const chunks: string[] = [];

  for (const item of output) {
    const itemRecord = readRecord(item);
    const content = itemRecord?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const partRecord = readRecord(part);
      const text = readString(partRecord?.text);
      if (text && (partRecord?.type === "output_text" || partRecord?.type === "text")) {
        chunks.push(text);
      }
    }
  }

  return chunks.join("");
}

async function readFileIdFromResponse(response: Response): Promise<string | undefined> {
  const payload = await readJsonRecord(response);
  return readString(payload?.file_id) ?? readString(payload?.id);
}

function resolveFileAccountForInput(
  input: unknown,
  fileAccountById: Map<string, string>,
): string | undefined {
  for (const fileId of extractInputFileIds(input)) {
    const accountId = fileAccountById.get(fileId);
    if (accountId) return accountId;
  }
  return undefined;
}

function extractInputFileIds(value: unknown): string[] {
  const found = new Set<string>();
  collectInputFileIds(value, found);
  return [...found];
}

function collectInputFileIds(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectInputFileIds(item, found);
    return;
  }

  const record = readRecord(value);
  if (!record) return;
  if (record.type === "input_file") {
    const fileId = readString(record.file_id);
    if (fileId) found.add(fileId);
  }
  collectInputFileIds(record.content, found);
}

async function isRetryFileResponse(response: Response): Promise<boolean> {
  const payload = await readJsonRecord(response);
  return payload?.status === "retry";
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    return readRecord(await response.json());
  } catch {
    return undefined;
  }
}

async function normalizeCodexStartupFailure(response: Response): Promise<AccountExecutionResult> {
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

  while (byteLength(chunks) < CODEX_STARTUP_PROBE_MAX_BYTES && !failure && !downstreamVisible) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    chunks.push(next.value);
    pendingText += decoder.decode(next.value, { stream: true });
    pendingText = drainSseFrames(pendingText, (frame) => {
      if (failure || downstreamVisible) return;
      const frameFailure = classifyCodexSseStartupFailure(frame);
      if (frameFailure) {
        failure = frameFailure;
        return;
      }
      if (isCodexStartupOutputFrame(frame)) downstreamVisible = true;
    });
  }

  if (done && !failure && !downstreamVisible) {
    pendingText += decoder.decode();
    if (pendingText.trim()) {
      const pendingFailure = classifyCodexSseStartupFailure(pendingText);
      if (pendingFailure) {
        failure = pendingFailure;
      } else if (isCodexStartupOutputFrame(pendingText)) {
        downstreamVisible = true;
      }
    }
  }

  if (failure) {
    await reader.cancel().catch(() => undefined);
    const headers: Record<string, string> = {};
    if (failure.retryAfterSeconds) headers["retry-after"] = String(failure.retryAfterSeconds);
    if (failure.resetAt) headers["x-kyoli-account-reset-at"] = failure.resetAt;
    return {
      failure,
      downstreamVisible: false,
      response: jsonResponse(
        {
          error: {
            type: failure.code ?? "upstream_response_failed",
            message: failure.message ?? "Codex upstream failed before producing output.",
            upstream_status: "response.failed",
          },
        },
        { status: failure.httpStatus ?? 502, headers },
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

function replayResponseBody(chunks: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
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

function readFileIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/backend-api\/files\/([^/]+)\/uploaded$/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function rewriteBodyModel(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;

  const record = { ...(body as Record<string, unknown>) };
  if (typeof record.model === "string") {
    record.model = stripProviderPrefix(record.model);
  }
  normalizeFastModelAlias(record);
  normalizeReasoningAliases(record);
  normalizeServiceTier(record);
  normalizePromptCacheAliases(record);
  normalizeTextAliases(record);
  normalizeToolChoiceAliases(record);
  normalizeMaxTokens(record);
  normalizeResponsesMessages(record);
  normalizeResponsesInput(record);
  normalizeResponsesInputItems(record);
  stripCodexUnsupportedFields(record);
  record.store = false;
  delete record.enable_thinking;
  delete record.thinking;
  delete record.reasoningEffort;
  delete record.reasoningSummary;
  delete record.reasoning_effort;
  delete record.promptCacheKey;
  delete record.promptCacheRetention;
  delete record.textVerbosity;
  delete record.verbosity;
  return record;
}

function rewriteCompactBody(body: unknown): unknown {
  const rewritten = rewriteBodyModel(body);
  const record = readRecord(rewritten);
  if (!record) return rewritten;
  delete record.store;
  delete record.tools;
  delete record.tool_choice;
  delete record.parallel_tool_calls;
  return record;
}

function applyOpenAIResponsesCodexDefaults(body: unknown): unknown {
  const record = readRecord(body);
  if (!record) return body;

  record.stream = true;
  record.store = false;
  record.parallel_tool_calls = true;
  record.include = mergeInclude(record.include, CODEX_REASONING_INCLUDE);
  return record;
}

function mergeInclude(include: unknown, value: string): string[] {
  const items = Array.isArray(include)
    ? include.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (!items.includes(value)) items.push(value);
  return items;
}

function normalizeResponsesInput(record: Record<string, unknown>): void {
  if (typeof record.input !== "string") return;
  record.input = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: record.input,
        },
      ],
    },
  ];
}

function normalizeResponsesInputItems(record: Record<string, unknown>): void {
  if (!Array.isArray(record.input)) return;
  const instructionParts: string[] = [];
  const normalizedInput: unknown[] = [];

  for (const item of record.input) {
    const itemRecord = readRecord(item);
    const role = readString(itemRecord?.role);
    if (!itemRecord || !role) {
      normalizedInput.push(item);
      continue;
    }

    if (role === "system" || role === "developer") {
      const text = convertContentToInstructionText(itemRecord.content);
      if (text) instructionParts.push(text);
      continue;
    }

    if (role === "tool") {
      normalizedInput.push(convertChatToolMessageToFunctionOutput(itemRecord));
      continue;
    }

    if (role === "user" || role === "assistant") {
      normalizedInput.push({
        ...itemRecord,
        content: convertChatContentToResponsesContent(itemRecord.content, role),
      });
      continue;
    }

    normalizedInput.push(item);
  }

  if (instructionParts.length > 0) {
    const existing = readString(record.instructions);
    record.instructions = [existing, ...instructionParts].filter(Boolean).join("\n");
  }
  record.input = normalizedInput;
}

function convertContentToInstructionText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  const parts = Array.isArray(content) ? content : [content];
  return parts.flatMap((part) => {
    if (typeof part === "string") return [part];
    const record = readRecord(part);
    const text = readString(record?.text);
    return text ? [text] : [];
  }).join("\n").trim();
}

function normalizeResponsesMessages(record: Record<string, unknown>): void {
  if (record.input !== undefined || !Array.isArray(record.messages)) return;
  const messageInstructions = convertChatMessagesToInstructions(record.messages);
  const existingInstructions = readString(record.instructions);
  if (messageInstructions) {
    record.instructions = existingInstructions
      ? `${existingInstructions}\n${messageInstructions}`
      : messageInstructions;
  }
  record.input = convertChatMessagesToResponsesInput(record.messages);
  delete record.messages;
}

function normalizeReasoningAliases(record: Record<string, unknown>): void {
  if (record.reasoning) return;

  const reasoningEffort = readString(record.reasoningEffort) ?? readString(record.reasoning_effort);
  const reasoningSummary = readString(record.reasoningSummary);
  if (reasoningEffort || reasoningSummary) {
    record.reasoning = {
      ...(reasoningEffort ? { effort: normalizeReasoningEffort(reasoningEffort) } : {}),
      ...(reasoningSummary ? { summary: reasoningSummary } : {}),
    };
    return;
  }

  const thinking = readRecord(record.thinking);
  if (thinking) {
    const budgetTokens = readNumber(thinking.budget_tokens);
    const effort = readString(thinking.effort) ??
      (budgetTokens ? reasoningEffortFromBudgetTokens(budgetTokens) : undefined);
    record.reasoning = effort ? { effort: normalizeReasoningEffort(effort) } : {};
    return;
  }

  if (record.enable_thinking === true) {
    record.reasoning = { effort: "medium" };
  }
}

function normalizeServiceTier(record: Record<string, unknown>): void {
  const serviceTier = readString(record.service_tier);
  if (serviceTier?.trim().toLowerCase() === "fast") {
    record.service_tier = "priority";
  }
}

function normalizeFastModelAlias(record: Record<string, unknown>): void {
  const model = readString(record.model);
  if (!model) return;
  const stripped = stripProviderPrefix(model);
  if (!stripped.endsWith("-fast")) return;

  record.model = stripped.slice(0, -"fast".length - 1);
  const requestedTier = readString(record.service_tier);
  if (!requestedTier || requestedTier.trim().toLowerCase() === "fast") {
    record.service_tier = "priority";
  }
}

function normalizePromptCacheAliases(record: Record<string, unknown>): void {
  if (record.prompt_cache_key === undefined && typeof record.promptCacheKey === "string") {
    record.prompt_cache_key = record.promptCacheKey;
  }
}

function normalizeTextAliases(record: Record<string, unknown>): void {
  const verbosity = readString(record.textVerbosity) ?? readString(record.verbosity);
  if (!verbosity) return;
  record.text = {
    ...(readRecord(record.text) ?? {}),
    verbosity,
  };
}

function normalizeToolChoiceAliases(record: Record<string, unknown>): void {
  if (record.tool_choice !== undefined) {
    record.tool_choice = normalizeToolChoice(record.tool_choice);
  }
  if (!Array.isArray(record.tools)) return;
  record.tools = record.tools.map(normalizeCodexBuiltinTool);
}

function normalizeCodexBuiltinTool(tool: unknown): unknown {
  const toolRecord = readRecord(tool);
  const toolType = readString(toolRecord?.type);
  if (!toolRecord || !toolType) return tool;
  const normalizedType = normalizeCodexBuiltinToolType(toolType);
  return normalizedType === toolType ? tool : { ...toolRecord, type: normalizedType };
}

function normalizeCodexBuiltinToolType(type: string): string {
  return type === "web_search_preview" || type.startsWith("web_search_preview_")
    ? "web_search"
    : type;
}

function normalizeMaxTokens(record: Record<string, unknown>): void {
  if (record.max_output_tokens !== undefined || record.max_tokens === undefined) return;
  record.max_output_tokens = record.max_tokens;
  delete record.max_tokens;
}

function stripCodexUnsupportedFields(record: Record<string, unknown>): void {
  normalizeCodexStreamOptions(record);
  delete record.max_output_tokens;
  delete record.max_completion_tokens;
  delete record.max_tokens;
  delete record.prompt_cache_retention;
  delete record.promptCacheRetention;
  delete record.safety_identifier;
  delete record.temperature;
  delete record.top_p;
  delete record.truncation;
  delete record.context_management;
  delete record.user;
}

function normalizeCodexStreamOptions(record: Record<string, unknown>): void {
  const streamOptions = readRecord(record.stream_options);
  if (!streamOptions) {
    delete record.stream_options;
    return;
  }
  const includeObfuscation = streamOptions.include_obfuscation;
  if (includeObfuscation === undefined) {
    delete record.stream_options;
    return;
  }
  record.stream_options = { include_obfuscation: includeObfuscation };
}

function normalizeReasoningEffort(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return "medium";
}

function reasoningEffortFromBudgetTokens(value: number): string {
  if (value <= 1024) return "low";
  if (value <= 4096) return "medium";
  return "high";
}

function buildUpstreamHeaders(
  headers: Headers,
  accessToken: string,
  accountId: string | undefined,
  options: { bridge?: boolean } = {},
): Headers {
  const nativeCodex = isNativeCodexRequest(headers);
  const upstream = options.bridge && !nativeCodex
    ? buildBridgeHeaders(headers)
    : new Headers(headers);
  deleteBlockedUpstreamHeaders(upstream);
  upstream.set("authorization", `Bearer ${accessToken}`);
  upstream.set("originator", nativeCodex
    ? headers.get("originator") ?? CODEX_ORIGINATOR
    : options.bridge
      ? CODEX_BRIDGE_ORIGINATOR
      : headers.get("originator") ?? CODEX_ORIGINATOR);
  upstream.set("user-agent", nativeCodex
    ? headers.get("user-agent") ?? CODEX_USER_AGENT
    : CODEX_USER_AGENT);
  upstream.set("content-type", "application/json");

  if (accountId) {
    upstream.set("ChatGPT-Account-ID", accountId);
  } else {
    upstream.delete("ChatGPT-Account-ID");
  }

  return upstream;
}

function buildUpstreamMultipartHeaders(
  headers: Headers,
  accessToken: string,
  accountId: string | undefined,
): Headers {
  const upstream = new Headers();
  upstream.set("authorization", `Bearer ${accessToken}`);
  upstream.set("originator", headers.get("originator") ?? CODEX_ORIGINATOR);
  upstream.set("user-agent", headers.get("user-agent") ?? CODEX_USER_AGENT);
  for (const [key, value] of headers.entries()) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("x-openai-") || normalized.startsWith("x-codex-")) {
      upstream.set(key, value);
    }
  }
  if (accountId) upstream.set("ChatGPT-Account-ID", accountId);
  return upstream;
}

function buildBridgeHeaders(headers: Headers): Headers {
  const upstream = new Headers();
  for (const [key, value] of headers.entries()) {
    const normalized = key.toLowerCase();
    if (BRIDGE_FORWARD_HEADERS.has(normalized)) upstream.set(key, value);
  }
  return upstream;
}

function deleteBlockedUpstreamHeaders(headers: Headers): void {
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");
  headers.delete("accept-encoding");
  headers.delete("forwarded");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  headers.delete("x-real-ip");
  headers.delete("true-client-ip");
}

function isNativeCodexRequest(headers: Headers): boolean {
  for (const header of NATIVE_CODEX_STREAM_HEADERS) {
    if (headers.has(header)) return true;
  }
  const originator = headers.get("originator")?.trim();
  if (!originator || !NATIVE_CODEX_ORIGINATORS.has(originator)) return false;
  const userAgent = headers.get("user-agent")?.toLowerCase() ?? "";
  return userAgent.includes("codex") || userAgent.includes("chatgpt");
}

function buildUpstreamWebSocketHeaders(
  headers: Headers,
  accessToken: string,
  accountId: string | undefined,
): Record<string, string> {
  const upstream = new Headers(headers);
  for (const header of WEBSOCKET_HOP_BY_HOP_HEADERS) upstream.delete(header);

  upstream.set("authorization", `Bearer ${accessToken}`);
  upstream.set("originator", headers.get("originator") ?? CODEX_ORIGINATOR);
  upstream.set("user-agent", headers.get("user-agent") ?? CODEX_USER_AGENT);
  upstream.set("openai-beta", appendOpenAIBetaHeader(upstream.get("openai-beta")));

  if (accountId) {
    upstream.set("ChatGPT-Account-ID", accountId);
  } else {
    upstream.delete("ChatGPT-Account-ID");
  }

  return Object.fromEntries(upstream.entries());
}

function appendOpenAIBetaHeader(value: string | null): string {
  if (!value) return RESPONSES_WEBSOCKET_BETA_HEADER;
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.includes(RESPONSES_WEBSOCKET_BETA_HEADER)
    ? parts.join(", ")
    : [...parts, RESPONSES_WEBSOCKET_BETA_HEADER].join(", ");
}

function createGlobalWebSocket(
  url: string,
  protocols: string[],
  init: { headers: Record<string, string> },
): CodexWebSocketLike {
  return new WsWebSocket(url, protocols, { headers: init.headers });
}

function waitForWebSocketOpen(websocket: CodexWebSocketLike): Promise<void> {
  if (websocket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    websocket.addEventListener("open", () => resolve(), { once: true });
    websocket.addEventListener("error", (event) => reject(readWebSocketError(event)), { once: true });
    websocket.addEventListener("close", (event) => reject(readWebSocketCloseError(event)), { once: true });
  });
}

function relayUpstreamMessages(
  state: WebSocketRelayState,
  upstream: CodexWebSocketLike,
  credential: CodexCredential,
): void {
  upstream.addEventListener("message", (event) => {
    if (state.active.upstream !== upstream) return;
    const data = readWebSocketEventData(event);
    if (typeof data === "string") {
      void handleUpstreamWebSocketText(state, upstream, credential, data);
      return;
    }
    if (data) {
      void sendWebSocketBinaryDownstream(state, data);
    }
  });
  upstream.addEventListener("close", (event) => {
    if (state.retiredUpstreams.has(upstream)) return;
    if (state.active.upstream !== upstream) return;
    const record = readRecord(event);
    const code = readNumber(record?.code) ?? 1000;
    const reason = readString(record?.reason) ?? "Upstream closed";
    void state.context.websocket.close(code, reason);
  });
  upstream.addEventListener("error", (event) => {
    if (state.retiredUpstreams.has(upstream)) return;
    if (state.active.upstream !== upstream) return;
    void sendWebSocketError(state.context, "upstream_error", readWebSocketError(event).message)
      .finally(() => state.context.websocket.close(1011, "Upstream error"));
  });
}

async function handleUpstreamWebSocketText(
  state: WebSocketRelayState,
  upstream: CodexWebSocketLike,
  credential: CodexCredential,
  data: string,
): Promise<void> {
  const payload = readJsonRecordFromString(data);
  const failure = classifyCodexJsonEventFailure(payload, state.downstreamVisible ? "mid_stream" : "startup");
  if (failure && credential.accountId) {
    await recordCodexAccountFailure(state.options.accounts, credential.accountId, failure);
  }

  if (await tryReplayWebSocketFailure(state, upstream, credential, failure)) return;

  if (shouldBufferWebSocketStartupEvent(state, payload, failure)) {
    rememberWebSocketStartupText(state, data);
    return;
  }

  await sendWebSocketTextDownstream(state, data);
}

async function tryReplayWebSocketFailure(
  state: WebSocketRelayState,
  upstream: CodexWebSocketLike,
  credential: CodexCredential,
  failure: AccountFailureSignal | undefined,
): Promise<boolean> {
  if (!canReplayWebSocketFailure(state, credential, failure)) return false;
  const accountId = credential.accountId;
  if (!accountId) return false;

  state.replayAttempts += 1;
  state.excludedAccountIds.push(accountId);
  state.retiredUpstreams.add(upstream);
  state.upstreamStartupText = [];
  upstream.close(1011, "Retrying with next account");

  const next = await openResponsesWebSocketWithFailover({
    context: state.context,
    options: state.options,
    websocketFactory: state.websocketFactory,
    excludeAccountIds: state.excludedAccountIds,
  });
  if (!next.upstream || !next.credential) return false;

  state.active = { upstream: next.upstream, credential: next.credential };
  relayUpstreamMessages(state, next.upstream, next.credential);
  replayWebSocketMessages(next.upstream, state.replayableMessages);
  return true;
}

function canReplayWebSocketFailure(
  state: WebSocketRelayState,
  credential: CodexCredential,
  failure: AccountFailureSignal | undefined,
): boolean {
  if (!failure || failure.retryScope !== "next_account") return false;
  if (state.downstreamVisible) return false;
  if (!credential.accountId) return false;
  if (state.replayableMessages.length === 0) return false;
  if (hasPreviousResponseAnchor(state.replayableMessages)) return false;

  const maxReplayAttempts = Math.max(1, state.options.maxAccountAttempts ?? 10) - 1;
  return state.replayAttempts < maxReplayAttempts;
}

function replayWebSocketMessages(
  upstream: CodexWebSocketLike,
  messages: GatewayWebSocketMessage[],
): void {
  for (const message of messages) {
    if (message.type === "text") upstream.send(message.data);
    else if (message.type === "binary") upstream.send(message.data);
  }
}

function shouldBufferWebSocketStartupEvent(
  state: WebSocketRelayState,
  payload: Record<string, unknown> | undefined,
  failure: AccountFailureSignal | undefined,
): boolean {
  return Boolean(!state.downstreamVisible && !failure && payload && !isCodexStartupOutputEvent(payload));
}

function rememberWebSocketStartupText(state: WebSocketRelayState, data: string): void {
  state.upstreamStartupText.push(data);
  if (state.upstreamStartupText.length > 32) state.upstreamStartupText.shift();
}

async function sendWebSocketTextDownstream(state: WebSocketRelayState, data: string): Promise<void> {
  state.downstreamVisible = true;
  await flushWebSocketStartupText(state);
  await state.context.websocket.sendText(data);
}

async function sendWebSocketBinaryDownstream(state: WebSocketRelayState, data: Uint8Array): Promise<void> {
  state.downstreamVisible = true;
  await flushWebSocketStartupText(state);
  await state.context.websocket.sendBinary(data);
}

async function flushWebSocketStartupText(state: WebSocketRelayState): Promise<void> {
  const pending = state.upstreamStartupText.splice(0);
  for (const data of pending) {
    await state.context.websocket.sendText(data);
  }
}

function rememberReplayableWebSocketMessage(
  state: WebSocketRelayState,
  message: GatewayWebSocketMessage,
): void {
  if (state.downstreamVisible || message.type === "close") return;
  state.replayableMessages.push(message);
  if (state.replayableMessages.length > 8) state.replayableMessages.shift();
}

function hasPreviousResponseAnchor(messages: GatewayWebSocketMessage[]): boolean {
  return messages.some((message) => {
    if (message.type !== "text") return false;
    const payload = readJsonRecordFromString(message.data);
    return typeof payload?.previous_response_id === "string" && payload.previous_response_id.length > 0;
  });
}

async function recordCodexAccountFailure(
  accounts: AccountPool | undefined,
  accountId: string,
  failure: AccountFailureSignal,
): Promise<void> {
  const status = failure.httpStatus ??
    (failure.class === "rate_limit" || failure.class === "quota" ? 429 : 502);
  const cooldownUntil = status === 429 ? cooldownUntilFromFailure(failure) : undefined;
  await accounts?.recordFailure(accountId, {
    status,
    message: failure.message,
    rateLimitResetAt: status === 429 ? failure.resetAt : undefined,
    rateLimitCooldownUntil: cooldownUntil,
    failureClass: failure.class,
    failureCode: failure.code,
    failurePhase: failure.phase,
  });
}

function cooldownUntilFromFailure(failure: AccountFailureSignal): string | undefined {
  if (failure.resetAt) return failure.resetAt;
  if (failure.retryAfterSeconds && failure.retryAfterSeconds > 0) {
    return new Date(Date.now() + failure.retryAfterSeconds * 1000).toISOString();
  }
  return undefined;
}

function readJsonRecordFromString(value: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

async function sendWebSocketError(
  context: GatewayWebSocketContext,
  code: string,
  message: string,
): Promise<void> {
  await context.websocket.sendText(JSON.stringify({
    type: "error",
    error: {
      type: code,
      code,
      message,
    },
  }));
}

function readWebSocketEventData(event: unknown): string | Uint8Array | undefined {
  const record = readRecord(event);
  const data = record?.data;
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}

function readWebSocketError(event: unknown): Error {
  const record = readRecord(event);
  const error = record?.error;
  if (error instanceof Error) return error;
  if (error !== undefined) return new Error(String(error));
  return new Error("Codex WebSocket upstream emitted an error.");
}

function readWebSocketCloseError(event: unknown): Error {
  const record = readRecord(event);
  const code = readNumber(record?.code);
  const reason = readString(record?.reason);
  return new Error(`Codex WebSocket upstream closed before open${code ? ` (${code})` : ""}${reason ? `: ${reason}` : "."}`);
}

function createUpstreamUrl(route: string): string {
  if (route === "/v1/responses/compact" || route === "/backend-api/codex/responses/compact") {
    return CODEX_COMPACT_ENDPOINT;
  }
  if (route === "/v1/responses" || route === "/v1/chat/completions") {
    return CODEX_API_ENDPOINT;
  }
  return CODEX_API_ENDPOINT;
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

function readCodexRateLimitResetAt(headers: Headers): string | undefined {
  return readResetAfterSeconds(headers, [
    "retry-after",
    "x-codex-primary-reset-after-seconds",
    "x-codex-secondary-reset-after-seconds",
  ]) ?? readResetAtEpochSeconds(headers, [
    "x-codex-primary-reset-at",
    "x-codex-secondary-reset-at",
  ]) ?? new Date(Date.now() + CODEX_UNKNOWN_RATE_LIMIT_BACKOFF_MS).toISOString();
}

function readResetAfterSeconds(headers: Headers, names: string[]): string | undefined {
  const seconds = names
    .map((name) => Number.parseInt(headers.get(name) ?? "", 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (seconds.length === 0) return undefined;
  return new Date(Date.now() + Math.min(...seconds) * 1000).toISOString();
}

function readResetAtEpochSeconds(headers: Headers, names: string[]): string | undefined {
  const timestamps = names
    .map((name) => Number.parseInt(headers.get(name) ?? "", 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (timestamps.length === 0) return undefined;
  return new Date(Math.min(...timestamps) * 1000).toISOString();
}

function extractAccountId(payload: Record<string, unknown>): string | undefined {
  const idToken = readString(payload.id_token);
  const accessToken = readString(payload.access_token);
  return findAccountId(parseJwtClaims(idToken)) ?? findAccountId(parseJwtClaims(accessToken));
}

interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
}

function parseJwtClaims(token: string | undefined): IdTokenClaims | undefined {
  if (!token) return undefined;
  try {
    const [, payload] = token.split(".");
    if (!payload) return undefined;
    return JSON.parse(base64UrlDecode(payload)) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

function findAccountId(claims: IdTokenClaims | undefined): string | undefined {
  if (!claims) return undefined;
  if (claims.chatgpt_account_id) return claims.chatgpt_account_id;
  if (claims["https://api.openai.com/auth"]?.chatgpt_account_id) {
    return claims["https://api.openai.com/auth"].chatgpt_account_id;
  }
  return claims.organizations?.[0]?.id;
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return atob(padded);
}
