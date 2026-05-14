import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { detectClaudeCodeOAuthConfig } from "./oauth-config";
import type { ClaudeCodeOAuthConfig } from "./oauth-config";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_BETA_HEADER = "oauth-2025-04-20";
const SUCCESS_REDIRECT_URL =
  "https://platform.claude.com/oauth/code/success?app=claude-code";

export interface ClaudeCodeOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
  planTier?: string;
  cachedUsage?: ClaudeCodeUsageLimits;
  cachedUsageAt?: number;
  oauthConfigSource?: ClaudeCodeOAuthConfig["source"];
}

export interface ClaudeCodeUsageLimits {
  five_hour?: ClaudeCodeUsageLimit | null;
  seven_day?: ClaudeCodeUsageLimit | null;
  [key: `seven_day_${string}`]: ClaudeCodeUsageLimit | null | undefined;
}

export interface ClaudeCodeUsageLimit {
  utilization: number;
  resets_at: string | null;
}

export interface ClaudeCodeTokenRefreshResult {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  accountId?: string;
  email?: string;
}

interface TokenEndpointResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  account?: {
    uuid?: unknown;
    email_address?: unknown;
  };
}

interface ClaudeProfileResponse {
  account?: {
    email?: unknown;
    has_claude_pro?: unknown;
    has_claude_max?: unknown;
  };
}

interface CallbackServer {
  port: number;
  waitForCode: Promise<{ code: string; state: string }>;
  stop: () => void;
}

interface TokenRequestOptions {
  config?: ClaudeCodeOAuthConfig;
  fetch?: typeof fetch;
}

export interface ClaudeCodeAccountMetadataRefresh {
  email?: string;
  planTier?: string;
  cachedUsage?: ClaudeCodeUsageLimits;
  cachedUsageAt?: number;
}

export async function startClaudeCodeOAuthLogin(): Promise<{
  authorizeUrl: string;
  waitForTokens: Promise<ClaudeCodeOAuthTokens>;
  stop: () => void;
  oauthConfig: ClaudeCodeOAuthConfig;
}> {
  const oauthConfig = await detectClaudeCodeOAuthConfig();
  const pkce = generatePKCE();
  const state = generateState();
  const callback = await startCallbackServer(state);
  const redirectUri = `http://localhost:${callback.port}/callback`;
  const authorizeUrl = buildAuthorizeUrl(oauthConfig, redirectUri, pkce.challenge, state);

  return {
    authorizeUrl,
    waitForTokens: waitForTokens({
      callback,
      codeVerifier: pkce.verifier,
      oauthConfig,
      redirectUri,
      state,
    }),
    stop: callback.stop,
    oauthConfig,
  };
}

export async function refreshClaudeCodeOAuthToken(
  refreshToken: string,
  options: TokenRequestOptions = {},
): Promise<ClaudeCodeTokenRefreshResult> {
  const oauthConfig = options.config ?? await detectClaudeCodeOAuthConfig();
  const startedAt = Date.now();
  const payload = await postTokenEndpoint(
    oauthConfig,
    "application/x-www-form-urlencoded",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: oauthConfig.clientId,
    }).toString(),
    options.fetch,
  );

  return normalizeTokenResponse(payload, startedAt);
}

export async function refreshClaudeCodeAccountMetadata(
  accessToken: string,
  options: { fetch?: typeof fetch } = {},
): Promise<ClaudeCodeAccountMetadataRefresh> {
  const fetchImpl = options.fetch ?? fetch;
  const [profile, usage] = await Promise.all([
    fetchProfile(accessToken, fetchImpl).catch(() => undefined),
    fetchUsage(accessToken, fetchImpl).catch(() => undefined),
  ]);

  return {
    email: profile?.email,
    planTier: profile?.planTier,
    cachedUsage: usage,
    cachedUsageAt: usage ? Date.now() : undefined,
  };
}

async function waitForTokens(input: {
  callback: CallbackServer;
  codeVerifier: string;
  oauthConfig: ClaudeCodeOAuthConfig;
  redirectUri: string;
  state: string;
}): Promise<ClaudeCodeOAuthTokens> {
  try {
    const { code, state } = await input.callback.waitForCode;
    if (state !== input.state) {
      throw new Error("Claude Code OAuth state mismatch");
    }

    const startedAt = Date.now();
    const payload = await postTokenEndpoint(
      input.oauthConfig,
      "application/json",
      JSON.stringify({
        grant_type: "authorization_code",
        client_id: input.oauthConfig.clientId,
        code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
        state,
      }),
    );
    const tokens = normalizeTokenResponse(payload, startedAt);
    const metadata = await refreshClaudeCodeAccountMetadata(tokens.accessToken);

    return {
      ...tokens,
      email: tokens.email ?? metadata.email,
      planTier: metadata.planTier,
      cachedUsage: metadata.cachedUsage,
      cachedUsageAt: metadata.cachedUsageAt,
      oauthConfigSource: input.oauthConfig.source,
    };
  } finally {
    input.callback.stop();
  }
}

function buildAuthorizeUrl(
  config: ClaudeCodeOAuthConfig,
  redirectUri: string,
  codeChallenge: string,
  state: string,
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

async function postTokenEndpoint(
  config: ClaudeCodeOAuthConfig,
  contentType: string,
  body: BodyInit,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenEndpointResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REFRESH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(config.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": contentType,
        "user-agent": "claude-cli/1.0.0 (external, cli)",
      },
      body,
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as TokenEndpointResponse;
    if (!response.ok) {
      throw new Error(`Claude Code token request failed with ${response.status}`);
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchProfile(
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<{ email?: string; planTier: string }> {
  const response = await fetchImpl(PROFILE_ENDPOINT, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "anthropic-beta": PROFILE_BETA_HEADER,
    },
  });

  if (!response.ok) {
    throw new Error(`Claude profile request failed with ${response.status}`);
  }

  const payload = (await response.json()) as ClaudeProfileResponse;
  const account = payload.account;
  const planTier = account?.has_claude_max === true
    ? "max"
    : account?.has_claude_pro === true
      ? "pro"
      : "free";

  return {
    email: typeof account?.email === "string" ? account.email : undefined,
    planTier,
  };
}

async function fetchUsage(
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<ClaudeCodeUsageLimits> {
  const response = await fetchImpl(USAGE_ENDPOINT, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "anthropic-beta": PROFILE_BETA_HEADER,
    },
  });

  if (!response.ok) {
    throw new Error(`Claude usage request failed with ${response.status}`);
  }

  return normalizeUsageLimits(await response.json());
}

function normalizeTokenResponse(
  payload: TokenEndpointResponse,
  startedAt: number,
): ClaudeCodeTokenRefreshResult {
  const accessToken = readString(payload.access_token);
  const expiresIn = readNumber(payload.expires_in);
  if (!accessToken || !expiresIn) {
    throw new Error("Claude Code token response is missing access_token or expires_in.");
  }

  return {
    accessToken,
    expiresAt: startedAt + expiresIn * 1000,
    refreshToken: readString(payload.refresh_token),
    accountId: readString(payload.account?.uuid),
    email: readString(payload.account?.email_address),
  };
}

function normalizeUsageLimits(payload: unknown): ClaudeCodeUsageLimits {
  const record = readRecord(payload);
  if (!record) return {};

  const usage: ClaudeCodeUsageLimits = {
    five_hour: normalizeUsageLimit(record.five_hour),
    seven_day: normalizeUsageLimit(record.seven_day),
  };

  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith("seven_day_")) continue;
    usage[key as `seven_day_${string}`] = normalizeUsageLimit(value);
  }

  return usage;
}

function normalizeUsageLimit(value: unknown): ClaudeCodeUsageLimit | null {
  if (value === null || value === undefined) return null;
  const record = readRecord(value);
  if (!record) return null;

  const utilization = readNumber(record.utilization);
  if (utilization === undefined) return null;

  return {
    utilization,
    resets_at: typeof record.resets_at === "string" ? record.resets_at : null,
  };
}

function startCallbackServer(expectedState: string): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let resolveCode: ((value: { code: string; state: string }) => void) | undefined;
    let rejectCode: ((reason: Error) => void) | undefined;

    const waitForCode = new Promise<{ code: string; state: string }>((resolveWait, rejectWait) => {
      resolveCode = resolveWait;
      rejectCode = rejectWait;
    });

    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not Found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (state !== expectedState) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("State mismatch", () => stop(new Error("Claude Code OAuth state mismatch")));
        return;
      }

      if (!code) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("Missing code", () => stop(new Error("Claude Code OAuth callback missing code")));
        return;
      }

      response.writeHead(302, { location: SUCCESS_REDIRECT_URL });
      response.end(undefined, () => {
        if (!settled) {
          settled = true;
          resolveCode?.({ code, state });
          server.close();
        }
      });
    });

    function stop(error?: Error): void {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) rejectCode?.(error);
      server.close();
    }

    server.on("error", reject);
    server.listen(0, "localhost", () => {
      timeout = setTimeout(() => stop(new Error("Claude Code OAuth callback timed out")), CALLBACK_TIMEOUT_MS);
      resolve({
        port: (server.address() as AddressInfo).port,
        waitForCode,
        stop,
      });
    });
  });
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function generateState(): string {
  return base64Url(randomBytes(32));
}

function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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
