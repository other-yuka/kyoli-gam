import type {
  AccountFailureInput,
  AccountRecord,
  AccountStore,
  AccountUpdateInput,
} from "./accounts";
import {
  MemoryStickySessionStore,
  type StickySessionRecord,
  type StickySessionStore,
} from "./sticky-sessions";
import type { ProviderId } from "./index";

export interface AccountSelectionInput {
  provider: ProviderId;
  kind?: AccountRecord["kind"];
  sessionKey: string;
  excludeAccountIds?: string[];
  preferredAccountId?: string;
}

export type AccountSelectionStrategy = "sticky" | "round-robin" | "weighted";

export interface AccountPoolOptions {
  strategy?: AccountSelectionStrategy;
  softQuotaThresholdPercent?: number;
  planWeights?: Record<string, number>;
  weightedSwitchMargin?: number;
  stickySessionStore?: StickySessionStore;
}

export interface AccountPool {
  listByProvider(provider: ProviderId): Promise<AccountRecord[]>;
  select(input: AccountSelectionInput): Promise<AccountRecord | undefined>;
  update(accountId: string, input: AccountUpdateInput): Promise<AccountRecord | undefined>;
  recordSuccess(accountId: string): Promise<void>;
  recordFailure(accountId: string, input: AccountFailureInput): Promise<void>;
}

type RuntimeAccountPoolOptions = Required<Omit<AccountPoolOptions, "stickySessionStore">>;

const DEFAULT_PLAN_WEIGHTS: Record<string, number> = {
  max: 3,
  pro: 2,
  plus: 1.5,
  free: 1,
};
const DEFAULT_WEIGHTED_SWITCH_MARGIN = 80;

export class StickyAccountPool implements AccountPool {
  private readonly roundRobinCursorByPool = new Map<string, number>();
  private readonly options: RuntimeAccountPoolOptions;
  private readonly stickySessionStore: StickySessionStore;

  constructor(
    private readonly store: AccountStore,
    options: AccountPoolOptions = {},
  ) {
    this.options = {
      strategy: options.strategy ?? "sticky",
      softQuotaThresholdPercent: clampPercent(options.softQuotaThresholdPercent ?? 100),
      planWeights: { ...DEFAULT_PLAN_WEIGHTS, ...options.planWeights },
      weightedSwitchMargin: Math.max(0, options.weightedSwitchMargin ?? DEFAULT_WEIGHTED_SWITCH_MARGIN),
    };
    this.stickySessionStore = options.stickySessionStore ?? new MemoryStickySessionStore();
  }

  async listByProvider(provider: ProviderId): Promise<AccountRecord[]> {
    return this.recoverExpiredRateLimits(await this.store.listByProvider(provider));
  }

  async select(input: AccountSelectionInput): Promise<AccountRecord | undefined> {
    const accounts = (await this.listByProvider(input.provider)).filter((account) =>
      isEligible(account, input)
    );
    if (accounts.length === 0) return undefined;

    const stickyKey = `${input.provider}:${input.kind ?? "any"}:${input.sessionKey}`;
    const poolKey = `${input.provider}:${input.kind ?? "any"}`;
    const usable = accounts.filter((account) => !exceedsSoftQuota(account, this.options));
    const pool = usable.length > 0 ? usable : accounts;
    const preferred = pool.find((account) => account.id === input.preferredAccountId);
    if (preferred) {
      this.setStickySession(stickyKey, preferred.id);
      return preferred;
    }

    if (this.options.strategy === "round-robin") {
      return this.selectRoundRobin(pool, poolKey, stickyKey);
    }

    if (this.options.strategy === "weighted") {
      return this.selectWeighted(pool, stickyKey);
    }

    return this.selectSticky(pool, stickyKey);
  }

  private selectSticky(
    accounts: AccountRecord[],
    stickyKey: string,
  ): AccountRecord | undefined {
    const stickySession = this.stickySessionStore.getStickySession(stickyKey);
    const stickyAccount = accounts.find((account) => account.id === stickySession?.accountId);
    if (stickyAccount) return stickyAccount;

    const selected = accounts[0];
    this.setStickySession(stickyKey, selected.id);
    return selected;
  }

  private selectRoundRobin(
    accounts: AccountRecord[],
    poolKey: string,
    stickyKey: string,
  ): AccountRecord | undefined {
    const cursor = this.roundRobinCursorByPool.get(poolKey) ?? 0;
    const selected = accounts[cursor % accounts.length];
    this.roundRobinCursorByPool.set(poolKey, (cursor + 1) % accounts.length);
    if (selected) {
      this.setStickySession(stickyKey, selected.id);
    }
    return selected;
  }

  private selectWeighted(
    accounts: AccountRecord[],
    stickyKey: string,
  ): AccountRecord | undefined {
    const stickySession = this.stickySessionStore.getStickySession(stickyKey);
    const stickyAccount = accounts.find((account) => account.id === stickySession?.accountId);

    let best = accounts[0];
    let bestScore = best ? scoreAccount(best, false, this.options) : Number.NEGATIVE_INFINITY;

    for (const account of accounts.slice(1)) {
      const score = scoreAccount(account, false, this.options);
      if (score > bestScore) {
        best = account;
        bestScore = score;
      }
    }

    if (stickyAccount && best && stickyAccount.id !== best.id) {
      const stickyScore = scoreAccount(stickyAccount, true, this.options);
      if (bestScore <= stickyScore + this.options.weightedSwitchMargin) {
        return stickyAccount;
      }
    }

    if (best) {
      this.setStickySession(stickyKey, best.id);
    }
    return best;
  }

  async update(
    accountId: string,
    input: AccountUpdateInput,
  ): Promise<AccountRecord | undefined> {
    return this.store.update(accountId, input);
  }

  async recordSuccess(accountId: string): Promise<void> {
    await this.store.recordSuccess(accountId);
  }

  async recordFailure(accountId: string, input: AccountFailureInput): Promise<void> {
    await this.store.recordFailure(accountId, input);
  }

  listStickySessions(): StickySessionRecord[] {
    return this.stickySessionStore.listStickySessions();
  }

  deleteStickySession(key: string): boolean {
    return this.stickySessionStore.deleteStickySession(key);
  }

  clearStickySessions(): number {
    return this.stickySessionStore.clearStickySessions();
  }

  purgeStickySessions(input?: Parameters<StickySessionStore["purgeStickySessions"]>[0]): number {
    return this.stickySessionStore.purgeStickySessions(input);
  }

  private setStickySession(key: string, accountId: string): void {
    this.stickySessionStore.upsertStickySession({
      ...parseStickyKey(key),
      key,
      accountId,
    });
  }

  private async recoverExpiredRateLimits(accounts: AccountRecord[]): Promise<AccountRecord[]> {
    const now = Date.now();
    const recovered = [];

    for (const account of accounts) {
      if (shouldRecoverExpiredRateLimit(account, now)) {
        recovered.push(await this.store.resetState(account.id));
      } else {
        recovered.push(account);
      }
    }

    return recovered.filter((account): account is AccountRecord => Boolean(account));
  }
}

function isRateLimited(account: AccountRecord): boolean {
  return Boolean(
    account.rateLimitResetAt && new Date(account.rateLimitResetAt).getTime() > Date.now(),
  );
}

function shouldRecoverExpiredRateLimit(account: AccountRecord, now: number): boolean {
  if (!account.rateLimitResetAt || account.reauthRequiredReason) return false;

  const resetAt = new Date(account.rateLimitResetAt).getTime();
  return Number.isFinite(resetAt) && resetAt <= now;
}

function parseStickyKey(key: string): Pick<StickySessionRecord, "provider" | "kind" | "sessionKey"> {
  const [provider, kind, ...sessionParts] = key.split(":");
  const sessionKey = sessionParts.join(":");
  return {
    provider: provider === "claude-code" ? "claude-code" : "codex",
    kind: readStickySessionKind(sessionKey, kind),
    sessionKey,
  };
}

function readStickySessionKind(sessionKey: string, accountKind: string | undefined): StickySessionRecord["kind"] {
  if (sessionKey.startsWith("fallback:")) return "prompt_cache";
  if (sessionKey.startsWith("prompt_cache:")) return "prompt_cache";
  if (sessionKey.startsWith("header:") || sessionKey.startsWith("body:") || sessionKey.startsWith("file:")) {
    return "codex_session";
  }
  return accountKind === "oauth" ? "oauth" : "any";
}

function isEligible(account: AccountRecord, input: AccountSelectionInput): boolean {
  return Boolean(
    account.enabled &&
      !account.reauthRequiredReason &&
      !isRateLimited(account) &&
      !input.excludeAccountIds?.includes(account.id) &&
      (!input.kind || account.kind === input.kind),
  );
}

function exceedsSoftQuota(
  account: AccountRecord,
  options: RuntimeAccountPoolOptions,
): boolean {
  if (options.softQuotaThresholdPercent >= 100) return false;

  return readUsageTiers(account).some((tier) =>
    tier.utilization >= options.softQuotaThresholdPercent
  );
}

function scoreAccount(
  account: AccountRecord,
  isSticky: boolean,
  options: RuntimeAccountPoolOptions,
): number {
  const maxUtilization = getMaxUtilization(account);
  const planWeight = readPlanWeight(account, options.planWeights);
  const usageScore = ((100 - maxUtilization) / 100) * 450 * planWeight;
  const healthScore = Math.max(0, 250 - account.failureCount * 60);
  const freshnessScore = getFreshnessScore(account);
  const stickinessBonus = isSticky ? 120 : 0;

  return usageScore + healthScore + freshnessScore + stickinessBonus;
}

function getMaxUtilization(account: AccountRecord): number {
  const tiers = readUsageTiers(account);
  if (tiers.length === 0) return 65;
  return Math.min(100, Math.max(0, Math.max(...tiers.map((tier) => tier.utilization))));
}

function readUsageTiers(account: AccountRecord): Array<{ utilization: number }> {
  const usage = readRecord(account.metadata.cachedUsage) ?? readRecord(account.metadata.usage);
  if (!usage) return [];

  return ["five_hour", "seven_day", "seven_day_sonnet"]
    .map((key) => readRecord(usage[key]))
    .filter((tier): tier is Record<string, unknown> => Boolean(tier))
    .map((tier) => ({ utilization: readNumber(tier.utilization) ?? 0 }));
}

function readPlanWeight(
  account: AccountRecord,
  planWeights: Record<string, number>,
): number {
  const explicit = readNumber(account.metadata.weight);
  if (explicit && explicit > 0) return explicit;

  const planTier = typeof account.metadata.planTier === "string"
    ? account.metadata.planTier.toLowerCase()
    : "free";
  return planWeights[planTier] ?? 1;
}

function getFreshnessScore(account: AccountRecord): number {
  if (!account.lastUsedAt) return 60;

  const secondsSinceUsed = (Date.now() - new Date(account.lastUsedAt).getTime()) / 1000;
  if (!Number.isFinite(secondsSinceUsed) || secondsSinceUsed <= 0) return 0;
  return (Math.min(secondsSinceUsed, 900) / 900) * 60;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(100, value));
}
