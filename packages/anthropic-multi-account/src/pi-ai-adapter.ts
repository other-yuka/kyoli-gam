import { AsyncLocalStorage } from "node:async_hooks";
import * as piAiOauth from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials as PiAiOAuthCredentials, OAuthPrompt } from "@mariozechner/pi-ai/oauth";
import {
  ANTHROPIC_OAUTH_ADAPTER,
  TOKEN_REFRESH_TIMEOUT_MS,
} from "./constants";
import * as tokenNodeRequest from "./token-node-request";
import { fetchProfile } from "./usage";
import type { StoredAccount, CredentialRefreshPatch } from "./types";

// pi-ai `expires` is epoch milliseconds: Date.now() + expires_in * 1000 - 5min buffer
// StoredAccount `expiresAt` is also epoch milliseconds → 1:1 mapping, no unit conversion needed.

export function toPiAiCredentials(
  account: Pick<StoredAccount, "accessToken" | "refreshToken" | "expiresAt">,
): PiAiOAuthCredentials {
  return {
    access: account.accessToken ?? "",
    refresh: account.refreshToken,
    expires: account.expiresAt ?? 0,
  };
}

export function fromPiAiCredentials(
  creds: PiAiOAuthCredentials,
): Pick<StoredAccount, "accessToken" | "refreshToken" | "expiresAt"> {
  return {
    accessToken: creds.access,
    refreshToken: creds.refresh,
    expiresAt: creds.expires,
  };
}

export interface LoginWithPiAiCallbacks {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  userAgent?: string;
}

const ANTHROPIC_REFRESH_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_TOKEN_HOST = "platform.claude.com";
const REFRESH_NODE_EXECUTABLE = process.env.OPENCODE_REFRESH_NODE_EXECUTABLE || "node";
type AnthropicFetchContext = {
  proxyTokenRequests: boolean;
  userAgent?: string;
};

const tokenProxyContext = new AsyncLocalStorage<AnthropicFetchContext>();
let tokenProxyInstalled = false;
let tokenProxyOriginalFetch: typeof globalThis.fetch | null = null;
const refreshEndpointUrl = new URL(ANTHROPIC_REFRESH_ENDPOINT);

function buildRefreshRequestError(details: string): Error {
  return new Error(`Anthropic token refresh request failed. url=${ANTHROPIC_REFRESH_ENDPOINT}; details=${details}`);
}

function buildRefreshInvalidJsonError(body: string, details: string): Error {
  return new Error(`Anthropic token refresh returned invalid JSON. url=${ANTHROPIC_REFRESH_ENDPOINT}; body=${body}; details=${details}`);
}

function getRequestUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isAnthropicTokenEndpoint(input: RequestInfo | URL): boolean {
  const rawUrl = getRequestUrlString(input);

  try {
    const url = new URL(rawUrl);
    return url.origin === refreshEndpointUrl.origin
      && url.pathname === refreshEndpointUrl.pathname;
  } catch {
    return rawUrl === ANTHROPIC_REFRESH_ENDPOINT;
  }
}

function getRequestBodySource(input: RequestInfo | URL, init?: RequestInit): BodyInit | null | undefined {
  if (init?.body !== undefined) {
    return init.body;
  }

  if (input instanceof Request) {
    return input.body;
  }

  return undefined;
}

function stringifyBinaryBody(body: ArrayBuffer | ArrayBufferView): string {
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body).toString("utf8");
  }

  return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
}

async function getRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  const body = getRequestBodySource(input, init);

  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return stringifyBinaryBody(body);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return await body.text();
  if (body instanceof ReadableStream) return await new Response(body).text();
  if (input instanceof Request && init?.body === undefined) return await input.clone().text();
  if (body == null) return "";

  throw buildRefreshRequestError(`Unsupported token request body type: ${Object.prototype.toString.call(body)}`);
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return init?.method ?? (input instanceof Request ? input.method : "GET");
}

function shouldProxyTokenRequest(input: RequestInfo | URL): boolean {
  return tokenProxyContext.getStore()?.proxyTokenRequests === true && isAnthropicTokenEndpoint(input);
}

function shouldInjectAnthropicUserAgent(input: RequestInfo | URL): boolean {
  const userAgent = tokenProxyContext.getStore()?.userAgent;
  if (!userAgent) return false;
  const rawUrl = getRequestUrlString(input);

  try {
    const url = new URL(rawUrl);
    return url.host === ANTHROPIC_TOKEN_HOST;
  } catch {
    return rawUrl.includes(ANTHROPIC_TOKEN_HOST);
  }
}

async function postAnthropicTokenViaNode(body: string): Promise<Response> {
  let output: string;
  try {
    output = await tokenNodeRequest.runNodeTokenRequest({
      body,
      endpoint: ANTHROPIC_REFRESH_ENDPOINT,
      executable: REFRESH_NODE_EXECUTABLE,
      timeoutMs: TOKEN_REFRESH_TIMEOUT_MS,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw buildRefreshRequestError(details);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw buildRefreshInvalidJsonError(output, details);
  }

  const result = parsed as { ok?: boolean; status?: number; body?: string; error?: string };
  if (!result.ok) {
    if (result.error) {
      throw buildRefreshRequestError(result.error);
    }

    throw buildRefreshRequestError(`Error: HTTP request failed. status=${result.status ?? 0}; url=${ANTHROPIC_REFRESH_ENDPOINT}; body=${result.body ?? ""}`);
  }

  return new Response(result.body ?? "", {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createAnthropicTokenProxyFetch(originalFetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (shouldProxyTokenRequest(input)) {
      const method = getRequestMethod(input, init).toUpperCase();
      if (method !== "POST") {
        throw buildRefreshRequestError(`Unsupported token endpoint method: ${method}`);
      }
      return await postAnthropicTokenViaNode(await getRequestBody(input, init));
    }

    if (shouldInjectAnthropicUserAgent(input)) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("user-agent", tokenProxyContext.getStore()!.userAgent!);
      return originalFetch(input, { ...init, headers });
    }

    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
}

function ensureAnthropicTokenProxyFetchInstalled(): void {
  if (tokenProxyInstalled) return;

  tokenProxyOriginalFetch = globalThis.fetch;
  globalThis.fetch = createAnthropicTokenProxyFetch(tokenProxyOriginalFetch);
  tokenProxyInstalled = true;
}

export async function withAnthropicTokenProxyFetch<T>(
  operation: () => Promise<T>,
  options?: { userAgent?: string },
): Promise<T> {
  ensureAnthropicTokenProxyFetchInstalled();
  return await tokenProxyContext.run({ proxyTokenRequests: true, userAgent: options?.userAgent }, operation);
}

export function resetAnthropicTokenProxyStateForTest(): void {
  tokenProxyInstalled = false;
  tokenProxyOriginalFetch = null;
}

async function fetchProfileWithSingleRetry(accessToken: string): Promise<Awaited<ReturnType<typeof fetchProfile>>> {
  let profileResult = await fetchProfile(accessToken);
  if (profileResult.ok) {
    return profileResult;
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));
  profileResult = await fetchProfile(accessToken);
  return profileResult;
}

export async function loginWithPiAi(
  callbacks: LoginWithPiAiCallbacks,
): Promise<Partial<StoredAccount>> {
  const piCreds = await withAnthropicTokenProxyFetch(
    () => piAiOauth.loginAnthropic({
      onAuth: callbacks.onAuth,
      onPrompt: callbacks.onPrompt,
      onProgress: callbacks.onProgress,
      onManualCodeInput: callbacks.onManualCodeInput,
    }),
    { userAgent: callbacks.userAgent },
  );

  const base = fromPiAiCredentials(piCreds);

  const profileResult = await fetchProfileWithSingleRetry(piCreds.access);
  const profileData = profileResult.ok ? profileResult.data : undefined;

  return {
    ...base,
    email: profileData?.email,
    planTier: profileData?.planTier ?? "",
    addedAt: Date.now(),
    lastUsed: Date.now(),
  };
}

export async function refreshWithPiAi(
  currentRefreshToken: string,
): Promise<CredentialRefreshPatch> {
  const piCreds = await withAnthropicTokenProxyFetch(() => piAiOauth.refreshAnthropicToken(currentRefreshToken));

  return {
    accessToken: piCreds.access,
    refreshToken: piCreds.refresh,
    expiresAt: piCreds.expires,
  };
}

export const PI_AI_ADAPTER_SERVICE = ANTHROPIC_OAUTH_ADAPTER.serviceLogName;
