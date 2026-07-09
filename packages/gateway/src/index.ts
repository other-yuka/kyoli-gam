import type {
  AccountCreateInput,
  AccountRecord,
  AccountStore,
  AccountUpdateInput,
  GatewayConfig,
  GatewayRoute,
  GatewayWebSocket,
  GatewayWebSocketMessage,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
  RequestLogStore,
  StickySessionKind,
  StickySessionRegistry,
} from "@kyoli-gam/core";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  createDefaultGatewayConfig,
  createSessionKey,
  inferProviderFromModel,
  isCurrentlyAuthCoolingDown,
  isCurrentlyRateLimited,
  jsonResponse,
  ModelRegistry,
  listBlockedAccounts,
  listExpiredRateLimitAccounts,
  listFailedAccounts,
  listRateLimitedAccounts,
  listReadyAccounts,
  readAccountAvailabilityState,
  readRateLimitRetryAt,
  SQLiteAccountStore,
  summarizeAccountStatus,
  toPublicAccount,
} from "@kyoli-gam/core";
import {
  CodexRateLimitResetError,
  consumeCodexRateLimitResetCredit,
  fetchCodexRateLimitResetCredits,
  type CodexRateLimitResetConsumeResult,
  type CodexRateLimitResetCredit,
  type CodexRateLimitResetCreditsStatus,
} from "@kyoli-gam/provider-codex-chatgpt/reset-credits";
import {
  createUpgradeRequest,
  NodeGatewayWebSocket,
  WebSocketUpgradeError,
  writeUpgradeError,
} from "./websocket";
import {
  handleCodexClaudeBridgeRequest,
  handleCodexClaudeBridgeWebSocket,
  isCodexClaudeModel,
  toCodexClaudeModelEntry,
} from "./codex-claude-bridge";

export interface GatewayOptions {
  config?: Partial<GatewayConfig>;
  providers: ProviderAdapter[];
  accounts?: AccountStore;
  stickySessions?: StickySessionRegistry;
  requestLogs?: RequestLogStore;
  adminToken?: string;
  idleTimeoutSeconds?: number;
  maxConcurrentRequests?: number;
  maxBodyBytes?: number;
  bodyReadTimeoutMs?: number;
  dashboardAssetsDir?: string;
}

export interface Gateway {
  readonly config: GatewayConfig;
  fetch(request: Request): Promise<Response>;
  handleWebSocket(request: Request, websocket: GatewayWebSocket): Promise<void>;
}

export interface GatewayServer {
  readonly hostname: string;
  readonly port: number;
  readonly alreadyRunning?: boolean;
  stop(closeActiveConnections?: boolean): void;
}

const routeByPath = new Map<string, GatewayRoute>([
  ["/v1/models", "/v1/models"],
  ["/v1/usage", "/v1/usage"],
  ["/v1/audio/transcriptions", "/v1/audio/transcriptions"],
  ["/v1/images/generations", "/v1/images/generations"],
  ["/v1/images/edits", "/v1/images/edits"],
  ["/v1/images/variations", "/v1/images/variations"],
  ["/v1/responses", "/v1/responses"],
  ["/v1/responses/compact", "/v1/responses/compact"],
  ["/v1/chat/completions", "/v1/chat/completions"],
  ["/v1/messages", "/v1/messages"],
  ["/v1/messages/count_tokens", "/v1/messages/count_tokens"],
  ["/backend-api/codex/models", "/backend-api/codex/models"],
  ["/backend-api/codex/responses", "/backend-api/codex/responses"],
  ["/backend-api/codex/responses/compact", "/backend-api/codex/responses/compact"],
  ["/backend-api/files", "/backend-api/files"],
  ["/backend-api/transcribe", "/backend-api/transcribe"],
  ["/api/codex/usage", "/api/codex/usage"],
]);

const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 30_000;
const PROMPT_CACHE_STICKY_TTL_SECONDS = 30 * 60;
const OLD_ROUTE_PIN_TTL_SECONDS = 24 * 60 * 60;

export function createGateway(options: GatewayOptions): Gateway {
  const config = resolveGatewayConfig(options.config);
  const registry = new ModelRegistry(options.providers);
  const accounts = options.accounts ?? new SQLiteAccountStore();
  const localAdmission = createLocalAdmission(options.maxConcurrentRequests ?? 0);
  return {
    config,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: "kyoli-gam",
          mode: "gateway",
          port: config.port,
        });
      }

      const dashboardResponse = await handleDashboardRequest(request, url, options.dashboardAssetsDir);
      if (dashboardResponse) return dashboardResponse;

      const adminResponse = await handleAdminRequest(
        request,
        url,
        accounts,
        options.providers,
        options.stickySessions,
        options.requestLogs,
        options.adminToken,
      );
      if (adminResponse) return adminResponse;

      const route = resolveRoute(url.pathname);
      if (!route) {
        return jsonResponse(
          {
            error: {
              type: "not_found",
              message: `No route registered for ${url.pathname}.`,
            },
          },
          { status: 404 },
        );
      }

      if (route === "/v1/models") {
        const models = await listModelsOrError(registry);
        if (models instanceof Response) return models;
        return jsonResponse(toOpenAIModelList(models));
      }

      if (route === "/backend-api/codex/models") {
        const models = await listModelsOrError(registry);
        if (models instanceof Response) return models;
        return jsonResponse({
          models: toCodexCliModelList(models),
        });
      }

      if (route === "/api/codex/usage" || route === "/v1/usage") {
        return jsonResponse(createCodexUsageResponse(await accounts.listByProvider("codex")));
      }

      const upstreamRequest = request.clone();
      const body = await readJsonBody(request);
      const model = readModel(body);
      const sessionKey = createSessionKey({
        headers: request.headers,
        body,
        model,
        apiKeyFingerprint: readAuthFingerprint(request.headers),
      });

      const provider = await resolveProvider(registry, route, model);
      if (!provider) {
        return jsonResponse(
          {
            error: {
              type: "provider_not_resolved",
              message:
                "Provide a familiar provider model such as openai/gpt-5.3-codex or anthropic/claude-sonnet-5.",
            },
          },
          { status: 400 },
        );
      }

      if (isCodexClaudeBridgeRoute(route, model)) {
        const releaseAdmission = localAdmission.acquire();
        if (!releaseAdmission) return localOverloadResponse();

        try {
          return await handleCodexClaudeBridgeRequest({
            context: {
              request: upstreamRequest,
              route,
              sessionKey,
              body,
              model,
            },
            provider,
          });
        } finally {
          releaseAdmission();
        }
      }

      if (!provider.routes.includes(route)) {
        return jsonResponse(
          {
            error: {
              type: "route_not_supported",
              message: `${provider.id} does not support ${route}.`,
            },
          },
          { status: 400 },
        );
      }

      const releaseAdmission = localAdmission.acquire();
      if (!releaseAdmission) return localOverloadResponse();

      try {
        return await provider.handleRequest({
          request: upstreamRequest,
          route,
          sessionKey,
          body,
          model,
        });
      } finally {
        releaseAdmission();
      }
    },
    async handleWebSocket(request, websocket) {
      const url = new URL(request.url);
      const route = resolveRoute(url.pathname);
      if (!route) {
        throw new WebSocketUpgradeError(404, `No WebSocket route registered for ${url.pathname}.`);
      }

      const initialMessage = await peekCodexResponsesWebSocketMessage(route, request, websocket);
      const model = readWebSocketPayloadModel(initialMessage) ?? readWebSocketTraceModel(request.headers);
      const provider = await resolveProvider(registry, route, model);
      if (!provider) {
        throw new WebSocketUpgradeError(400, `No provider resolved for ${route}.`);
      }
      const routedWebSocket = initialMessage
        ? new PreloadedGatewayWebSocket(websocket, [initialMessage])
        : websocket;

      if (isCodexClaudeBridgeRoute(route, model)) {
        const releaseAdmission = localAdmission.acquire();
        if (!releaseAdmission) {
          throw new WebSocketUpgradeError(429, "kyoli-gam is temporarily overloaded.");
        }

        try {
          await handleCodexClaudeBridgeWebSocket({
            context: {
              request,
              route,
              sessionKey: createSessionKey({
                headers: request.headers,
                model,
                apiKeyFingerprint: readAuthFingerprint(request.headers),
              }),
              model,
              websocket: routedWebSocket,
            },
            provider,
          });
        } finally {
          releaseAdmission();
        }
        return;
      }

      if (!provider.routes.includes(route) || !provider.handleWebSocket) {
        throw new WebSocketUpgradeError(501, `${provider.id} does not support WebSocket ${route}.`);
      }

      const releaseAdmission = localAdmission.acquire();
      if (!releaseAdmission) {
        throw new WebSocketUpgradeError(429, "kyoli-gam is temporarily overloaded.");
      }

      try {
        await provider.handleWebSocket({
          request,
          route,
          sessionKey: createSessionKey({
            headers: request.headers,
            model,
            apiKeyFingerprint: readAuthFingerprint(request.headers),
          }),
          model,
          websocket: routedWebSocket,
        });
      } finally {
        releaseAdmission();
      }
    },
  };
}

class PreloadedGatewayWebSocket implements GatewayWebSocket {
  constructor(
    private readonly inner: GatewayWebSocket,
    private readonly messages: GatewayWebSocketMessage[],
  ) {}

  accept(headers?: HeadersInit): Promise<void> {
    return this.inner.accept(headers);
  }

  receive(): Promise<GatewayWebSocketMessage> {
    const message = this.messages.shift();
    return message ? Promise.resolve(message) : this.inner.receive();
  }

  sendText(data: string): Promise<void> {
    return this.inner.sendText(data);
  }

  sendBinary(data: Uint8Array): Promise<void> {
    return this.inner.sendBinary(data);
  }

  close(code?: number, reason?: string): Promise<void> {
    return this.inner.close(code, reason);
  }
}

async function peekCodexResponsesWebSocketMessage(
  route: GatewayRoute,
  request: Request,
  websocket: GatewayWebSocket,
): Promise<GatewayWebSocketMessage | undefined> {
  if (route !== "/backend-api/codex/responses" && route !== "/v1/responses") return undefined;

  await websocket.accept({
    "x-codex-turn-state": request.headers.get("x-codex-turn-state") ?? crypto.randomUUID(),
  });
  return receiveWebSocketMessageWithTimeout(websocket, 2_000);
}

async function receiveWebSocketMessageWithTimeout(
  websocket: GatewayWebSocket,
  timeoutMs: number,
): Promise<GatewayWebSocketMessage | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      websocket.receive(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createLocalAdmission(maxConcurrentRequests: number): { acquire(): (() => void) | undefined } {
  const max = Math.max(0, Math.floor(maxConcurrentRequests));
  let active = 0;

  return {
    acquire() {
      if (max === 0) return () => undefined;
      if (active >= max) return undefined;

      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      };
    },
  };
}

function localOverloadResponse(): Response {
  return jsonResponse(
    {
      error: {
        type: "local_overload",
        message: "kyoli-gam is temporarily overloaded. Retry shortly or raise maxConcurrentRequests.",
        retryable: true,
      },
    },
    {
      status: 429,
      headers: { "retry-after": "1" },
    },
  );
}

async function handleDashboardRequest(
  request: Request,
  url: URL,
  dashboardAssetsDir: string | undefined,
): Promise<Response | undefined> {
  if (url.pathname !== "/dashboard" && !url.pathname.startsWith("/dashboard/")) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(
      {
        error: {
          type: "method_not_allowed",
          message: `${request.method} is not supported for ${url.pathname}.`,
        },
      },
      { status: 405 },
    );
  }

  const isHead = request.method === "HEAD";
  if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
    return readDashboardAsset("index.html", dashboardAssetsDir, isHead, { cache: "no-store" });
  }

  if (url.pathname.startsWith("/dashboard/assets/")) {
    const assetPath = safeDecodeDashboardPath(url.pathname.slice("/dashboard/assets/".length));
    if (!assetPath) return dashboardNotFound();
    return readDashboardAsset(join("assets", assetPath), dashboardAssetsDir, isHead, {
      cache: "public, max-age=31536000, immutable",
    });
  }

  return readDashboardAsset("index.html", dashboardAssetsDir, isHead, { cache: "no-store" });
}

async function readDashboardAsset(
  relativePath: string,
  dashboardAssetsDir: string | undefined,
  headOnly: boolean,
  options: { cache: string },
): Promise<Response> {
  for (const root of dashboardAssetDirs(dashboardAssetsDir)) {
    const filePath = safeJoin(root, relativePath);
    if (!filePath) continue;
    try {
      const bytes = await readFile(filePath);
      return new Response(headOnly ? null : bytes, {
        headers: {
          "cache-control": options.cache,
          "content-type": contentTypeFor(filePath),
        },
      });
    } catch {
      continue;
    }
  }
  return dashboardNotFound();
}

function safeDecodeDashboardPath(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("/")) {
      return undefined;
    }
    if (decoded.split("/").some((segment) => segment === "..")) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function dashboardAssetDirs(override: string | undefined): string[] {
  if (override) return [override];
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return uniqueStrings([
    join(moduleDir, "dashboard"),
    join(moduleDir, "..", "dist", "dashboard"),
  ]);
}

function safeJoin(root: string, relativePath: string): string | undefined {
  if (isAbsolute(relativePath)) return undefined;
  const resolvedRoot = resolve(root);
  const resolvedFile = resolve(resolvedRoot, relativePath);
  const rootRelative = relative(resolvedRoot, resolvedFile);
  if (rootRelative.startsWith("..") || isAbsolute(rootRelative)) return undefined;
  return resolvedFile;
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function dashboardNotFound(): Response {
  return jsonResponse(
    {
      error: {
        type: "not_found",
        message: "Dashboard asset not found.",
      },
    },
    { status: 404 },
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function handleAdminRequest(
  request: Request,
  url: URL,
  accounts: AccountStore,
  providers: ProviderAdapter[],
  stickySessions: StickySessionRegistry | undefined,
  requestLogs: RequestLogStore | undefined,
  adminToken: string | undefined,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/admin/")) return undefined;
  if (!isAuthorizedAdminRequest(request, adminToken)) {
    return jsonResponse(
      {
        error: {
          type: "unauthorized",
          message: "Admin API requires a valid bearer token.",
        },
      },
      {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      },
    );
  }

  if (url.pathname === "/admin/accounts" && request.method === "GET") {
    const records = await accounts.list();
    return jsonResponse({
      object: "list",
      data: records.map(toPublicAccount),
    });
  }

  if (url.pathname === "/admin/sticky-sessions" && request.method === "GET") {
    if (readProviderQuery(url) === "invalid") {
      return validationError("provider must be codex or claude-code.").response;
    }

    const sessions = stickySessions?.listStickySessions() ?? [];
    const decorated = sessions.map(toAdminStickySession);
    const filtered = filterStickySessions(decorated, url);
    return jsonResponse({
      object: "list",
      data: filtered,
      total: sessions.length,
      stalePromptCacheCount: decorated.filter((session) => session.kind === "prompt_cache" && session.isStale).length,
      hasMore: false,
    });
  }

  if (url.pathname === "/admin/sticky-sessions/delete" && request.method === "POST") {
    const body = await readJsonObject(request);
    const key = typeof body?.key === "string" ? body.key : "";
    if (!key) return validationError("key is required.").response;
    const deleted = stickySessions?.deleteStickySession(key) ?? false;
    return deleted
      ? jsonResponse({ status: "deleted", key })
      : jsonResponse({ error: { type: "not_found", message: "Sticky session not found." } }, { status: 404 });
  }

  if (url.pathname === "/admin/sticky-sessions/clear" && request.method === "POST") {
    const deletedCount = stickySessions?.clearStickySessions() ?? 0;
    return jsonResponse({
      deleted_count: deletedCount,
    });
  }

  if (url.pathname === "/admin/sticky-sessions/purge" && request.method === "POST") {
    const body = await readJsonObject(request);
    const provider = readProviderValue(body?.provider);
    if (provider === "invalid") {
      return validationError("provider must be codex or claude-code.").response;
    }

    const staleOnly = body?.staleOnly === true;
    const deletedCount = stickySessions?.purgeStickySessions({
      maxAgeSeconds: readNumber(body?.maxAgeSeconds) ??
        (staleOnly ? PROMPT_CACHE_STICKY_TTL_SECONDS : 7 * 24 * 60 * 60),
      provider,
      kind: readStickySessionKindValue(typeof body?.kind === "string" ? body.kind : undefined) ??
        (staleOnly ? "prompt_cache" : undefined),
      accountId: typeof body?.accountId === "string" ? body.accountId : undefined,
    }) ?? 0;
    return jsonResponse({
      deleted_count: deletedCount,
    });
  }

  if (url.pathname === "/admin/request-logs" && request.method === "GET") {
    const provider = readProviderQuery(url);
    if (provider === "invalid") {
      return validationError("provider must be codex or claude-code.").response;
    }

    const logs = requestLogs?.listRequestLogs({
      requestId: url.searchParams.get("requestId") ?? undefined,
      provider,
      accountId: url.searchParams.get("accountId") ?? undefined,
      sessionKey: url.searchParams.get("sessionKey") ?? undefined,
      status: readNumberParam(url, "status"),
      limit: readNumberParam(url, "limit"),
      offset: readNumberParam(url, "offset"),
    }) ?? [];

    return jsonResponse({
      object: url.searchParams.get("grouped") === "true" ? "request_log_group_list" : "list",
      data: url.searchParams.get("grouped") === "true" ? groupRequestLogs(logs) : logs,
    });
  }

  if (url.pathname === "/admin/request-logs/clear" && request.method === "POST") {
    return jsonResponse({
      deleted_count: requestLogs?.clearRequestLogs() ?? 0,
    });
  }

  if (url.pathname === "/admin/accounts/status" && request.method === "GET") {
    const provider = readProviderQuery(url);
    if (provider === "invalid") {
      return validationError("provider must be codex or claude-code.").response;
    }

    const records = provider
      ? await accounts.listByProvider(provider)
      : await accounts.list();
    return jsonResponse(createAccountStatusResponse(records));
  }

  if (url.pathname === "/admin/accounts/reset-expired" && request.method === "POST") {
    const provider = readProviderQuery(url);
    if (provider === "invalid") {
      return validationError("provider must be codex or claude-code.").response;
    }

    const body = await readJsonObject(request);
    const records = provider
      ? await accounts.listByProvider(provider)
      : await accounts.list();
    const reset = [];
    for (const account of listExpiredRateLimitAccounts(records)) {
      const updated = await accounts.resetState(account.id, {
        enable: body?.enable === true,
      });
      if (updated) reset.push(toPublicAccount(updated));
    }

    return jsonResponse({
      object: "list",
      data: reset,
    });
  }

  if (url.pathname === "/admin/accounts" && request.method === "POST") {
    const body = await readJsonObject(request);
    const input = parseAccountCreateInput(body);
    if (!input.ok) return input.response;

    const account = await accounts.create(input.value);
    return jsonResponse(toPublicAccount(account), { status: 201 });
  }

  const codexResetMatch = url.pathname.match(/^\/admin\/accounts\/([^/]+)\/codex-reset$/);
  if (codexResetMatch) {
    if (request.method !== "GET" && request.method !== "POST") {
      return jsonResponse(
        {
          error: {
            type: "method_not_allowed",
            message: `${request.method} is not supported for ${url.pathname}.`,
          },
        },
        { status: 405 },
      );
    }

    return handleAdminCodexResetRequest({
      accounts,
      providers,
      accountId: decodeURIComponent(codexResetMatch[1] ?? ""),
      body: request.method === "POST" ? await readJsonObject(request) : undefined,
      consume: request.method === "POST",
    });
  }

  const resetMatch = url.pathname.match(/^\/admin\/accounts\/([^/]+)\/reset$/);
  if (resetMatch && request.method === "POST") {
    const resetId = decodeURIComponent(resetMatch[1] ?? "");
    const body = await readJsonObject(request);
    const account = await accounts.resetState(resetId, {
      enable: body?.enable === true,
    });
    return account
      ? jsonResponse(toPublicAccount(account))
      : jsonResponse({ error: { type: "not_found", message: "Account not found." } }, { status: 404 });
  }

  const actionMatch = url.pathname.match(/^\/admin\/accounts\/([^/]+)\/(pause|reactivate)$/);
  if (actionMatch && request.method === "POST") {
    const accountId = decodeURIComponent(actionMatch[1] ?? "");
    const action = actionMatch[2];
    const account = action === "reactivate"
      ? await accounts.resetState(accountId, { enable: true })
      : await accounts.update(accountId, { enabled: false });
    return account
      ? jsonResponse(toPublicAccount(account))
      : jsonResponse({ error: { type: "not_found", message: "Account not found." } }, { status: 404 });
  }

  const accountMatch = url.pathname.match(/^\/admin\/accounts\/([^/]+)$/);
  if (!accountMatch) {
    return jsonResponse(
      {
        error: {
          type: "not_found",
          message: `No admin route registered for ${url.pathname}.`,
        },
      },
      { status: 404 },
    );
  }

  const id = decodeURIComponent(accountMatch[1] ?? "");

  if (request.method === "GET") {
    const account = await accounts.get(id);
    return account
      ? jsonResponse(toPublicAccount(account))
      : jsonResponse({ error: { type: "not_found", message: "Account not found." } }, { status: 404 });
  }

  if (request.method === "PATCH") {
    const body = await readJsonObject(request);
    const input = parseAccountUpdateInput(body);
    if (!input.ok) return input.response;

    const account = await accounts.update(id, input.value);
    return account
      ? jsonResponse(toPublicAccount(account))
      : jsonResponse({ error: { type: "not_found", message: "Account not found." } }, { status: 404 });
  }

  if (request.method === "DELETE") {
    const deleted = await accounts.delete(id);
    return deleted
      ? new Response(null, { status: 204 })
      : jsonResponse({ error: { type: "not_found", message: "Account not found." } }, { status: 404 });
  }

  return jsonResponse(
    {
      error: {
        type: "method_not_allowed",
        message: `${request.method} is not supported for ${url.pathname}.`,
      },
    },
    { status: 405 },
  );
}

async function handleAdminCodexResetRequest(options: {
  accounts: AccountStore;
  providers: ProviderAdapter[];
  accountId: string;
  body: Record<string, unknown> | undefined;
  consume: boolean;
}): Promise<Response> {
  const account = await options.accounts.get(options.accountId);
  if (!account) {
    return jsonResponse({ error: { type: "not_found", message: "Account not found." } }, { status: 404 });
  }

  if (account.provider !== "codex" || account.kind !== "oauth") {
    return jsonResponse(
      {
        error: {
          type: "invalid_request",
          message: `Codex reset credits require a codex/oauth account, got ${account.provider}/${account.kind}.`,
        },
      },
      { status: 400 },
    );
  }

  let credential: Awaited<ReturnType<typeof resolveCodexResetAdminCredential>>;
  try {
    credential = await resolveCodexResetAdminCredential(options.accounts, options.providers, account);
  } catch (error) {
    return jsonResponse(
      {
        error: {
          type: "codex_reset_unavailable",
          message: error instanceof Error ? error.message : "Codex reset credit credential resolution failed.",
        },
      },
      { status: 400 },
    );
  }

  let credits: CodexRateLimitResetCreditsStatus;
  try {
    credits = await fetchCodexRateLimitResetCredits({
      accessToken: credential.accessToken,
      chatgptAccountId: credential.chatgptAccountId,
    });
  } catch (error) {
    return codexResetUpstreamErrorResponse(error, "Codex reset credit status failed.");
  }

  if (!options.consume) {
    return jsonResponse({
      object: "codex_reset_credit_status",
      account: toPublicAccount(credential.account),
      credits: toPublicCodexResetCredits(credits),
    });
  }

  const requestedCreditId = readString(options.body?.creditId) ?? readString(options.body?.credit_id);
  const available = credits.credits.filter((credit) => credit.status === "available");
  const target = requestedCreditId
    ? available.find((credit) => credit.id === requestedCreditId)
    : available[0];

  if (!target) {
    return jsonResponse(
      {
        object: "codex_reset_credit_redemption",
        account: toPublicAccount(credential.account),
        consumed: false,
        reason: requestedCreditId
          ? `credit_id not available: ${requestedCreditId}`
          : "no available credits",
        credits: toPublicCodexResetCredits(credits),
      },
      { status: 409 },
    );
  }

  let result: CodexRateLimitResetConsumeResult;
  try {
    result = await consumeCodexRateLimitResetCredit({
      accessToken: credential.accessToken,
      chatgptAccountId: credential.chatgptAccountId,
      creditId: target.id,
    });
  } catch (error) {
    return codexResetUpstreamErrorResponse(error, "Codex reset credit consume failed.");
  }

  const resetAccount = await options.accounts.resetState(credential.account.id) ?? credential.account;
  const usageRefresh = await refreshAccountUsageFromProvider(options.accounts, options.providers, resetAccount);
  const finalAccount = usageRefresh.ok ? usageRefresh.account : resetAccount;

  return jsonResponse({
    object: "codex_reset_credit_redemption",
    account: toPublicAccount(finalAccount),
    consumed: true,
    credit: toPublicCodexResetCredit(result.credit ?? target),
    result: toPublicCodexResetConsumeResult(result),
    usage_refresh: usageRefresh.ok
      ? { ok: true }
      : { ok: false, message: usageRefresh.message, status: usageRefresh.status },
  });
}

async function resolveCodexResetAdminCredential(
  accounts: AccountStore,
  providers: ProviderAdapter[],
  account: AccountRecord,
): Promise<{ account: AccountRecord; accessToken: string; chatgptAccountId: string }> {
  let current = account;
  if (shouldRefreshCodexResetCredential(current)) {
    const refresh = await refreshAccountUsageFromProvider(accounts, providers, current);
    if (refresh.ok) current = refresh.account;
  }

  const accessToken = readString(current.credentials.accessToken);
  const chatgptAccountId = readString(current.credentials.accountId) ?? readString(current.metadata.accountId);

  if (!accessToken) {
    throw new Error("Codex account has no access token and cannot list reset credits.");
  }
  if (!chatgptAccountId) {
    throw new Error("Codex account has no ChatGPT account id for reset credit calls.");
  }

  return { account: current, accessToken, chatgptAccountId };
}

function shouldRefreshCodexResetCredential(account: AccountRecord): boolean {
  return !readString(account.credentials.accessToken) ||
    !readString(account.credentials.accountId) ||
    isCredentialExpired(account.credentials.expiresAt);
}

function isCredentialExpired(value: unknown): boolean {
  const expiresAt = readTimestampMs(value);
  return expiresAt === undefined || expiresAt <= Date.now() + 60_000;
}

function readTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function refreshAccountUsageFromProvider(
  accounts: AccountStore,
  providers: ProviderAdapter[],
  account: AccountRecord,
): Promise<
  | { ok: true; account: AccountRecord }
  | { ok: false; message: string; status?: number }
> {
  const provider = providers.find((candidate) => candidate.id === account.provider && candidate.refreshUsage);
  if (!provider?.refreshUsage) {
    return { ok: false, message: `${account.provider} provider does not expose usage refresh.` };
  }

  const result = await provider.refreshUsage({ account });
  if (!result.ok) {
    return { ok: false, message: result.message, status: result.status };
  }

  const updated = await accounts.update(account.id, {
    credentials: result.credentials ? { ...account.credentials, ...result.credentials } : account.credentials,
    metadata: result.metadata ? { ...account.metadata, ...result.metadata } : account.metadata,
  });
  return { ok: true, account: updated ?? account };
}

function codexResetUpstreamErrorResponse(error: unknown, fallbackMessage: string): Response {
  if (error instanceof CodexRateLimitResetError) {
    return jsonResponse(
      {
        error: {
          type: "codex_reset_upstream_failed",
          message: error.message || fallbackMessage,
          upstream_status: error.status,
        },
      },
      { status: 502 },
    );
  }

  return jsonResponse(
    {
      error: {
        type: "codex_reset_failed",
        message: error instanceof Error ? error.message : fallbackMessage,
      },
    },
    { status: 500 },
  );
}

function toPublicCodexResetCredits(status: CodexRateLimitResetCreditsStatus) {
  return {
    available_count: status.availableCount,
    credits: status.credits.map(toPublicCodexResetCredit),
  };
}

function toPublicCodexResetCredit(credit: CodexRateLimitResetCredit) {
  return {
    id: credit.id,
    status: credit.status,
    reset_type: credit.resetType,
    title: credit.title,
    granted_at: credit.grantedAt,
    expires_at: credit.expiresAt,
    redeemed_at: credit.redeemedAt,
  };
}

function toPublicCodexResetConsumeResult(result: CodexRateLimitResetConsumeResult) {
  return {
    code: result.code,
    windows_reset: result.windowsReset,
  };
}

function createAccountStatusResponse(records: Awaited<ReturnType<AccountStore["list"]>>) {
  return {
    object: "account_status",
    data: summarizeAccountStatus(records).map(toPublicAccountStatusSummary),
    ready: listReadyAccounts(records).map(toPublicReadyAccount),
    rate_limited: listRateLimitedAccounts(records).map(toPublicRateLimitedAccount),
    blocked: listBlockedAccounts(records).map(toPublicBlockedAccount),
    failed: listFailedAccounts(records).map(toPublicFailedAccount),
    expired_rate_limits: listExpiredRateLimitAccounts(records).map((account) => ({
      id: account.id,
      provider: account.provider,
      reset_at: account.rateLimitResetAt,
      retry_at: readRateLimitRetryAt(account),
      blocked_at: account.rateLimitBlockedAt,
      failure_count: account.failureCount,
      name: account.name,
    })),
  };
}

function toPublicAccountStatusSummary(row: ReturnType<typeof summarizeAccountStatus>[number]) {
  return {
    provider: row.provider,
    total: row.total,
    ready: row.ready,
    rate_limited: row.rateLimited,
    quota_exceeded: row.quotaExceeded,
    auth_cooldown: row.authCooldown,
    disabled: row.disabled,
    reauth_required: row.reauthRequired,
    failed: row.failed,
    next_reset_at: row.nextResetAt,
    next_auth_retry_at: row.nextAuthRetryAt,
  };
}

function createCodexUsageResponse(records: Awaited<ReturnType<AccountStore["listByProvider"]>>) {
  const readyAccounts = records.filter(
    (account) =>
      account.enabled &&
      !account.reauthRequiredReason &&
      !isCurrentlyRateLimited(account) &&
      !isCurrentlyAuthCoolingDown(account),
  );
  const summaries = readyAccounts
    .map((account) => readRecord(account.metadata.cachedUsage) ?? readRecord(account.metadata.usage))
    .filter((usage): usage is Record<string, unknown> => Boolean(usage));

  return {
    object: "codex.usage",
    plan_type: readMostCommonPlan(records),
    rate_limit: summarizeUsageWindow(summaries, "five_hour") ??
      summarizeUsageWindow(summaries, "seven_day"),
    credits: summarizeCredits(summaries),
    additional_rate_limits: [
      createUsageWindowLimit("five_hour", summaries),
      createUsageWindowLimit("seven_day", summaries),
      createUsageWindowLimit("seven_day_sonnet", summaries),
    ].filter(Boolean),
    accounts: records.map((account) => ({
      id: account.id,
      state: readAccountAvailabilityState(account).replaceAll("-", "_"),
      plan_type: readString(account.metadata.planType) ?? readString(account.metadata.plan_type),
      cached_usage_at: account.metadata.cachedUsageAt,
      rate_limit_reset_at: account.rateLimitResetAt,
      rate_limit_retry_at: readRateLimitRetryAt(account),
      rate_limit_blocked_at: account.rateLimitBlockedAt,
    })),
  };
}

function readMostCommonPlan(records: Awaited<ReturnType<AccountStore["listByProvider"]>>): string {
  const counts = new Map<string, number>();
  for (const account of records) {
    const plan = readString(account.metadata.planType) ?? readString(account.metadata.plan_type);
    if (plan) counts.set(plan, (counts.get(plan) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
}

function createUsageWindowLimit(name: string, usages: Record<string, unknown>[]) {
  const rateLimit = summarizeUsageWindow(usages, name);
  if (!rateLimit) return undefined;
  return {
    quota_key: name,
    limit_name: name,
    display_label: name.replaceAll("_", " "),
    metered_feature: name,
    rate_limit: rateLimit,
  };
}

function summarizeUsageWindow(usages: Record<string, unknown>[], key: string) {
  const windows = usages
    .map((usage) => readRecord(usage[key]))
    .filter((window): window is Record<string, unknown> => Boolean(window));
  if (windows.length === 0) return undefined;

  const usedPercents = windows
    .map((window) => readOptionalNumber(String(window.utilization ?? window.used_percent)))
    .filter((value): value is number => typeof value === "number");
  const maxUsedPercent = usedPercents.length > 0 ? Math.max(...usedPercents) : 0;
  const resetAt = windows
    .map((window) => readString(window.reset_at) ?? readString(window.resetAt) ?? readString(window.resets_at) ?? readString(window.resetsAt))
    .filter((value): value is string => Boolean(value))
    .sort()[0];

  return {
    allowed: maxUsedPercent < 100,
    limit_reached: maxUsedPercent >= 100,
    primary_window: {
      used_percent: Math.round(maxUsedPercent),
      reset_at: resetAt ? Math.floor(new Date(resetAt).getTime() / 1000) : undefined,
      reset_after_seconds: resetAt ? secondsUntil(resetAt) : undefined,
    },
  };
}

function summarizeCredits(usages: Record<string, unknown>[]) {
  const credits = usages.map((usage) => readRecord(usage.credits)).find(Boolean);
  if (!credits) return undefined;
  return {
    has_credits: Boolean(credits.has_credits ?? credits.hasCredits ?? true),
    unlimited: Boolean(credits.unlimited),
    balance: readString(credits.balance),
  };
}

function toPublicReadyAccount(row: ReturnType<typeof listReadyAccounts>[number]) {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    plan_tier: row.planTier,
    last_used_at: row.lastUsedAt,
    failure_count: row.failureCount,
  };
}

function toPublicRateLimitedAccount(row: ReturnType<typeof listRateLimitedAccounts>[number]) {
  return {
    id: row.id,
    provider: row.provider,
    reset_at: row.resetAt,
    retry_at: row.retryAt,
    blocked_at: row.blockedAt,
    reset_in: row.resetIn,
    failure_count: row.failureCount,
    last_error_at: row.lastErrorAt,
    name: row.name,
  };
}

function toPublicBlockedAccount(row: ReturnType<typeof listBlockedAccounts>[number]) {
  return {
    id: row.id,
    provider: row.provider,
    state: row.state,
    reason: row.reason,
    name: row.name,
    retry_at: row.retryAt,
    consecutive_auth_failures: row.consecutiveAuthFailures,
  };
}

function toPublicFailedAccount(row: ReturnType<typeof listFailedAccounts>[number]) {
  return {
    id: row.id,
    provider: row.provider,
    state: row.state,
    failure_count: row.failureCount,
    last_error_at: row.lastErrorAt,
    reset_at: row.resetAt,
    auth_retry_at: row.authRetryAt,
    name: row.name,
  };
}

export async function serveGateway(options: GatewayOptions): Promise<GatewayServer> {
  const config = resolveGatewayConfig(options.config);
  let gateway: Gateway | undefined;
  const server = createServer(async (request, response) => {
    if (!gateway) {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        error: {
          type: "gateway_starting",
          message: "Gateway is still starting.",
        },
      }));
      return;
    }

    try {
      const gatewayResponse = await gateway.fetch(await toWebRequest(request, {
        maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        timeoutMs: options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS,
      }));
      await writeNodeResponse(response, gatewayResponse);
    } catch (error) {
      writeGatewayErrorResponse(response, error);
    }
  });
  server.on("upgrade", async (request, socket, head) => {
    const networkSocket = socket as Socket;
    if (!gateway) {
      writeUpgradeError(networkSocket, 503, "Gateway is still starting.");
      return;
    }
    const websocket = new NodeGatewayWebSocket(
      request,
      networkSocket,
      head,
    );

    try {
      await gateway.handleWebSocket(createUpgradeRequest(request), websocket);
    } catch (error) {
      if (websocket.accepted) {
        await websocket.close(
          1011,
          error instanceof Error ? error.message : "WebSocket handling failed.",
        );
        return;
      }
      const status = error instanceof WebSocketUpgradeError ? error.status : 500;
      writeUpgradeError(networkSocket, status, error instanceof Error ? error.message : "WebSocket upgrade failed.");
    }
  });

  server.requestTimeout = (options.idleTimeoutSeconds ?? 255) * 1000;
  server.keepAliveTimeout = (options.idleTimeoutSeconds ?? 255) * 1000;

  const bindResult = await new Promise<"listening" | "already-running">((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      if (isAddressInUseError(error)) {
        void probeExistingKyoliGateway(config)
          .then((alreadyRunning) => {
            if (alreadyRunning) {
              resolve("already-running");
              return;
            }
            reject(createPortInUseError(config));
          })
          .catch(() => {
            reject(createPortInUseError(config));
          });
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      try {
        gateway = createGateway(options);
      } catch (error) {
        server.close();
        reject(error);
        return;
      }
      resolve("listening");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });

  if (bindResult === "already-running") {
    return {
      hostname: config.host,
      port: config.port,
      alreadyRunning: true,
      stop() {},
    };
  }

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  return {
    hostname: config.host,
    port,
    stop(closeActiveConnections = false) {
      if (closeActiveConnections) server.closeAllConnections();
      server.close();
    },
  };
}

function writeGatewayErrorResponse(
  response: import("node:http").ServerResponse,
  error: unknown,
): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }

  response.statusCode = error instanceof BodyReadError ? error.status : 500;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    error: {
      type: error instanceof BodyReadError ? error.type : "internal_error",
      message: error instanceof Error ? error.message : "Gateway request failed.",
    },
  }));
}

function resolveGatewayConfig(config: Partial<GatewayConfig> | undefined): GatewayConfig {
  const defaults = createDefaultGatewayConfig();
  return {
    host: config?.host ?? defaults.host,
    port: config?.port ?? defaults.port,
  };
}

function isAddressInUseError(error: Error): boolean {
  return "code" in error && error.code === "EADDRINUSE";
}

function createPortInUseError(config: GatewayConfig): Error {
  return new Error(
    `Port ${config.port} is already in use by another process. Stop it or set KYOLI_PORT/--port to another value.`,
  );
}

async function probeExistingKyoliGateway(config: GatewayConfig): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  timeout.unref?.();

  try {
    const response = await fetch(`http://${toUrlHost(toProbeHost(config.host))}:${config.port}/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    return isKyoliGatewayHealth(await response.json().catch(() => undefined));
  } finally {
    clearTimeout(timeout);
  }
}

function isKyoliGatewayHealth(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.service === "kyoli-gam" && record.mode === "gateway";
}

function toProbeHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized === "localhost"
  ) {
    return "127.0.0.1";
  }
  return host;
}

function toUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function toWebRequest(
  request: import("node:http").IncomingMessage,
  options: { maxBodyBytes: number; timeoutMs: number },
): Promise<Request> {
  const host = request.headers.host ?? "127.0.0.1";
  const url = `http://${host}${request.url ?? "/"}`;
  const init: RequestInit = {
    method: request.method,
    headers: toWebHeaders(request.headers),
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await readRequestBody(request, options);
    init.body = body.length > 0 ? new Uint8Array(body) : undefined;
  }
  return new Request(url, init);
}

class BodyReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
  ) {
    super(message);
  }
}

function readRequestBody(
  request: import("node:http").IncomingMessage,
  options: { maxBodyBytes: number; timeoutMs: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new BodyReadError("Request body read timed out.", 408, "request_timeout"));
    }, options.timeoutMs);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    const contentLength = readContentLength(request.headers["content-length"]);
    if (contentLength !== undefined && contentLength > options.maxBodyBytes) {
      request.resume();
      fail(new BodyReadError("Request body is too large.", 413, "payload_too_large"));
      return;
    }

    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > options.maxBodyBytes) {
        request.resume();
        fail(new BodyReadError("Request body is too large.", 413, "payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks, total));
    });
    request.on("error", (error) => {
      fail(error);
    });
  });
}

function readContentLength(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const length = Number.parseInt(raw, 10);
  return Number.isFinite(length) && length >= 0 ? length : undefined;
}

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result.set(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    }
  }
  return result;
}

async function writeNodeResponse(
  response: import("node:http").ServerResponse,
  gatewayResponse: Response,
): Promise<void> {
  response.statusCode = gatewayResponse.status;
  response.statusMessage = gatewayResponse.statusText;
  gatewayResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });

  const setCookie = typeof gatewayResponse.headers.getSetCookie === "function"
    ? gatewayResponse.headers.getSetCookie()
    : [];
  if (setCookie.length > 0) response.setHeader("set-cookie", setCookie);

  if (!gatewayResponse.body) {
    response.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const body = Readable.fromWeb(gatewayResponse.body as never);
    let settled = false;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      response.off("error", onResponseError);
      response.off("close", onResponseClose);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const onResponseError = (error: Error) => finish(error);
    const onResponseClose = () => {
      body.destroy();
      finish();
    };

    response.on("error", onResponseError);
    response.on("close", onResponseClose);
    body.on("error", (error) => {
      if (writeGatewayStreamFailure(response, gatewayResponse, error)) {
        finish();
        return;
      }
      finish(error);
    });
    body.on("end", () => {
      if (!response.writableEnded) response.end();
      finish();
    });
    body.pipe(response, { end: false });
  });
}

function writeGatewayStreamFailure(
  response: import("node:http").ServerResponse,
  gatewayResponse: Response,
  _error: unknown,
): boolean {
  if (response.destroyed || response.writableEnded) return false;
  if (!isEventStreamResponse(gatewayResponse)) return false;

  response.write(formatGatewayStreamFailureEvent());
  response.write("data: [DONE]\n\n");
  response.end();
  return true;
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
}

function formatGatewayStreamFailureEvent(): string {
  const payload = {
    type: "response.failed",
    response: {
      id: `resp_gateway_stream_${Date.now()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      error: {
        type: "server_error",
        code: "gateway_stream_error",
        message: "Gateway stream failed before response.completed.",
      },
    },
  };
  return `event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`;
}

function filterStickySessions(
  sessions: AdminStickySession[],
  url: URL,
): AdminStickySession[] {
  const provider = readProviderQuery(url);
  if (provider === "invalid") return [];

  const accountId = url.searchParams.get("accountId");
  const kind = readStickySessionKindValue(url.searchParams.get("kind") ?? undefined);
  const keyQuery = url.searchParams.get("keyQuery")?.toLowerCase();
  const staleOnly = url.searchParams.get("staleOnly") === "true";

  return sessions.filter((session) => {
    if (provider && session.provider !== provider) return false;
    if (kind && session.kind !== kind) return false;
    if (accountId && session.accountId !== accountId) return false;
    if (keyQuery && !session.key.toLowerCase().includes(keyQuery)) return false;
    if (staleOnly && !(session.kind === "prompt_cache" && session.isStale)) return false;
    return true;
  });
}

type StickySessionListRecord = ReturnType<StickySessionRegistry["listStickySessions"]>[number];

interface AdminStickySession extends StickySessionListRecord {
  expiresAt: string | null;
  isStale: boolean;
  oldRoutePin: boolean;
}

function toAdminStickySession(session: StickySessionListRecord): AdminStickySession {
  const updatedAtMs = Date.parse(session.updatedAt);
  const ageSeconds = Number.isFinite(updatedAtMs)
    ? Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000))
    : 0;
  const expiresAt = session.kind === "prompt_cache" && Number.isFinite(updatedAtMs)
    ? new Date(updatedAtMs + PROMPT_CACHE_STICKY_TTL_SECONDS * 1000).toISOString()
    : null;

  return {
    ...session,
    expiresAt,
    isStale: session.kind === "prompt_cache" && ageSeconds >= PROMPT_CACHE_STICKY_TTL_SECONDS,
    oldRoutePin: ageSeconds >= OLD_ROUTE_PIN_TTL_SECONDS,
  };
}

function resolveRoute(pathname: string): GatewayRoute | undefined {
  return routeByPath.get(pathname) ??
    (pathname.match(/^\/backend-api\/files\/[^/]+\/uploaded$/)
      ? "/backend-api/files/uploaded"
      : undefined);
}

const CODEX_FAST_SERVICE_TIER = {
  id: "priority",
  name: "Fast",
  description: "1.5x speed, increased usage",
};

function toCodexCliModelEntry(model: ModelInfo): Record<string, unknown> {
  const contextWindow = model.upstreamId.includes("gpt-5.4") ? 1_050_000 : 272_000;
  const entry: Record<string, unknown> = {
    slug: model.upstreamId,
    display_name: model.displayName ?? model.upstreamId,
    description: model.displayName ?? model.upstreamId,
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balanced reasoning" },
      { effort: "high", description: "Deeper reasoning" },
      { effort: "xhigh", description: "Extra deep reasoning" },
    ],
    supported_in_api: true,
    priority: 0,
    minimal_client_version: null,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    supports_reasoning_summaries: model.capabilities.includes("reasoning"),
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "medium",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: model.capabilities.includes("tools"),
    shell_type: "shell_command",
    supports_image_detail_original: true,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    available_in_plans: ["plus", "pro"],
    prefer_websockets: true,
    visibility: "list",
  };

  Object.assign(entry, codexCliModelMetadata(model));
  if (shouldExposeFallbackFastServiceTier(model, entry)) {
    entry.additional_speed_tiers = [
      ...(Array.isArray(entry.additional_speed_tiers) ? entry.additional_speed_tiers : []),
      "fast",
    ];
    entry.service_tiers = [
      ...(Array.isArray(entry.service_tiers) ? entry.service_tiers : []),
      CODEX_FAST_SERVICE_TIER,
    ];
  }

  return entry;
}

function toOpenAIModelList(models: ModelInfo[]): { object: "list"; data: unknown[] } {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      owned_by: model.provider,
      kyoli: {
        provider: model.provider,
        upstream_id: model.upstreamId,
        display_name: model.displayName,
        capabilities: model.capabilities,
        aliases: model.aliases ?? [],
      },
    })),
  };
}

function toCodexCliModelList(models: ModelInfo[]): Array<Record<string, unknown>> {
  return [
    ...models
      .filter((model) => model.provider === "codex")
      .map(toCodexCliModelEntry),
    ...models.flatMap((model) => {
      const entry = toCodexClaudeModelEntry(model);
      return entry ? [entry] : [];
    }),
  ];
}

async function listModelsOrError(registry: ModelRegistry): Promise<ModelInfo[] | Response> {
  try {
    return await registry.listModels();
  } catch (error) {
    const status = readErrorStatus(error) ?? 500;
    return jsonResponse(
      {
        error: {
          type: "model_catalog_error",
          message: error instanceof Error ? error.message : "Model catalog failed.",
        },
      },
      { status },
    );
  }
}

function codexCliModelMetadata(model: ModelInfo): Record<string, unknown> {
  const metadata = model.metadata;
  if (!metadata) return {};

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "slug") continue;
    if (isJsonObjectValue(value)) {
      extra[key] = value;
    }
  }
  return extra;
}

function shouldExposeFallbackFastServiceTier(
  model: ModelInfo,
  entry: Record<string, unknown>,
): boolean {
  if (model.provider !== "codex") return false;
  const slug = model.upstreamId.toLowerCase();
  if (slug !== "gpt-5.4" && slug !== "gpt-5.5") return false;

  const serviceTiers = Array.isArray(entry.service_tiers) ? entry.service_tiers : [];
  if (serviceTiers.length > 0) return false;

  const additionalSpeedTiers = Array.isArray(entry.additional_speed_tiers)
    ? entry.additional_speed_tiers
    : [];
  return additionalSpeedTiers.length === 0;
}

function readErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status <= 599 ? status : undefined;
}

function isJsonObjectValue(value: unknown): boolean {
  if (value === null) return true;
  if (["boolean", "number", "string"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonObjectValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonObjectValue);
}

async function resolveProvider(
  registry: ModelRegistry,
  route: GatewayRoute,
  model: string | undefined,
): Promise<ProviderAdapter | undefined> {
  if (isCodexClaudeBridgeRoute(route, model)) {
    return registry.getAdapter("claude-code");
  }
  if (
    route === "/v1/responses" ||
    route === "/backend-api/codex/models" ||
    route === "/backend-api/codex/responses" ||
    route === "/backend-api/codex/responses/compact"
  ) {
    return registry.getAdapter("codex");
  }
  if (route === "/backend-api/files" || route === "/backend-api/files/uploaded") {
    return registry.getAdapter("codex");
  }
  if (
    route === "/backend-api/transcribe" ||
    route === "/v1/audio/transcriptions" ||
    route === "/v1/images/generations" ||
    route === "/v1/images/edits" ||
    route === "/v1/images/variations"
  ) {
    return registry.getAdapter("codex");
  }

  if (!model) return undefined;

  const prefixedProvider = inferProviderFromModel(model);
  if (prefixedProvider) {
    return registry.getAdapter(prefixedProvider);
  }

  const resolved = await registry.resolve(model);
  return resolved ? registry.getAdapter(resolved.provider) : undefined;
}

function isCodexClaudeBridgeRoute(route: GatewayRoute, model: string | undefined): boolean {
  return isCodexClaudeModel(model) &&
    (
      route === "/v1/responses" ||
      route === "/backend-api/codex/responses" ||
      route === "/backend-api/codex/responses/compact"
    );
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined;

  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  const body = await readJsonBody(request);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

function parseAccountCreateInput(
  body: Record<string, unknown> | undefined,
):
  | { ok: true; value: AccountCreateInput }
  | { ok: false; response: Response } {
  if (!body) return validationError("Request body must be a JSON object.");

  const provider = body.provider;
  const kind = body.kind;
  if (!isProviderId(provider)) return validationError("provider must be a supported provider id.");
  if (!isAccountKind(kind)) return validationError("kind must be oauth.");

  return {
    ok: true,
    value: {
      provider,
      kind,
      name: typeof body.name === "string" ? body.name : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      credentials: readRecord(body.credentials),
      metadata: readRecord(body.metadata),
    },
  };
}

function parseAccountUpdateInput(
  body: Record<string, unknown> | undefined,
):
  | { ok: true; value: AccountUpdateInput }
  | { ok: false; response: Response } {
  if (!body) return validationError("Request body must be a JSON object.");

  return {
    ok: true,
    value: {
      name: typeof body.name === "string" ? body.name : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      credentials: readRecord(body.credentials),
      metadata: readRecord(body.metadata),
    },
  };
}

function validationError(message: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: jsonResponse({ error: { type: "invalid_request", message } }, { status: 400 }),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function secondsUntil(iso: string): number | undefined {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.ceil(ms / 1000);
}

function isProviderId(value: unknown): value is ProviderId {
  return value === "codex" || value === "claude-code";
}

function readProviderValue(value: unknown): ProviderId | "invalid" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return isProviderId(value) ? value : "invalid";
}

function readStickySessionKindValue(value: string | undefined): StickySessionKind | undefined {
  if (!value) return undefined;
  if (
    value === "oauth" ||
    value === "any" ||
    value === "codex_session" ||
    value === "prompt_cache"
  ) {
    return value;
  }
  return undefined;
}

type GroupedRequestLog = {
  requestId: string;
  provider: ProviderId;
  route?: GatewayRoute;
  model?: string;
  sessionKey: string;
  accountIds: string[];
  startedAt: string;
  completedAt: string;
  finalStatus?: number;
  retryCount: number;
  events: ReturnType<RequestLogStore["listRequestLogs"]>;
};

function groupRequestLogs(logs: ReturnType<RequestLogStore["listRequestLogs"]>) {
  const groups = new Map<string, GroupedRequestLog>();

  for (const log of logs.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)) {
    const group = groups.get(log.requestId) ?? {
      requestId: log.requestId,
      provider: log.provider,
      route: log.route,
      model: log.model,
      sessionKey: log.sessionKey,
      accountIds: [],
      startedAt: log.createdAt,
      completedAt: log.createdAt,
      finalStatus: undefined,
      retryCount: 0,
      events: [],
    };

    if (log.accountId && !group.accountIds.includes(log.accountId)) {
      group.accountIds.push(log.accountId);
    }
    group.route ??= log.route;
    group.model ??= log.model;
    if (log.eventType === "response") group.finalStatus = log.status;
    if (log.eventType === "retry") group.retryCount += 1;
    group.completedAt = log.createdAt;
    group.events.push(log);
    groups.set(log.requestId, group);
  }

  return inheritSessionModels([...groups.values()]).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function inheritSessionModels(groups: GroupedRequestLog[]): GroupedRequestLog[] {
  const latestModelBySession = new Map<string, string>();
  const distinctModelsBySession = new Map<string, Set<string>>();
  const chronologicalGroups = groups.slice().sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt) || a.completedAt.localeCompare(b.completedAt)
  );

  for (const group of chronologicalGroups) {
    if (group.model) {
      latestModelBySession.set(group.sessionKey, group.model);
      const models = distinctModelsBySession.get(group.sessionKey) ?? new Set<string>();
      models.add(group.model);
      distinctModelsBySession.set(group.sessionKey, models);
      continue;
    }

    const inheritedModel = latestModelBySession.get(group.sessionKey);
    if (inheritedModel) group.model = inheritedModel;
  }

  for (const group of chronologicalGroups) {
    if (group.model) continue;
    const models = distinctModelsBySession.get(group.sessionKey);
    if (models?.size === 1) group.model = [...models][0];
  }

  return chronologicalGroups;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNumberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAuthorizedAdminRequest(request: Request, adminToken: string | undefined): boolean {
  if (!adminToken) return true;
  const authorization = request.headers.get("authorization") ?? "";
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  return bearerToken === adminToken || request.headers.get("x-kyoli-admin-token") === adminToken;
}

function readProviderQuery(url: URL): ProviderId | "invalid" | undefined {
  const value = url.searchParams.get("provider");
  if (!value) return undefined;
  return isProviderId(value) ? value : "invalid";
}

function isAccountKind(value: unknown): value is AccountCreateInput["kind"] {
  return value === "oauth";
}

function readModel(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const model = (body as Record<string, unknown>).model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

function readWebSocketTraceModel(headers: Headers): string | undefined {
  const metadata = headers.get("x-codex-turn-metadata");
  if (!metadata) return undefined;
  return readWebSocketPayloadModel({ type: "text", data: metadata });
}

function readWebSocketPayloadModel(message: GatewayWebSocketMessage | undefined): string | undefined {
  if (!message || message.type !== "text") return undefined;
  const record = readJsonRecordValue(message.data);
  return readString(record?.model) ??
    readString(readRecord(record?.request)?.model) ??
    readString(readRecord(record?.response)?.model) ??
    readString(readRecord(record?.value)?.model);
}

function readJsonRecordValue(value: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function readAuthFingerprint(headers: Headers): string | undefined {
  const authorization = headers.get("authorization");
  if (!authorization) return undefined;
  return authorization.slice(-12);
}
