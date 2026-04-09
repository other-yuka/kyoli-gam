import { anthropicOAuthAdapter } from "opencode-multi-account-core";

export const ANTHROPIC_OAUTH_ADAPTER = anthropicOAuthAdapter;

export const ANTHROPIC_CLIENT_ID = ANTHROPIC_OAUTH_ADAPTER.oauthClientId;
export const ANTHROPIC_TOKEN_ENDPOINT = ANTHROPIC_OAUTH_ADAPTER.tokenEndpoint;
export const ANTHROPIC_USAGE_ENDPOINT = ANTHROPIC_OAUTH_ADAPTER.usageEndpoint;
export const ANTHROPIC_PROFILE_ENDPOINT = ANTHROPIC_OAUTH_ADAPTER.profileEndpoint;
export const ANTHROPIC_BETA_HEADER = ANTHROPIC_OAUTH_ADAPTER.requestBetaHeader;
export const CLAUDE_CLI_USER_AGENT = ANTHROPIC_OAUTH_ADAPTER.cliUserAgent;

/** Tool name prefix required by Anthropic servers */
export const TOOL_PREFIX = ANTHROPIC_OAUTH_ADAPTER.toolPrefix;

export const ACCOUNTS_FILENAME = ANTHROPIC_OAUTH_ADAPTER.accountStorageFilename;
export const CLAIMS_FILENAME = "anthropic-multi-account-claims.json";
export const PLAN_LABELS = ANTHROPIC_OAUTH_ADAPTER.planLabels;

export const TOKEN_EXPIRY_BUFFER_MS = 60_000;
export const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
