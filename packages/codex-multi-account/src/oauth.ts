import * as v from "valibot";
import {
  OPENAI_CLIENT_ID,
  OAUTH_ISSUER,
  OAUTH_PORT,
} from "./constants";
import { TokenResponseSchema } from "./types";
import type { TokenResponse } from "./types";

const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

type PKCE = { verifier: string; challenge: string };

type OAuthCallbackQuery = {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
};

interface BunServerLike {
  stop(closeActiveConnections?: boolean): void;
}

interface BunRuntimeLike {
  serve(options: {
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }): BunServerLike;
}

let oauthServer: BunServerLike | null = null;
let resolveOAuthQuery: ((value: OAuthCallbackQuery) => void) | null = null;
let rejectOAuthQuery: ((reason?: unknown) => void) | null = null;

function getBunRuntime(): BunRuntimeLike {
  const maybeBun = (globalThis as unknown as { Bun?: BunRuntimeLike }).Bun;
  if (!maybeBun || typeof maybeBun.serve !== "function") {
    throw new Error("Browser OAuth requires Bun runtime");
  }
  return maybeBun;
}

function getRedirectUri(port: number = OAUTH_PORT): string {
  return `http://localhost:${port}/auth/callback`;
}

function renderHtml(title: string, body: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0f1115;
        color: #f5f7ff;
        font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(520px, calc(100vw - 32px));
        border: 1px solid #2a3040;
        border-radius: 12px;
        padding: 24px;
        background: #171b25;
      }
      h1 { margin: 0 0 8px 0; font-size: 22px; }
      p { margin: 0; color: #c4cadb; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${body}</p>
    </main>
  </body>
</html>`;
}

function renderSuccessHtml(): string {
  return renderHtml("Authentication Complete", "You can close this tab and return to OpenCode.");
}

function renderErrorHtml(message: string): string {
  return renderHtml("Authentication Failed", message);
}

function completeOAuthQuery(query: OAuthCallbackQuery): void {
  if (resolveOAuthQuery) {
    resolveOAuthQuery(query);
  }
  resolveOAuthQuery = null;
  rejectOAuthQuery = null;
}

function failOAuthQuery(reason: unknown): void {
  if (rejectOAuthQuery) {
    rejectOAuthQuery(reason);
  }
  resolveOAuthQuery = null;
  rejectOAuthQuery = null;
}

function tokenEndpoint(): string {
  return `${OAUTH_ISSUER}/oauth/token`;
}

function parseTokenResponse(json: unknown): TokenResponse {
  return v.parse(TokenResponseSchema, json);
}

async function postTokenForm(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await response.json().catch(() => ({} as Record<string, unknown>));

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status}`);
  }

  return parseTokenResponse(payload);
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = generateRandomString(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(digest);
  return { verifier, challenge };
}

function generateRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function generateRandomString(length: number): string {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = generateRandomBytes(length);
  let out = "";

  for (const value of bytes) {
    out += charset[value % charset.length];
  }

  return out;
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generateState(): string {
  const bytes = generateRandomBytes(32);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return base64UrlEncode(buffer);
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PKCE,
): Promise<TokenResponse> {
  return postTokenForm(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: OPENAI_CLIENT_ID,
    code_verifier: pkce.verifier,
  }));
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return postTokenForm(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OPENAI_CLIENT_ID,
  }));
}

export interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return atob(padded);
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  try {
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) return undefined;
    const json = base64UrlDecode(parts[1]);
    return JSON.parse(json) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

function findAccountId(claims: IdTokenClaims | undefined): string | undefined {
  if (!claims) return undefined;
  if (claims.chatgpt_account_id) return claims.chatgpt_account_id;
  if (claims["https://api.openai.com/auth"]?.chatgpt_account_id) {
    return claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  }
  if (Array.isArray(claims.organizations) && claims.organizations[0]?.id) {
    return claims.organizations[0].id;
  }
  return undefined;
}

export function extractAccountId(tokens: { id_token?: string; access_token: string }): string | undefined {
  const fromIdToken = findAccountId(parseJwtClaims(tokens.id_token ?? ""));
  if (fromIdToken) return fromIdToken;
  return findAccountId(parseJwtClaims(tokens.access_token));
}

export async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: getRedirectUri() };
  }

  const bun = getBunRuntime();
  oauthServer = bun.serve({
    port: OAUTH_PORT,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/cancel") {
        failOAuthQuery(new Error("Authentication cancelled by user"));
        return new Response(renderErrorHtml("Authentication was cancelled."), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
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
        return new Response(renderErrorHtml(errorDescription ?? error), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (!code) {
        failOAuthQuery(new Error("Missing authorization code"));
        return new Response(renderErrorHtml("Missing authorization code."), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      completeOAuthQuery({ code, state });
      return new Response(renderSuccessHtml(), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });

  return { port: OAUTH_PORT, redirectUri: getRedirectUri() };
}

export function stopOAuthServer(): void {
  if (oauthServer) {
    oauthServer.stop(true);
  }
  oauthServer = null;
  failOAuthQuery(new Error("OAuth server stopped"));
}

export function waitForOAuthCallback(pkce: PKCE, state: string): Promise<TokenResponse> {
  return new Promise<TokenResponse>(async (resolve, reject) => {
    try {
      const { redirectUri } = await startOAuthServer();

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

          const tokens = await exchangeCodeForTokens(query.code, redirectUri, pkce);
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
    } catch (error) {
      reject(error);
    }
  });
}

export function buildAuthorizeUrl(
  redirectUri: string,
  pkce: { challenge: string },
  state: string,
): string {
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
  url.searchParams.set("originator", "opencode");
  return url.toString();
}
