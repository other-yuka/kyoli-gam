import * as v from "valibot";

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
  accountId: v.optional(v.string()),
  email: v.optional(v.string()),
});

export const StoredAccountSchema = v.object({
  uuid: v.optional(v.string()),
  accountId: v.optional(v.string()),
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

export const AccountSelectionStrategySchema = v.picklist(["sticky", "round-robin", "hybrid"]);

export const PluginConfigSchema = v.object({
  account_selection_strategy: v.optional(AccountSelectionStrategySchema, "sticky"),
  cross_process_claims: v.optional(v.boolean(), true),
  soft_quota_threshold_percent: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100)), 100),
  rate_limit_min_backoff_ms: v.optional(v.pipe(v.number(), v.minValue(0)), 30_000),
  default_retry_after_ms: v.optional(v.pipe(v.number(), v.minValue(0)), 60_000),
  max_consecutive_auth_failures: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 3),
  token_failure_backoff_ms: v.optional(v.pipe(v.number(), v.minValue(0)), 30_000),
  proactive_refresh: v.optional(v.boolean(), true),
  proactive_refresh_buffer_seconds: v.optional(v.pipe(v.number(), v.minValue(60)), 1800),
  proactive_refresh_interval_seconds: v.optional(v.pipe(v.number(), v.minValue(30)), 300),
  quiet_mode: v.optional(v.boolean(), false),
  debug: v.optional(v.boolean(), false),
});

export type OAuthCredentials = v.InferOutput<typeof OAuthCredentialsSchema>;
export type UsageLimitEntry = v.InferOutput<typeof UsageLimitEntrySchema>;
export type UsageLimits = v.InferOutput<typeof UsageLimitsSchema>;
export type CredentialRefreshPatch = v.InferOutput<typeof CredentialRefreshPatchSchema>;
export type StoredAccount = v.InferOutput<typeof StoredAccountSchema>;
export type AccountStorage = v.InferOutput<typeof AccountStorageSchema>;
export type AccountSelectionStrategy = v.InferOutput<typeof AccountSelectionStrategySchema>;
export type PluginConfig = v.InferOutput<typeof PluginConfigSchema>;

export type TokenRefreshResult =
  | { ok: true; patch: CredentialRefreshPatch }
  | { ok: false; permanent: boolean; status?: number };

export interface ManagedAccount {
  index: number;
  uuid?: string;
  accountId?: string;
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
