import type { ManagedAccount } from "./types";
import type { FailoverCandidate, FailoverSkip, PoolChainConfig, PoolConfig } from "./pool-types";

const DEFAULT_EXHAUSTED_COOLDOWN_MS = 5 * 60 * 1000;

interface PoolAwareAccountManager {
  getAccounts(): ManagedAccount[];
  isRateLimited(account: ManagedAccount): boolean;
  selectAccount(): Promise<ManagedAccount | null>;
}

export interface BuildFailoverPlanOptions {
  attemptedAccounts?: Set<string>;
  visitedChainIndexes?: Set<number>;
}

export interface FailoverPlan {
  candidates: FailoverCandidate[];
  skips: FailoverSkip[];
}

export class PoolManager {
  private poolsByName = new Map<string, PoolConfig>();
  private exhaustedUntilByAccount = new Map<string, number>();
  private exhaustedCooldownMs: number;

  constructor(options?: { exhaustedCooldownMs?: number }) {
    this.exhaustedCooldownMs = options?.exhaustedCooldownMs ?? DEFAULT_EXHAUSTED_COOLDOWN_MS;
  }

  loadPools(configs: PoolConfig[]): void {
    this.poolsByName.clear();
    for (const pool of configs) {
      this.poolsByName.set(pool.name, pool);
    }
  }

  getPoolForAccount(accountUuid: string): PoolConfig | null {
    for (const pool of this.poolsByName.values()) {
      if (!pool.enabled) continue;
      if (pool.members.includes(accountUuid)) return pool;
    }
    return null;
  }

  getAvailableMembers(pool: PoolConfig, accountManager: PoolAwareAccountManager): string[] {
    if (!pool.enabled) return [];
    this.clearExpiredExhausted();

    const accountsByUuid = new Map<string, ManagedAccount>();
    for (const account of accountManager.getAccounts()) {
      if (!account.uuid) continue;
      accountsByUuid.set(account.uuid, account);
    }

    return pool.members.filter((accountUuid) => {
      const account = accountsByUuid.get(accountUuid);
      if (!account) return false;
      if (!account.enabled || account.isAuthDisabled) return false;
      if (this.isExhausted(accountUuid)) return false;
      if (accountManager.isRateLimited(account)) return false;
      return true;
    });
  }

  markExhausted(accountUuid: string): void {
    this.exhaustedUntilByAccount.set(accountUuid, Date.now() + this.exhaustedCooldownMs);
  }

  async getNextMember(
    pool: PoolConfig,
    currentUuid: string | undefined,
    accountManager: PoolAwareAccountManager,
  ): Promise<string | null> {
    const availableMembers = this.getAvailableMembers(pool, accountManager);
    if (availableMembers.length === 0) return null;

    const excluded = new Set<string>();
    if (currentUuid) excluded.add(currentUuid);

    const preferred = await this.selectPreferredMember(availableMembers, excluded, accountManager);
    if (preferred) return preferred;

    for (const candidate of availableMembers) {
      if (candidate !== currentUuid) return candidate;
    }

    return null;
  }

  async buildFailoverPlan(
    currentAccount: Pick<ManagedAccount, "uuid" | "accountId"> | null,
    config: PoolChainConfig,
    accountManager: PoolAwareAccountManager,
    options?: BuildFailoverPlanOptions,
  ): Promise<FailoverPlan> {
    this.loadPools(config.pools ?? []);

    if ((config.pools?.length ?? 0) === 0 && (config.chains?.length ?? 0) === 0) {
      return { candidates: [], skips: [] };
    }

    const attemptedAccounts = options?.attemptedAccounts ?? new Set<string>();
    const visitedChainIndexes = options?.visitedChainIndexes ?? new Set<number>();
    const currentUuid = currentAccount?.uuid;

    const candidates: FailoverCandidate[] = [];
    const skips: FailoverSkip[] = [];
    const addedCandidateUuids = new Set<string>();

    const appendPoolCandidates = async (
      poolName: string,
      source: "pool" | "chain",
      chainIndex?: number,
    ): Promise<void> => {
      const pool = this.poolsByName.get(poolName);
      if (!pool || !pool.enabled) {
        skips.push({
          type: "chain_disabled",
          poolName,
          reason: "Pool is missing or disabled",
        });
        return;
      }

      const available = this.getAvailableMembers(pool, accountManager);
      if (available.length === 0) {
        skips.push({
          type: "pool_exhausted",
          poolName,
          reason: "No available members",
        });
        return;
      }

      const poolExclusions = new Set<string>();
      if (currentUuid) poolExclusions.add(currentUuid);

      while (poolExclusions.size < available.length + (currentUuid ? 1 : 0)) {
        const nextMember = await this.selectPreferredMember(available, poolExclusions, accountManager);
        if (!nextMember) break;

        poolExclusions.add(nextMember);

        if (attemptedAccounts.has(nextMember)) {
          skips.push({
            type: "account_attempted",
            poolName,
            reason: "Already attempted in this cascade",
            detail: nextMember,
          });
          continue;
        }

        if (addedCandidateUuids.has(nextMember)) continue;

        candidates.push({
          poolName,
          accountUuid: nextMember,
          source,
          chainIndex,
        });
        addedCandidateUuids.add(nextMember);
      }

      for (const memberUuid of available) {
        if (poolExclusions.has(memberUuid)) continue;
        if (attemptedAccounts.has(memberUuid)) {
          skips.push({
            type: "account_attempted",
            poolName,
            reason: "Already attempted in this cascade",
            detail: memberUuid,
          });
          continue;
        }
        if (addedCandidateUuids.has(memberUuid)) continue;

        candidates.push({
          poolName,
          accountUuid: memberUuid,
          source,
          chainIndex,
        });
        addedCandidateUuids.add(memberUuid);
      }
    };

    if (currentUuid) {
      const currentPool = this.getPoolForAccount(currentUuid);
      if (currentPool) {
        await appendPoolCandidates(currentPool.name, "pool");
      }
    }

    let flattenedChainIndex = 0;
    for (const chain of config.chains ?? []) {
      if (!chain.enabled) {
        for (let i = 0; i < chain.entries.length; i++) {
          skips.push({
            type: "chain_disabled",
            poolName: chain.entries[i]?.pool ?? chain.name,
            reason: `Chain '${chain.name}' is disabled`,
          });
          flattenedChainIndex += 1;
        }
        continue;
      }

      for (const entry of chain.entries) {
        if (visitedChainIndexes.has(flattenedChainIndex)) {
          skips.push({
            type: "chain_disabled",
            poolName: entry.pool,
            reason: "Chain entry already visited in this cascade",
            detail: `${flattenedChainIndex}`,
          });
          flattenedChainIndex += 1;
          continue;
        }

        if (!entry.enabled) {
          skips.push({
            type: "chain_disabled",
            poolName: entry.pool,
            reason: "Chain entry is disabled",
            detail: `${flattenedChainIndex}`,
          });
          flattenedChainIndex += 1;
          continue;
        }

        await appendPoolCandidates(entry.pool, "chain", flattenedChainIndex);
        flattenedChainIndex += 1;
      }
    }

    return { candidates, skips };
  }

  private isExhausted(accountUuid: string): boolean {
    const exhaustedUntil = this.exhaustedUntilByAccount.get(accountUuid);
    if (!exhaustedUntil) return false;
    if (Date.now() >= exhaustedUntil) {
      this.exhaustedUntilByAccount.delete(accountUuid);
      return false;
    }
    return true;
  }

  private clearExpiredExhausted(): void {
    const now = Date.now();
    for (const [accountUuid, exhaustedUntil] of this.exhaustedUntilByAccount.entries()) {
      if (now >= exhaustedUntil) this.exhaustedUntilByAccount.delete(accountUuid);
    }
  }

  private async selectPreferredMember(
    availableMembers: string[],
    excludedMembers: Set<string>,
    accountManager: PoolAwareAccountManager,
  ): Promise<string | null> {
    const availableSet = new Set(availableMembers);
    const maxAttempts = Math.max(availableMembers.length * 2, 6);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const selected = await accountManager.selectAccount();
      if (!selected?.uuid) continue;
      if (!availableSet.has(selected.uuid)) continue;
      if (excludedMembers.has(selected.uuid)) continue;
      return selected.uuid;
    }

    for (const memberUuid of availableMembers) {
      if (!excludedMembers.has(memberUuid)) return memberUuid;
    }
    return null;
  }
}
