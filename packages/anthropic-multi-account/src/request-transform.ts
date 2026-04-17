import { randomUUID } from "node:crypto";
import { getModelBetas } from "./betas";
import { loadClaudeIdentity } from "./claude-identity";
import { ANTHROPIC_OAUTH_ADAPTER } from "./constants";
import { loadTemplate } from "./fingerprint-capture";
import {
  createStreamingReverseMapper,
  buildUpstreamRequest,
} from "./upstream-request";
import {
  filterBillableBetas,
  getBetaHeader,
  getPerRequestHeaders,
  getStaticHeaders,
  orderHeadersForOutbound,
} from "./upstream-headers";

type JsonRecord = Record<string, unknown>;
type ToolEntry = { name?: string; [key: string]: unknown };
type RequestPayload = {
  model?: string;
  tools?: ToolEntry[];
  [key: string]: unknown;
};

type ReverseLookup = Map<string, string>;

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

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  accessToken: string,
  modelId = "unknown",
  excludedBetas?: Set<string>,
): HeadersInit {
  const incomingHeaders = getMergedIncomingHeaders(input, init);
  const sessionId = resolveSessionId(incomingHeaders);
  const mergedBetas = dedupeHeaderValues([
    ...splitHeaderValues(getBetaHeader()),
    ...getModelBetas(modelId, excludedBetas),
    ...splitHeaderValues(incomingHeaders["anthropic-beta"]),
  ]).join(",");

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
  if (!body) {
    return body;
  }

  try {
    const parsed = JSON.parse(body) as RequestPayload;
    if (!isRecord(parsed)) {
      return body;
    }

    return JSON.stringify(buildUpstreamRequest(parsed, loadClaudeIdentity(), loadTemplate()));
  } catch {
    return body;
  }
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
