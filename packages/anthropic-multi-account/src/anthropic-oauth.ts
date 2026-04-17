import { exec } from "node:child_process";
import * as v from "valibot";
import { TOKEN_REFRESH_TIMEOUT_MS } from "./constants";
import { loadCCDerivedAuthProfile } from "./cc-derived-profile";
import { detectOAuthConfig } from "./oauth-config-detect";
import { startCallbackServer } from "./oauth-callback-server";
import { generatePKCE, generateState } from "./oauth-pkce";
import { runNodeTokenRequest } from "./token-node-request";
import { fetchProfile, fetchUsage } from "./usage";
import {
  TokenResponseSchema,
  type CredentialRefreshPatch,
  type StoredAccount,
  type TokenResponse,
} from "./types";

const TOKEN_REQUEST_EXECUTABLE = process.env.OPENCODE_REFRESH_NODE_EXECUTABLE || "node";

type BrowserExec = (command: string, callback?: (error: Error | null) => void) => void;

let browserExec: BrowserExec = (command, callback) => {
  exec(command, callback);
};

let callbackServerStarter: typeof startCallbackServer = startCallbackServer;
let profileFetcher: typeof fetchProfile = fetchProfile;
let usageFetcher: typeof fetchUsage = fetchUsage;

interface NodeTokenEnvelope {
  ok?: boolean;
  status?: number;
  body?: string;
  error?: string;
}

export interface LoginCallbacks {
  onAuth(info: { url: string; instructions?: string }): void;
  onProgress?(msg: string): void;
}

export type LoginResult = Partial<StoredAccount>;

export class TokenExchangeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenExchangeError";
  }
}

export class TokenRefreshError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenRefreshError";
  }
}

function buildTokenRequestError(url: string, details: string): Error {
  return new Error(`Anthropic token request failed. url=${url}; details=${details}`);
}

function buildTokenInvalidJsonError(url: string, body: string, details: string): Error {
  return new Error(`Anthropic token request returned invalid JSON. url=${url}; body=${body}; details=${details}`);
}

function parseNodeTokenEnvelope(output: string, endpoint: string): NodeTokenEnvelope {
  try {
    return JSON.parse(output) as NodeTokenEnvelope;
  } catch (error) {
    const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw buildTokenInvalidJsonError(endpoint, output, details);
  }
}

function parseTokenResponseBody(body: string, endpoint: string): TokenResponse {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw buildTokenInvalidJsonError(endpoint, body, details);
  }

  return v.parse(TokenResponseSchema, parsed);
}

function getOpenBrowserCommand(url: string, platform = process.platform): string {
  if (platform === "win32") {
    return `start "" ${JSON.stringify(url)}`;
  }

  if (platform === "darwin") {
    return `open ${JSON.stringify(url)}`;
  }

  return `xdg-open ${JSON.stringify(url)}`;
}

function openBrowser(url: string): void {
  try {
    browserExec(getOpenBrowserCommand(url), () => {});
  } catch {
    // best-effort
  }
}

async function postTokenEndpoint(
  contentType: string,
  body: string,
  timeoutMs = TOKEN_REFRESH_TIMEOUT_MS,
  userAgent?: string,
): Promise<TokenResponse> {
  const derivedProfile = await loadCCDerivedAuthProfile();
  const oauthConfig = derivedProfile.oauthConfig;
  const endpoint = oauthConfig.tokenUrl;
  const resolvedUserAgent = userAgent ?? derivedProfile.userAgent;

  let output: string;
  try {
    output = await runNodeTokenRequest({
      body,
      contentType,
      endpoint,
      executable: TOKEN_REQUEST_EXECUTABLE,
      timeoutMs,
      userAgent: resolvedUserAgent,
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw buildTokenRequestError(endpoint, details);
  }

  const result = parseNodeTokenEnvelope(output, endpoint);
  if (result.ok) {
    return parseTokenResponseBody(result.body ?? "", endpoint);
  }

  if (result.error) {
    throw buildTokenRequestError(endpoint, result.error);
  }

  throw buildTokenRequestError(
    endpoint,
    `Error: HTTP request failed. status=${result.status ?? 0}; url=${endpoint}; body=${result.body ?? ""}`,
  );
}

const CODE_EXCHANGE_TIMEOUT_MS = 30_000;

async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const derivedProfile = await loadCCDerivedAuthProfile();
  const oauthConfig = derivedProfile.oauthConfig;

  const body = JSON.stringify({
    grant_type: "authorization_code",
    client_id: oauthConfig.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    state: params.state,
  });

  return postTokenEndpoint("application/json", body, CODE_EXCHANGE_TIMEOUT_MS);
}

export async function loginWithOAuth(callbacks: LoginCallbacks): Promise<Partial<StoredAccount>> {
  const { oauthConfig: cfg } = await loadCCDerivedAuthProfile();
  const { verifier: codeVerifier, challenge: codeChallenge } = generatePKCE();
  const state = generateState();
  const { port, waitForCode, stop } = await callbackServerStarter({ expectedState: state });
  const redirectUri = `http://localhost:${port}/callback`;

  try {
    const authorizeUrl = `${cfg.authorizeUrl}?${new URLSearchParams({
      code: "true",
      client_id: cfg.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: cfg.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    }).toString()}`;

    callbacks.onAuth({
      url: authorizeUrl,
      instructions: "Complete authorization in your browser.",
    });

    openBrowser(authorizeUrl);
    callbacks.onProgress?.("Waiting for browser authorization...");

    const { code } = await waitForCode;

    callbacks.onProgress?.("Exchanging authorization code...");
    const tokens = await exchangeCodeForTokens({
      code,
      codeVerifier,
      state,
      redirectUri,
    });

    callbacks.onProgress?.("Fetching profile...");
    const profileResult = await profileFetcher(tokens.access_token);
    try {
      await usageFetcher(tokens.access_token);
    } catch {
      // best-effort
    }
    const profileData = profileResult.ok ? profileResult.data : undefined;
    const now = Date.now();

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: now + tokens.expires_in * 1000,
      email: profileData?.email,
      planTier: profileData?.planTier ?? "",
      addedAt: now,
      lastUsed: now,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

const REFRESH_TIMEOUT_MS = 15_000;

export async function refreshWithOAuth(currentRefreshToken: string): Promise<CredentialRefreshPatch> {
  const { oauthConfig } = await loadCCDerivedAuthProfile();

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: currentRefreshToken,
    client_id: oauthConfig.clientId,
  }).toString();

  const response = await postTokenEndpoint(
    "application/x-www-form-urlencoded",
    body,
    REFRESH_TIMEOUT_MS,
  );

  const patch: CredentialRefreshPatch = {
    accessToken: response.access_token,
    expiresAt: Date.now() + response.expires_in * 1000,
  };

  if (response.refresh_token) {
    patch.refreshToken = response.refresh_token;
  }

  if (response.account?.uuid) {
    patch.uuid = response.account.uuid;
  }

  if (response.account?.email_address) {
    patch.email = response.account.email_address;
  }

  return patch;
}

export { detectOAuthConfig };

export const anthropicOAuthTestExports = {
  getOpenBrowserCommand,
  postTokenEndpoint,
  exchangeCodeForTokens,
  loginWithOAuth,
  openBrowser,
  setCallbackServerStarterForTest(next: typeof startCallbackServer | null): void {
    callbackServerStarter = next ?? startCallbackServer;
  },
  setProfileFetcherForTest(next: typeof fetchProfile | null): void {
    profileFetcher = next ?? fetchProfile;
  },
  setUsageFetcherForTest(next: typeof fetchUsage | null): void {
    usageFetcher = next ?? fetchUsage;
  },
  setBrowserExecForTest(next: BrowserExec | null): void {
    browserExec = next ?? ((command, callback) => {
      exec(command, callback);
    });
  },
};
