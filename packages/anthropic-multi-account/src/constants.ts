import { anthropicOAuthAdapter } from "opencode-multi-account-core";

/** Anthropic OAuth adapter config */
export const ANTHROPIC_OAUTH_ADAPTER = anthropicOAuthAdapter;

/** Anthropic OAuth Client ID (same as builtin opencode-anthropic-auth) */
export const ANTHROPIC_CLIENT_ID = ANTHROPIC_OAUTH_ADAPTER.oauthClientId;

/** Token exchange / refresh endpoint */
export const ANTHROPIC_TOKEN_ENDPOINT =
  ANTHROPIC_OAUTH_ADAPTER.tokenEndpoint;

/** OAuth usage stats endpoint */
export const ANTHROPIC_USAGE_ENDPOINT =
  ANTHROPIC_OAUTH_ADAPTER.usageEndpoint;

/** OAuth profile endpoint for email/plan info */
export const ANTHROPIC_PROFILE_ENDPOINT = ANTHROPIC_OAUTH_ADAPTER.profileEndpoint;

/** Required beta header for OAuth requests */
export const ANTHROPIC_BETA_HEADER =
  ANTHROPIC_OAUTH_ADAPTER.requestBetaHeader;

/** User-Agent header to mimic Claude CLI */
export const CLAUDE_CLI_USER_AGENT = ANTHROPIC_OAUTH_ADAPTER.cliUserAgent;

/** Tool name prefix required by Anthropic servers */
export const TOOL_PREFIX = ANTHROPIC_OAUTH_ADAPTER.toolPrefix;

/** Account storage filename */
export const ACCOUNTS_FILENAME = ANTHROPIC_OAUTH_ADAPTER.accountStorageFilename;

/** Plan display labels derived from adapter */
export const PLAN_LABELS = ANTHROPIC_OAUTH_ADAPTER.planLabels;

/** Access token expiry buffer (refresh 60s before expiry) */
export const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/** Maximum time to wait for a token refresh HTTP request */
export const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
