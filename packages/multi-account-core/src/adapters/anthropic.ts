import type { OAuthAdapter } from "./types";

export const ANTHROPIC_DEFAULT_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_DEFAULT_CLI_VERSION = "2.1.80";
export const ANTHROPIC_DEFAULT_USER_AGENT = "claude-cli/2.1.2 (external, cli)";
export const ANTHROPIC_DEFAULT_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_DEFAULT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const ANTHROPIC_DEFAULT_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const ANTHROPIC_DEFAULT_SCOPES = "org:create_api_key user:profile user:inference";
export const ANTHROPIC_DEFAULT_BETA_FLAGS =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05";

export interface AnthropicOAuthEnvConfig {
  clientId: string;
  cliVersion: string;
  userAgent: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string;
  betaFlags: string;
}

type AnthropicEnv = Partial<Record<string, string | undefined>>;

function buildCliUserAgent(cliVersion: string): string {
  return `claude-cli/${cliVersion} (external, cli)`;
}

export function resolveAnthropicOAuthEnv(env: AnthropicEnv = process.env): AnthropicOAuthEnvConfig {
  const cliVersion = env.ANTHROPIC_CLI_VERSION || ANTHROPIC_DEFAULT_CLI_VERSION;
  const composedUserAgent = buildCliUserAgent(cliVersion);
  const userAgent =
    env.ANTHROPIC_USER_AGENT ||
    (env.ANTHROPIC_CLI_VERSION ? composedUserAgent : "") ||
    ANTHROPIC_DEFAULT_USER_AGENT;

  return {
    clientId: env.ANTHROPIC_CLIENT_ID || ANTHROPIC_DEFAULT_CLIENT_ID,
    cliVersion,
    userAgent,
    authorizeUrl: env.ANTHROPIC_AUTHORIZE_URL || ANTHROPIC_DEFAULT_AUTHORIZE_URL,
    tokenUrl: env.ANTHROPIC_TOKEN_URL || ANTHROPIC_DEFAULT_TOKEN_URL,
    redirectUri: env.ANTHROPIC_REDIRECT_URI || ANTHROPIC_DEFAULT_REDIRECT_URI,
    scopes: env.ANTHROPIC_SCOPES || ANTHROPIC_DEFAULT_SCOPES,
    betaFlags: env.ANTHROPIC_BETA_FLAGS || ANTHROPIC_DEFAULT_BETA_FLAGS,
  };
}

const anthropicEnv = resolveAnthropicOAuthEnv();

export const anthropicOAuthAdapter: OAuthAdapter = {
  id: "anthropic",
  authProviderId: "anthropic",
  modelDisplayName: "Claude",
  statusToolName: "claude_multiauth_status",
  authMethodLabel: "Claude Pro/Max (Multi-Auth)",
  serviceLogName: "claude-multiauth",
  oauthClientId: anthropicEnv.clientId,
  tokenEndpoint: anthropicEnv.tokenUrl,
  usageEndpoint: "https://api.anthropic.com/api/oauth/usage",
  profileEndpoint: "https://api.anthropic.com/api/oauth/profile",
  oauthBetaHeader: "oauth-2025-04-20",
  requestBetaHeader: anthropicEnv.betaFlags,
  cliUserAgent: anthropicEnv.userAgent,
  cliVersion: anthropicEnv.cliVersion,
  billingSalt: "59cf53e54c78",
  toolPrefix: "mcp_",
  accountStorageFilename: "anthropic-multi-account-accounts.json",
  transform: {
    rewriteOpenCodeBranding: true,
    addToolPrefix: true,
    stripToolPrefixInResponse: true,
    enableMessagesBetaQuery: true,
  },
  planLabels: {
    max: "Claude Max",
    pro: "Claude Pro",
    free: "Free",
  },
  supported: true,
};
