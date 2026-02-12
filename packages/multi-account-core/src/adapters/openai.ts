import type { OAuthAdapter } from "./types";

const ISSUER = "https://auth.openai.com";

export const openAIOAuthAdapter: OAuthAdapter = {
  id: "openai",
  authProviderId: "openai",
  modelDisplayName: "ChatGPT",
  statusToolName: "chatgpt_multiauth_status",
  authMethodLabel: "ChatGPT Plus/Pro (Multi-Auth)",
  serviceLogName: "chatgpt-multiauth",
  oauthClientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  tokenEndpoint: `${ISSUER}/oauth/token`,
  usageEndpoint: "",
  profileEndpoint: "",
  oauthBetaHeader: "",
  requestBetaHeader: "",
  cliUserAgent: "opencode/1.1.53",
  toolPrefix: "mcp_",
  accountStorageFilename: "openai-multi-account-accounts.json",
  transform: {
    rewriteOpenCodeBranding: false,
    addToolPrefix: false,
    stripToolPrefixInResponse: false,
    enableMessagesBetaQuery: false,
  },
  planLabels: {
    pro: "ChatGPT Pro",
    plus: "ChatGPT Plus",
    go: "ChatGPT Go",
    free: "Free",
  },
  supported: true,
};
