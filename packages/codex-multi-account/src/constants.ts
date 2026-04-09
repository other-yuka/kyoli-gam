import { openAIOAuthAdapter } from "opencode-multi-account-core";

export const OPENAI_OAUTH_ADAPTER = openAIOAuthAdapter;

export const OPENAI_CLIENT_ID = OPENAI_OAUTH_ADAPTER.oauthClientId;
export const OPENAI_TOKEN_ENDPOINT = OPENAI_OAUTH_ADAPTER.tokenEndpoint;
export const OPENAI_USAGE_ENDPOINT = OPENAI_OAUTH_ADAPTER.usageEndpoint;
export const OPENAI_PROFILE_ENDPOINT = OPENAI_OAUTH_ADAPTER.profileEndpoint;

export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

export const OAUTH_ISSUER = "https://auth.openai.com";
export const OAUTH_PORT = 1455;

export const OPENAI_BETA_HEADER = OPENAI_OAUTH_ADAPTER.requestBetaHeader;
export const OPENAI_CLI_USER_AGENT = OPENAI_OAUTH_ADAPTER.cliUserAgent;
export const TOOL_PREFIX = OPENAI_OAUTH_ADAPTER.toolPrefix;

export const ACCOUNTS_FILENAME = OPENAI_OAUTH_ADAPTER.accountStorageFilename;
export const CLAIMS_FILENAME = "openai-multi-account-claims.json";

export const PLAN_LABELS = OPENAI_OAUTH_ADAPTER.planLabels;

export const TOKEN_EXPIRY_BUFFER_MS = 60_000;
export const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
