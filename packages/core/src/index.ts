import { createHash } from "node:crypto";

export type ProviderId = "codex" | "claude-code";

export type GatewayRoute =
  | "/v1/models"
  | "/v1/usage"
  | "/v1/audio/transcriptions"
  | "/v1/images/generations"
  | "/v1/images/edits"
  | "/v1/images/variations"
  | "/v1/responses"
  | "/v1/responses/compact"
  | "/v1/chat/completions"
  | "/v1/messages"
  | "/v1/messages/count_tokens"
  | "/backend-api/codex/models"
  | "/backend-api/codex/responses"
  | "/backend-api/codex/responses/compact"
  | "/backend-api/files"
  | "/backend-api/files/uploaded"
  | "/backend-api/transcribe"
  | "/api/codex/usage";

export interface ModelInfo {
  id: string;
  provider: ProviderId;
  upstreamId: string;
  displayName?: string;
  aliases?: string[];
  capabilities: ModelCapability[];
}

export type ModelCapability =
  | "chat"
  | "responses"
  | "messages"
  | "tools"
  | "streaming"
  | "reasoning"
  | "codex"
  | "claude-code";

export interface GatewayRequestContext {
  request: Request;
  route: GatewayRoute;
  sessionKey: string;
  body?: unknown;
  model?: string;
}

export type GatewayWebSocketMessage =
  | { type: "text"; data: string }
  | { type: "binary"; data: Uint8Array }
  | { type: "close"; code?: number; reason?: string };

export interface GatewayWebSocket {
  accept(headers?: HeadersInit): Promise<void>;
  receive(): Promise<GatewayWebSocketMessage>;
  sendText(data: string): Promise<void>;
  sendBinary(data: Uint8Array): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface GatewayWebSocketContext {
  request: Request;
  route: GatewayRoute;
  sessionKey: string;
  model?: string;
  websocket: GatewayWebSocket;
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  routes: GatewayRoute[];
  listModels(): Promise<ModelInfo[]>;
  handleRequest(context: GatewayRequestContext): Promise<Response>;
  handleWebSocket?(context: GatewayWebSocketContext): Promise<void>;
}

export interface GatewayConfig {
  host: string;
  port: number;
}

export interface SessionKeyInput {
  headers: Headers;
  body?: unknown;
  model?: string;
  apiKeyFingerprint?: string;
}

export function createDefaultGatewayConfig(): GatewayConfig {
  return {
    host: process.env.KYOLI_HOST ?? "127.0.0.1",
    port: readPort(process.env.KYOLI_PORT, 2021),
  };
}

export function createSessionKey(input: SessionKeyInput): string {
  const explicit = readHeaderSessionId(input.headers);
  if (explicit) return `header:${explicit}`;

  const bodySession = readBodySessionId(input.body);
  if (bodySession) {
    return bodySession.startsWith("prompt_cache:") ? bodySession : `body:${bodySession}`;
  }

  if (inferProviderFromModel(input.model ?? "") === "claude-code") {
    const firstUserText = readFirstUserText(input.body);
    if (firstUserText) {
      return `prompt_cache:claude_first_user:${hashSessionText(firstUserText)}`;
    }
  }

  const apiKey = input.apiKeyFingerprint ?? "anonymous";
  const model = input.model ?? "unknown-model";
  return `fallback:${apiKey}:${model}`;
}

export function inferProviderFromModel(model: string): ProviderId | undefined {
  const [prefix] = model.split("/", 1);
  if (prefix === "openai" || prefix === "codex") return "codex";
  if (prefix === "anthropic" || prefix === "claude-code") return "claude-code";
  return undefined;
}

export function stripProviderPrefix(model: string): string {
  const provider = inferProviderFromModel(model);
  if (!provider) return model;
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

export * from "./accounts";
export * from "./account-state";
export * from "./account-status";
export * from "./account-pool";
export * from "./sticky-sessions";
export * from "./request-logs";
export * from "./provider-executor";

export function notImplementedResponse(provider: ProviderId, route: GatewayRoute): Response {
  return jsonResponse(
    {
      error: {
        type: "not_implemented",
        message: `${provider} adapter has not implemented ${route} yet.`,
      },
    },
    { status: 501 },
  );
}

function readPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBodySessionId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const metadata = record.metadata;

  for (const key of ["session_id", "conversation_id", "thread_id"]) {
    const direct = record[key];
    if (typeof direct === "string" && direct.length > 0) return direct;
  }

  if (metadata && typeof metadata === "object") {
    const metadataRecord = metadata as Record<string, unknown>;
    for (const key of ["session_id", "conversation_id", "thread_id"]) {
      const value = metadataRecord[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }

  for (const key of ["prompt_cache_key", "promptCacheKey"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return `prompt_cache:${value}`;
  }

  if (metadata && typeof metadata === "object") {
    const metadataRecord = metadata as Record<string, unknown>;
    for (const key of ["prompt_cache_key", "promptCacheKey"]) {
      const value = metadataRecord[key];
      if (typeof value === "string" && value.length > 0) return `prompt_cache:${value}`;
    }
  }

  return undefined;
}

function readHeaderSessionId(headers: Headers): string | undefined {
  for (const key of [
    "x-kyoli-session-id",
    "x-codex-session-id",
    "x-session-id",
    "x-client-session-id",
    "session_id",
    "session-id",
  ]) {
    const value = headers.get(key);
    if (value) return value;
  }
  return undefined;
}

function readFirstUserText(body: unknown): string | undefined {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
  if (!record || !Array.isArray(record.messages)) return undefined;

  for (const message of record.messages) {
    const messageRecord = message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : undefined;
    if (messageRecord?.role !== "user") continue;

    const content = messageRecord.content;
    if (typeof content === "string") return content.trim() || undefined;
    if (!Array.isArray(content)) return undefined;

    const text = content
      .map((block) => {
        const blockRecord = block && typeof block === "object" && !Array.isArray(block)
          ? (block as Record<string, unknown>)
          : undefined;
        return typeof blockRecord?.text === "string" ? blockRecord.text : "";
      })
      .join("\n\n")
      .trim();
    return text || undefined;
  }

  return undefined;
}

function hashSessionText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
