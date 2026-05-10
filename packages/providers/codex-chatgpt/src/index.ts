import type {
  AccountExecutionTraceEvent,
  AccountPool,
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

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_COMPACT_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses/compact";
const CODEX_BACKEND_API_BASE = "https://chatgpt.com/backend-api";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_USER_AGENT = "codex_cli_rs/0.0.0";
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
const CODEX_UNKNOWN_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;
const MAX_CODEX_FILE_SIZE_BYTES = 512 * 1024 * 1024;
const MAX_CHAT_IMAGE_DATA_URL_BYTES = 8 * 1024 * 1024;
const STREAM_TEXT_DECODER = new TextDecoder();
const STREAM_TEXT_ENCODER = new TextEncoder();
const DEFAULT_CHAT_COMPLETIONS_INSTRUCTIONS = "You are a helpful assistant.";
const CODEX_REASONING_INCLUDE = "reasoning.encrypted_content";

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
  maxAccountAttempts?: number;
  tokenRefresh?: CodexTokenRefresh;
  onTrace?: (event: AccountExecutionTraceEvent) => void;
  fileFinalizePollDelayMs?: number;
  fileFinalizeBudgetMs?: number;
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
      "/backend-api/codex/responses",
      "/backend-api/codex/responses/compact",
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
        context.route !== "/backend-api/codex/responses" &&
        context.route !== "/backend-api/codex/responses/compact" &&
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
        execute: (credential) =>
          fetchImpl(createUpstreamUrl(context.route), {
            method: context.request.method,
            headers: buildUpstreamHeaders(
              context.request.headers,
              credential.value,
              (credential as CodexCredential).chatgptAccountId,
            ),
            body: body === undefined ? context.request.body : JSON.stringify(body),
            duplex: "half",
          } as RequestInit),
        failureMessage: (status) => `Codex upstream returned ${status}`,
        readRateLimitResetAt: readCodexRateLimitResetAt,
        onTrace: options.onTrace,
        traceRoute: context.route,
        traceModel: typeof body === "object" && body && "model" in body
          ? readString((body as Record<string, unknown>).model)
          : context.model,
      });
    },
  };
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
    execute: (credential) =>
      input.fetchImpl(createUpstreamUrl(input.context.route), {
        method: input.context.request.method,
        headers: buildUpstreamHeaders(
          input.context.request.headers,
          credential.value,
          (credential as CodexCredential).chatgptAccountId,
        ),
        body: JSON.stringify(upstreamBody),
        duplex: "half",
      } as RequestInit),
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
  const responsesBody = rewriteBodyModel(converted.value);
  const upstream = await executeWithAccountFailover({
    provider: "codex",
    kind: "oauth",
    accounts: input.options.accounts,
    sessionKey: input.context.sessionKey,
    maxAttempts: input.options.maxAccountAttempts,
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
    execute: (credential) =>
      input.fetchImpl(CODEX_API_ENDPOINT, {
        method: "POST",
        headers: buildUpstreamHeaders(
          input.context.request.headers,
          credential.value,
          (credential as CodexCredential).chatgptAccountId,
        ),
        body: JSON.stringify(responsesBody),
        duplex: "half",
      } as RequestInit),
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

  const payload = await readJsonRecord(upstream.clone());
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
  return executeWithAccountFailover({
    provider: "codex",
    kind: "oauth",
    accounts: input.options.accounts,
    sessionKey: input.context.sessionKey,
    maxAttempts: input.options.maxAccountAttempts,
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
    execute: (credential) =>
      input.fetchImpl(CODEX_COMPACT_ENDPOINT, {
        method: input.context.request.method,
        headers: buildUpstreamHeaders(
          input.context.request.headers,
          credential.value,
          (credential as CodexCredential).chatgptAccountId,
        ),
        body: JSON.stringify(body),
        duplex: "half",
      } as RequestInit),
    failureMessage: (status) => `Codex compact upstream returned ${status}`,
    readRateLimitResetAt: readCodexRateLimitResetAt,
    onTrace: input.options.onTrace,
    traceRoute: input.context.route,
    traceModel: typeof body === "object" && body && "model" in body
      ? readString((body as Record<string, unknown>).model)
      : input.context.model,
  });
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
        },
        finish_reason: readString(payload.status) === "incomplete" ? "length" : "stop",
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
      })));
    },
    transform(chunk, controller) {
      buffer += STREAM_TEXT_DECODER.decode(chunk, { stream: true });
      buffer = drainSseFrames(buffer, (frame) => {
        for (const output of convertResponsesSseFrame(frame, { id, created, model })) {
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
        for (const output of convertResponsesSseFrame(buffer, { id, created, model })) {
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

    const delta = readString(payload.delta);
    if (delta) outputTextParts.push(delta);

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
    if (readString(payload.type) === "response.incomplete") status = "incomplete";
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

  const delta = readString(payload.delta);
  if (delta) {
    return [
      createChatCompletionChunk({
        ...chunkBase,
        delta: { content: delta },
        finishReason: null,
      }),
    ];
  }

  if (isResponsesCompletionEvent(event, payload)) {
    return [
      createChatCompletionChunk({
        ...chunkBase,
        delta: {},
        finishReason: readString(payload.status) === "incomplete" ? "length" : "stop",
      }),
      "[DONE]",
    ];
  }

  return [];
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
}): Record<string, unknown> {
  return {
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
  record.store = false;
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
  if (record.service_tier === "fast") {
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
): Headers {
  const upstream = new Headers(headers);
  upstream.delete("authorization");
  upstream.delete("x-api-key");
  upstream.delete("host");
  upstream.delete("content-length");
  upstream.delete("connection");
  upstream.delete("accept-encoding");
  upstream.set("authorization", `Bearer ${accessToken}`);
  upstream.set("originator", headers.get("originator") ?? CODEX_ORIGINATOR);
  upstream.set("user-agent", headers.get("user-agent") ?? CODEX_USER_AGENT);
  upstream.set("content-type", "application/json");

  if (accountId) {
    upstream.set("ChatGPT-Account-ID", accountId);
  } else {
    upstream.delete("ChatGPT-Account-ID");
  }

  return upstream;
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
