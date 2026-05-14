import type {
  AccountCreateInput,
  AccountStore,
  AccountUpdateInput,
  GatewayConfig,
  GatewayRoute,
  GatewayWebSocket,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
  RequestLogStore,
  StickySessionKind,
  StickySessionRegistry,
} from "@kyoli-gam/core";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import {
  createDefaultGatewayConfig,
  createSessionKey,
  inferProviderFromModel,
  isCurrentlyAuthCoolingDown,
  isCurrentlyRateLimited,
  jsonResponse,
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
  ModelRegistry,
  ModelsDevRegistrySource,
  toOpenAIModelList,
} from "@kyoli-gam/model-registry";
import {
  createUpgradeRequest,
  NodeGatewayWebSocket,
  WebSocketUpgradeError,
  writeUpgradeError,
} from "./websocket";

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
}

export interface Gateway {
  readonly config: GatewayConfig;
  fetch(request: Request): Promise<Response>;
  handleWebSocket(request: Request, websocket: GatewayWebSocket): Promise<void>;
}

export interface GatewayServer {
  readonly hostname: string;
  readonly port: number;
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

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 30_000;

export function createGateway(options: GatewayOptions): Gateway {
  const defaults = createDefaultGatewayConfig();
  const config: GatewayConfig = {
    host: options.config?.host ?? defaults.host,
    port: options.config?.port ?? defaults.port,
  };
  const registry = new ModelRegistry(options.providers, {
    modelsDev: ModelsDevRegistrySource.fromEnv(),
  });
  const accounts = options.accounts ?? new SQLiteAccountStore();
  const localAdmission = createLocalAdmission(options.maxConcurrentRequests ?? 0);
  registry.startAutoRefresh();

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

      const adminResponse = await handleAdminRequest(
        request,
        url,
        accounts,
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
        const models = await registry.listModels();
        return jsonResponse(toOpenAIModelList(models));
      }

      if (route === "/backend-api/codex/models") {
        const models = await registry.listModels();
        return jsonResponse({
          models: models
            .filter((model) => model.provider === "codex")
            .map(toCodexCliModelEntry),
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
                "Provide a familiar provider model such as openai/gpt-5.3-codex or anthropic/claude-sonnet-4-5.",
            },
          },
          { status: 400 },
        );
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

      const provider = await resolveProvider(registry, route, undefined);
      if (!provider) {
        throw new WebSocketUpgradeError(400, `No provider resolved for ${route}.`);
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
            apiKeyFingerprint: readAuthFingerprint(request.headers),
          }),
          websocket,
        });
      } finally {
        releaseAdmission();
      }
    },
  };
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

async function handleAdminRequest(
  request: Request,
  url: URL,
  accounts: AccountStore,
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
    return jsonResponse({
      object: "list",
      data: filterStickySessions(sessions, url),
      total: sessions.length,
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

    const deletedCount = stickySessions?.purgeStickySessions({
      maxAgeSeconds: readNumber(body?.maxAgeSeconds) ?? 7 * 24 * 60 * 60,
      provider,
      kind: readStickySessionKindValue(typeof body?.kind === "string" ? body.kind : undefined),
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
    .map((window) => readString(window.reset_at) ?? readString(window.resetAt))
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
  const gateway = createGateway(options);
  const server = createServer(async (request, response) => {
    try {
      const gatewayResponse = await gateway.fetch(await toWebRequest(request, {
        maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        timeoutMs: options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS,
      }));
      await writeNodeResponse(response, gatewayResponse);
    } catch (error) {
      response.statusCode = error instanceof BodyReadError ? error.status : 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        error: {
          type: error instanceof BodyReadError ? error.type : "internal_error",
          message: error instanceof Error ? error.message : "Gateway request failed.",
        },
      }));
    }
  });
  server.on("upgrade", async (request, socket, head) => {
    const networkSocket = socket as Socket;
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

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(gateway.config.port, gateway.config.host);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : gateway.config.port;

  return {
    hostname: gateway.config.host,
    port,
    stop(closeActiveConnections = false) {
      if (closeActiveConnections) server.closeAllConnections();
      server.close();
    },
  };
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
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new BodyReadError("Request body read timed out.", 408, "request_timeout"));
    }, options.timeoutMs);

    request.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > options.maxBodyBytes) {
        clearTimeout(timeout);
        request.destroy();
        reject(new BodyReadError("Request body is too large.", 413, "payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks, total));
    });
    request.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
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
    Readable.fromWeb(gatewayResponse.body as never)
      .on("error", reject)
      .on("end", resolve)
      .pipe(response);
  });
}

function filterStickySessions(
  sessions: ReturnType<StickySessionRegistry["listStickySessions"]>,
  url: URL,
): ReturnType<StickySessionRegistry["listStickySessions"]> {
  const provider = readProviderQuery(url);
  if (provider === "invalid") return [];

  const accountId = url.searchParams.get("accountId");
  const kind = readStickySessionKindValue(url.searchParams.get("kind") ?? undefined);
  const keyQuery = url.searchParams.get("keyQuery")?.toLowerCase();

  return sessions.filter((session) => {
    if (provider && session.provider !== provider) return false;
    if (kind && session.kind !== kind) return false;
    if (accountId && session.accountId !== accountId) return false;
    if (keyQuery && !session.key.toLowerCase().includes(keyQuery)) return false;
    return true;
  });
}

function resolveRoute(pathname: string): GatewayRoute | undefined {
  return routeByPath.get(pathname) ??
    (pathname.match(/^\/backend-api\/files\/[^/]+\/uploaded$/)
      ? "/backend-api/files/uploaded"
      : undefined);
}

function toCodexCliModelEntry(model: ModelInfo): Record<string, unknown> {
  const contextWindow = model.upstreamId.includes("gpt-5.4") ? 1_050_000 : 272_000;
  return {
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
}

async function resolveProvider(
  registry: ModelRegistry,
  route: GatewayRoute,
  model: string | undefined,
): Promise<ProviderAdapter | undefined> {
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

function groupRequestLogs(logs: ReturnType<RequestLogStore["listRequestLogs"]>) {
  const groups = new Map<string, {
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
    events: typeof logs;
  }>();

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
    if (log.eventType === "response") group.finalStatus = log.status;
    if (log.eventType === "retry") group.retryCount += 1;
    group.completedAt = log.createdAt;
    group.events.push(log);
    groups.set(log.requestId, group);
  }

  return [...groups.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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

function readAuthFingerprint(headers: Headers): string | undefined {
  const authorization = headers.get("authorization");
  if (!authorization) return undefined;
  return authorization.slice(-12);
}
