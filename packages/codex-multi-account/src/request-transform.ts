import { CODEX_API_ENDPOINT, OPENAI_CLI_USER_AGENT } from "./constants";

function mergeHeaders(base: Headers, incoming?: HeadersInit): void {
  if (!incoming) return;

  if (incoming instanceof Headers) {
    incoming.forEach((value, key) => base.set(key, value));
    return;
  }

  if (Array.isArray(incoming)) {
    for (const [key, value] of incoming) {
      if (value !== undefined) base.set(key, String(value));
    }
    return;
  }

  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) base.set(key, String(value));
  }
}

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  accessToken: string,
  accountId?: string,
): Headers {
  const headers = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => headers.set(key, value));
  }

  mergeHeaders(headers, init?.headers);

  headers.delete("authorization");
  headers.delete("Authorization");
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("originator", "opencode");
  headers.set("User-Agent", OPENAI_CLI_USER_AGENT);

  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId);
  } else {
    headers.delete("ChatGPT-Account-Id");
  }

  headers.delete("x-api-key");

  return headers;
}

function asUrl(input: RequestInfo | URL): URL | null {
  try {
    if (typeof input === "string" || input instanceof URL) {
      return new URL(input.toString());
    }

    if (input instanceof Request) {
      return new URL(input.url);
    }

    return null;
  } catch {
    return null;
  }
}

export function transformRequestUrl(input: RequestInfo | URL): RequestInfo | URL {
  const url = asUrl(input);
  if (!url) return input;

  const shouldRewrite = url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions");
  if (!shouldRewrite) return input;

  const rewritten = new URL(CODEX_API_ENDPOINT);
  rewritten.search = url.search;

  if (input instanceof Request) {
    return new Request(rewritten.toString(), input);
  }

  return rewritten;
}
