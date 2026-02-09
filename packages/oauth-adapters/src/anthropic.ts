import type { OAuthAdapter } from "./types";

export const anthropicOAuthAdapter: OAuthAdapter = {
  id: "anthropic",
  authProviderId: "anthropic",
  modelDisplayName: "Claude",
  statusToolName: "claude_multiauth_status",
  authMethodLabel: "Claude Pro/Max (Multi-Auth)",
  serviceLogName: "claude-multiauth",
  oauthClientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  tokenEndpoint: "https://console.anthropic.com/v1/oauth/token",
  usageEndpoint: "https://api.anthropic.com/api/oauth/usage",
  profileEndpoint: "https://api.anthropic.com/api/oauth/profile",
  oauthBetaHeader: "oauth-2025-04-20",
  requestBetaHeader: "oauth-2025-04-20,interleaved-thinking-2025-05-14",
  cliUserAgent: "claude-cli/2.1.2 (external, cli)",
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
