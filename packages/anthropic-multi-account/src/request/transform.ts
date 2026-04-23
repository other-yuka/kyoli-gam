import { randomUUID } from "node:crypto";
import { ensureOauthBeta, getModelBetas } from "./betas";
import { loadClaudeIdentity } from "../claude-code/identity";
import { ANTHROPIC_OAUTH_ADAPTER } from "../shared/constants";
import { loadTemplate } from "../claude-code/fingerprint/capture";
import {
  createStreamingReverseMapper,
  buildUpstreamRequest,
} from "./upstream-request";
import {
  applyOutboundToolFlow,
  buildRequestScopedToolLookup,
  type ReverseLookup,
} from "../tools/flow";
import {
  filterBillableBetas,
  getBetaHeader,
  getPerRequestHeaders,
  getStaticHeaders,
  orderHeadersForOutbound,
} from "./headers";

type JsonRecord = Record<string, unknown>;
type ToolEntry = { name?: string; [key: string]: unknown };
type RequestPayload = {
  model?: string;
  tools?: ToolEntry[];
  messages?: Array<Record<string, unknown>>;
  tool_choice?: Record<string, unknown>;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

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

function getMergedIncomingHeaders(
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

function splitHeaderValues(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function dedupeHeaderValues(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function excludeBetas(values: string[], excluded?: Set<string>): string[] {
  if (!excluded || excluded.size === 0) {
    return values;
  }

  return values.filter((value) => !excluded.has(value));
}

function resolveSessionId(headers: Record<string, string>): string {
  return headers["x-claude-code-session-id"] ?? randomUUID();
}

function invertLookup(forwardLookup: ReadonlyMap<string, string>): ReverseLookup {
  const reverseLookup: ReverseLookup = new Map();

  for (const [originalName, upstreamName] of forwardLookup) {
    reverseLookup.set(upstreamName, originalName);
  }

  return reverseLookup;
}

export function extractRequestToolMaskMap(body: string | undefined): ReverseLookup {
  if (!body) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(body) as RequestPayload;
    return isRecord(parsed) ? buildRequestScopedToolLookup(parsed, loadTemplate().tool_names) : new Map();
  } catch {
    return new Map();
  }
}

export function applyRequestToolMasking(
  parsed: RequestPayload,
  claudeToolNames: readonly string[],
): { body: string; reverseLookup: ReverseLookup } {
  return applyOutboundToolFlow(parsed, claudeToolNames);
}

export function transformRequestBodyWithLookup(
  body: string | undefined,
  identity = loadClaudeIdentity(),
): { body: string | undefined; reverseLookup: ReverseLookup } {
  if (!body) {
    return { body, reverseLookup: new Map() };
  }

  try {
    const parsed = JSON.parse(body) as RequestPayload;
    if (!isRecord(parsed)) {
      return { body, reverseLookup: new Map() };
    }

    const template = loadTemplate();
    const upstreamRequest = buildUpstreamRequest(parsed, identity, template);
    return applyRequestToolMasking(upstreamRequest as RequestPayload, template.tool_names);
  } catch {
    return { body, reverseLookup: new Map() };
  }
}

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  accessToken: string,
  modelId = "unknown",
  excludedBetas?: Set<string>,
): HeadersInit {
  const incomingHeaders = getMergedIncomingHeaders(input, init);
  const sessionId = resolveSessionId(incomingHeaders);
  const mergedBetas = dedupeHeaderValues(ensureOauthBeta([
    ...excludeBetas(splitHeaderValues(getBetaHeader()), excludedBetas),
    ...getModelBetas(modelId, excludedBetas),
    ...excludeBetas(splitHeaderValues(incomingHeaders["anthropic-beta"]), excludedBetas),
  ])).join(",");

  const outboundHeaders: Record<string, string> = {
    ...incomingHeaders,
    ...getStaticHeaders(),
    ...getPerRequestHeaders(sessionId),
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta": filterBillableBetas(mergedBetas),
  };

  delete outboundHeaders["x-api-key"];

  return orderHeadersForOutbound(outboundHeaders);
}

export function transformRequestBody(body: string | undefined): string | undefined {
  return transformRequestBodyWithLookup(body).body;
}

export function extractModelIdFromBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    return "unknown";
  }

  try {
    const parsed = JSON.parse(body) as RequestPayload;
    return typeof parsed.model === "string" ? parsed.model : "unknown";
  } catch {
    return "unknown";
  }
}

export function transformRequestUrl(input: RequestInfo | URL): RequestInfo | URL {
  let url: URL | null = null;
  try {
    if (typeof input === "string" || input instanceof URL) {
      url = new URL(input.toString());
    } else if (input instanceof Request) {
      url = new URL(input.url);
    }
  } catch {
    return input;
  }

  if (
    ANTHROPIC_OAUTH_ADAPTER.transform.enableMessagesBetaQuery
    && url
    && url.pathname === "/v1/messages"
    && !url.searchParams.has("beta")
  ) {
    url.searchParams.set("beta", "true");
    return input instanceof Request ? new Request(url.toString(), input) : url;
  }

  return input;
}

export function extractToolNamesFromRequestBody(body: string | undefined): string[] {
  if (!body) {
    return [];
  }

  try {
    const parsed = JSON.parse(body) as RequestPayload;
    if (!Array.isArray(parsed.tools)) {
      return [];
    }

    return parsed.tools
      .map((tool) => (typeof tool.name === "string" ? tool.name : null))
      .filter((toolName): toolName is string => Boolean(toolName));
  } catch {
    return [];
  }
}

export function createResponseStreamTransform(
  response: Response,
  reverseLookup: ReadonlyMap<string, string> = new Map(),
): Response {
  return createStreamingReverseMapper(response, invertLookup(reverseLookup));
}
