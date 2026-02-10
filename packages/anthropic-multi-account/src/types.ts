import * as v from "valibot";

// ─── Schemas (Single Source of Truth) ───────────────────────────

export const OAuthCredentialsSchema = v.object({
  type: v.literal("oauth"),
  refresh: v.string(),
  access: v.string(),
  expires: v.number(),
});

export const UsageLimitEntrySchema = v.object({
  utilization: v.number(),
  resets_at: v.nullable(v.string()),
});

export const UsageLimitsSchema = v.object({
  five_hour: v.optional(v.nullable(UsageLimitEntrySchema), null),
  seven_day: v.optional(v.nullable(UsageLimitEntrySchema), null),
  seven_day_sonnet: v.optional(v.nullable(UsageLimitEntrySchema), null),
});

export const CredentialRefreshPatchSchema = v.object({
  accessToken: v.string(),
  expiresAt: v.number(),
  refreshToken: v.optional(v.string()),
  uuid: v.optional(v.string()),
  email: v.optional(v.string()),
});

export const StoredAccountSchema = v.object({
  uuid: v.optional(v.string()),
  label: v.optional(v.string()),
  email: v.optional(v.string()),
  planTier: v.optional(v.string(), ""),
  refreshToken: v.string(),
  accessToken: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  addedAt: v.number(),
  lastUsed: v.number(),
  enabled: v.optional(v.boolean(), true),
  rateLimitResetAt: v.optional(v.number()),
  cachedUsage: v.optional(UsageLimitsSchema),
  cachedUsageAt: v.optional(v.number()),
  consecutiveAuthFailures: v.optional(v.number(), 0),
  isAuthDisabled: v.optional(v.boolean(), false),
  authDisabledReason: v.optional(v.string()),
});

export const AccountStorageSchema = v.object({
  version: v.literal(1),
  accounts: v.optional(v.array(StoredAccountSchema), []),
  activeAccountUuid: v.optional(v.string()),
});

/** Anthropic /v1/oauth/token response */
export const TokenResponseSchema = v.object({
  access_token: v.string(),
  refresh_token: v.optional(v.string()),
  expires_in: v.number(),
  account: v.optional(v.object({
    uuid: v.optional(v.string()),
    email_address: v.optional(v.string()),
  })),
});

// ─── Types (derived from schemas) ───────────────────────────────

export type OAuthCredentials = v.InferOutput<typeof OAuthCredentialsSchema>;
export type UsageLimitEntry = v.InferOutput<typeof UsageLimitEntrySchema>;
export type UsageLimits = v.InferOutput<typeof UsageLimitsSchema>;
export type CredentialRefreshPatch = v.InferOutput<typeof CredentialRefreshPatchSchema>;
export type StoredAccount = v.InferOutput<typeof StoredAccountSchema>;
export type AccountStorage = v.InferOutput<typeof AccountStorageSchema>;
export type TokenResponse = v.InferOutput<typeof TokenResponseSchema>;

// ─── Plugin Config Schema ────────────────────────────────────────

export const AccountSelectionStrategySchema = v.picklist(["sticky", "round-robin", "hybrid"]);
export type AccountSelectionStrategy = v.InferOutput<typeof AccountSelectionStrategySchema>;

export const PluginConfigSchema = v.object({
  /** sticky: same account until failure, round-robin: rotate every request, hybrid: health+usage scoring */
  account_selection_strategy: v.optional(AccountSelectionStrategySchema, "sticky"),

  /** Use cross-process claim file to distribute parallel sessions across accounts */
  cross_process_claims: v.optional(v.boolean(), true),
  /** Skip account when any usage tier utilization >= this % (100 = disabled) */
  soft_quota_threshold_percent: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100)), 100),
  /** Minimum backoff after rate limit (ms) */
  rate_limit_min_backoff_ms: v.optional(v.pipe(v.number(), v.minValue(0)), 30_000),
  /** Default retry-after when header is missing (ms) */
  default_retry_after_ms: v.optional(v.pipe(v.number(), v.minValue(0)), 60_000),
  /** Consecutive auth failures before disabling account */
  max_consecutive_auth_failures: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 3),
  /** Backoff after token refresh failure (ms) */
  token_failure_backoff_ms: v.optional(v.pipe(v.number(), v.minValue(0)), 30_000),
  /** Enable proactive background token refresh */
  proactive_refresh: v.optional(v.boolean(), true),
  /** Seconds before expiry to trigger proactive refresh (default 30 min) */
  proactive_refresh_buffer_seconds: v.optional(v.pipe(v.number(), v.minValue(60)), 1800),
  /** Interval between background refresh checks in seconds (default 5 min) */
  proactive_refresh_interval_seconds: v.optional(v.pipe(v.number(), v.minValue(30)), 300),
  /** Suppress toast notifications */
  quiet_mode: v.optional(v.boolean(), false),
  /** Enable debug logging */
  debug: v.optional(v.boolean(), false),
});

export type PluginConfig = v.InferOutput<typeof PluginConfigSchema>;

// ─── External Plugin Auth Hook ───────────────────────────────────

export interface OriginalAuthHook {
  methods?: Array<{
    authorize?: (inputs?: Record<string, string>) => Promise<unknown>;
  }>;
  loader: (
    getAuth: () => Promise<unknown>,
    provider: unknown,
  ) => Promise<{ apiKey: string; fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }>;
}

// ─── Types (manual — not from external data) ────────────────────

export type TokenRefreshResult =
  | { ok: true; patch: CredentialRefreshPatch }
  | { ok: false; permanent: boolean };

export interface ManagedAccount {
  index: number;
  uuid?: string;
  label?: string;
  email?: string;
  planTier?: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  addedAt: number;
  lastUsed: number;
  enabled: boolean;
  rateLimitResetAt?: number;
  last429At?: number;
  cachedUsage?: UsageLimits;
  cachedUsageAt?: number;
  consecutiveAuthFailures: number;
  isAuthDisabled: boolean;
  authDisabledReason?: string;
}

export interface PluginClient {
  auth: {
    set: (params: {
      path: { id: string };
      body: {
        type: string;
        refresh: string;
        access: string;
        expires: number;
      };
    }) => Promise<void>;
  };
  tui: {
    showToast: (params: {
      body: {
        title?: string;
        message: string;
        variant: "info" | "warning" | "success" | "error";
      };
    }) => Promise<void>;
  };
  app: {
    log: (params: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
        extra?: Record<string, unknown>;
      };
    }) => Promise<void>;
  };
}
