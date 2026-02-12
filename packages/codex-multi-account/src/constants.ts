import { openAIOAuthAdapter } from "opencode-oauth-adapters";

/** OpenAI OAuth adapter config */
export const OPENAI_OAUTH_ADAPTER = openAIOAuthAdapter;

/** OpenAI OAuth Client ID */
export const OPENAI_CLIENT_ID = OPENAI_OAUTH_ADAPTER.oauthClientId;

/** Token exchange / refresh endpoint */
export const OPENAI_TOKEN_ENDPOINT = OPENAI_OAUTH_ADAPTER.tokenEndpoint;

/** OAuth usage stats endpoint */
export const OPENAI_USAGE_ENDPOINT = OPENAI_OAUTH_ADAPTER.usageEndpoint;

/** OAuth profile endpoint */
export const OPENAI_PROFILE_ENDPOINT = OPENAI_OAUTH_ADAPTER.profileEndpoint;

/** Codex upstream endpoint used by OpenCode */
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/** Codex usage/quota endpoint (WHAM API) */
export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

/** OpenAI OAuth issuer */
export const OAUTH_ISSUER = "https://auth.openai.com";

/** Local callback port for browser OAuth */
export const OAUTH_PORT = 1455;

/** Required beta header for OAuth requests */
export const OPENAI_BETA_HEADER = OPENAI_OAUTH_ADAPTER.requestBetaHeader;

/** User-Agent header */
export const OPENAI_CLI_USER_AGENT = OPENAI_OAUTH_ADAPTER.cliUserAgent;

/** Tool name prefix */
export const TOOL_PREFIX = OPENAI_OAUTH_ADAPTER.toolPrefix;

/** Account storage filename */
export const ACCOUNTS_FILENAME = OPENAI_OAUTH_ADAPTER.accountStorageFilename;

/** Plan display labels derived from adapter */
export const PLAN_LABELS = OPENAI_OAUTH_ADAPTER.planLabels;

/** Access token expiry buffer (refresh 60s before expiry) */
export const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/** Maximum time to wait for a token refresh HTTP request */
export const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
