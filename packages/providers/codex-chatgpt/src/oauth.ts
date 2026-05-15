import { createServer, type Server } from "node:http";

const OAUTH_ISSUER = "https://auth.openai.com";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_PORT = 1455;
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface CodexOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
  planTier?: string;
}

type PKCE = { verifier: string; challenge: string };

type OAuthCallbackQuery = {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
};

interface OAuthServerLike {
  stop(closeActiveConnections?: boolean): void;
}

let oauthServer: OAuthServerLike | null = null;
let resolveOAuthQuery: ((value: OAuthCallbackQuery) => void) | null = null;
let rejectOAuthQuery: ((reason?: unknown) => void) | null = null;

export async function startCodexOAuthLogin(): Promise<{
  authorizeUrl: string;
  waitForTokens: Promise<CodexOAuthTokens>;
  stop: () => void;
}> {
  const pkce = await generatePKCE();
  const state = generateState();
  const { redirectUri } = await startOAuthServer();
  const authorizeUrl = buildAuthorizeUrl(redirectUri, pkce, state);

  return {
    authorizeUrl,
    waitForTokens: waitForOAuthCallback(pkce, state),
    stop: stopOAuthServer,
  };
}

async function startOAuthServer(): Promise<{ redirectUri: string }> {
  if (oauthServer) {
    return { redirectUri: getRedirectUri() };
  }

  const server = createServer(async (request, response) => {
    const result = handleOAuthRequest(`http://localhost:${OAUTH_PORT}${request.url ?? "/"}`);
    response.statusCode = result.status;
    for (const [key, value] of result.headers) response.setHeader(key, value);
    response.end(await result.text());
  });
  await listen(server, OAUTH_PORT);
  oauthServer = {
    stop(closeActiveConnections = false) {
      if (closeActiveConnections) server.closeAllConnections();
      server.close();
    },
  };

  return { redirectUri: getRedirectUri() };
}

function handleOAuthRequest(requestUrl: string): Response {
  const url = new URL(requestUrl);

  if (url.pathname === "/cancel") {
    failOAuthQuery(new Error("Authentication cancelled by user"));
    return htmlResponse("Authentication Cancelled", "You can close this tab.");
  }

  if (url.pathname !== "/auth/callback") {
    return new Response("Not Found", { status: 404 });
  }

  const error = url.searchParams.get("error") ?? undefined;
  const errorDescription = url.searchParams.get("error_description") ?? undefined;
  const code = url.searchParams.get("code") ?? undefined;
  const state = url.searchParams.get("state") ?? undefined;

  if (error) {
    failOAuthQuery(new Error(errorDescription ?? error));
    return htmlResponse("Authentication Failed", errorDescription ?? error, 400);
  }

  if (!code) {
    failOAuthQuery(new Error("Missing authorization code"));
    return htmlResponse("Authentication Failed", "Missing authorization code.", 400);
  }

  completeOAuthQuery({ code, state });
  return htmlResponse("Authentication Complete", "You can close this tab and return to kyoli.");
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
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
    server.listen(port, "127.0.0.1");
  });
}

function waitForOAuthCallback(pkce: PKCE, state: string): Promise<CodexOAuthTokens> {
  return new Promise<CodexOAuthTokens>((resolve, reject) => {
    if (resolveOAuthQuery || rejectOAuthQuery) {
      reject(new Error("OAuth callback wait already active"));
      return;
    }

    const timeout = setTimeout(() => {
      failOAuthQuery(new Error("OAuth callback timed out"));
    }, OAUTH_CALLBACK_TIMEOUT_MS);

    resolveOAuthQuery = async (query) => {
      clearTimeout(timeout);

      try {
        if (!query.code) {
          reject(new Error("Missing OAuth authorization code"));
          return;
        }

        if (!query.state || query.state !== state) {
          reject(new Error("OAuth state mismatch"));
          return;
        }

        const tokens = await exchangeCodeForTokens(query.code, getRedirectUri(), pkce);
        resolve(tokens);
      } catch (error) {
        reject(error);
      } finally {
        resolveOAuthQuery = null;
        rejectOAuthQuery = null;
      }
    };

    rejectOAuthQuery = (reason) => {
      clearTimeout(timeout);
      reject(reason);
    };
  });
}

function stopOAuthServer(): void {
  if (oauthServer) {
    oauthServer.stop(true);
  }
  oauthServer = null;
  failOAuthQuery(new Error("OAuth server stopped"));
}

function completeOAuthQuery(query: OAuthCallbackQuery): void {
  resolveOAuthQuery?.(query);
  resolveOAuthQuery = null;
  rejectOAuthQuery = null;
}

function failOAuthQuery(reason: unknown): void {
  rejectOAuthQuery?.(reason);
  resolveOAuthQuery = null;
  rejectOAuthQuery = null;
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PKCE,
): Promise<CodexOAuthTokens> {
  const startedAt = Date.now();
  const response = await fetch(`${OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_CLIENT_ID,
      code_verifier: pkce.verifier,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Token request failed with ${response.status}`);
  }

  const accessToken = readString(payload.access_token);
  const expiresIn = readNumber(payload.expires_in);
  if (!accessToken || !expiresIn) {
    throw new Error("Token response is missing access_token or expires_in.");
  }

  return {
    accessToken,
    refreshToken: readString(payload.refresh_token),
    expiresAt: startedAt + expiresIn * 1000,
    accountId: extractAccountId(payload),
    email: extractEmail(payload),
    planTier: extractPlanTier(payload),
  };
}

function buildAuthorizeUrl(redirectUri: string, pkce: PKCE, state: string): string {
  const url = new URL(`${OAUTH_ISSUER}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

function getRedirectUri(): string {
  return `http://localhost:${OAUTH_PORT}/auth/callback`;
}

async function generatePKCE(): Promise<PKCE> {
  const verifier = generateRandomString(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(digest) };
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

function generateRandomString(length: number): string {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const value of bytes) {
    out += charset[value % charset.length];
  }
  return out;
}

function htmlResponse(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

function extractAccountId(payload: Record<string, unknown>): string | undefined {
  const idToken = readString(payload.id_token);
  const accessToken = readString(payload.access_token);
  return findAccountId(parseJwtClaims(idToken)) ?? findAccountId(parseJwtClaims(accessToken));
}

function extractEmail(payload: Record<string, unknown>): string | undefined {
  const idToken = readString(payload.id_token);
  return parseJwtClaims(idToken)?.email;
}

function extractPlanTier(payload: Record<string, unknown>): string | undefined {
  const idToken = readString(payload.id_token);
  const accessToken = readString(payload.access_token);
  return normalizePlanTier(
    findPlanTier(parseJwtClaims(idToken)) ?? findPlanTier(parseJwtClaims(accessToken)),
  );
}

interface IdTokenClaims {
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  email?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
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

function findPlanTier(claims: IdTokenClaims | undefined): string | undefined {
  if (!claims) return undefined;
  return claims["https://api.openai.com/auth"]?.chatgpt_plan_type ?? claims.chatgpt_plan_type;
}

function normalizePlanTier(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned.toLowerCase() : undefined;
}

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return atob(padded);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
