import * as v from "valibot";

// ─── Valibot Schemas (disk-persisted config) ─────────────────────

export const PoolConfigSchema = v.object({
  name: v.string(),
  baseProvider: v.string(),
  members: v.array(v.string()),
  enabled: v.boolean(),
});

export const ChainEntryConfigSchema = v.object({
  pool: v.string(),
  model: v.optional(v.string()),
  enabled: v.boolean(),
});

export const ChainConfigSchema = v.object({
  name: v.string(),
  entries: v.array(ChainEntryConfigSchema),
  enabled: v.boolean(),
});

export const PoolChainConfigSchema = v.object({
  pools: v.optional(v.array(PoolConfigSchema), []),
  chains: v.optional(v.array(ChainConfigSchema), []),
});

// ─── Inferred Types (from schemas) ───────────────────────────────

export type PoolConfig = v.InferOutput<typeof PoolConfigSchema>;
export type ChainEntryConfig = v.InferOutput<typeof ChainEntryConfigSchema>;
export type ChainConfig = v.InferOutput<typeof ChainConfigSchema>;
export type PoolChainConfig = v.InferOutput<typeof PoolChainConfigSchema>;

// In-memory cascade state (NOT persisted)
export interface CascadeState {
  prompt: string;
  attemptedAccounts: Set<string>;
  visitedChainIndexes: Set<number>;
}

// Candidate for failover rotation
export interface FailoverCandidate {
  poolName: string;
  accountUuid: string;
  source: "pool" | "chain";
  chainIndex?: number;
}

// Skipped entry during failover planning
export interface FailoverSkip {
  type: "pool_exhausted" | "chain_disabled" | "account_attempted" | "account_unavailable";
  poolName: string;
  reason: string;
  detail?: string;
}
