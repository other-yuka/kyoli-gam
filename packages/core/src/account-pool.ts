import type {
  AccountFailureInput,
  AccountRecord,
  AccountStore,
  AccountSuccessInput,
  AccountUpdateInput,
} from "./accounts";
import { scoreQuotaResetPace, type QuotaRoutingWindow } from "opencode-multi-account-core";
import {
  isCurrentlyAuthCoolingDown,
  isCurrentlyRateLimited,
  readAccountAvailabilityState,
  shouldRecoverRateLimitBlock,
} from "./account-state";
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

export interface AccountSelectionDiagnostics {
  strategy: AccountSelectionStrategy;
  stickyKey: string;
  poolKey: string;
  preferredAccountId?: string;
  excludedAccountIds: string[];
  eligibleAccountIds: string[];
  ineligibleAccounts: Array<{
    id: string;
    state: ReturnType<typeof readAccountAvailabilityState>;
    reason: string;
  }>;
  softQuotaThresholdPercent: number;
  softQuotaSkippedAccountIds: string[];
  softQuotaFallbackUsed: boolean;
  poolAccountIds: string[];
  selectedReason?: string;
  selectedAccount?: AccountSelectionAccountSnapshot;
  weightedScores?: Array<{ id: string; score: number; sticky: boolean }>;
}

export interface AccountSelectionAccountSnapshot {
  id: string;
  planTier?: string;
  failureCount: number;
  lastUsedAt?: string;
  usage: {
    max?: number;
    five_hour?: number;
    seven_day?: number;
  };
}

export interface AccountSelectionResult {
  account?: AccountRecord;
  diagnostics: AccountSelectionDiagnostics;
}

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
  selectWithDiagnostics?(input: AccountSelectionInput): Promise<AccountSelectionResult>;
  update(accountId: string, input: AccountUpdateInput): Promise<AccountRecord | undefined>;
  recordSuccess(accountId: string, input?: AccountSuccessInput): Promise<void>;
  recordFailure(accountId: string, input: AccountFailureInput): Promise<void>;
}

type RuntimeAccountPoolOptions = Required<Omit<AccountPoolOptions, "stickySessionStore">>;
type UsageTier = {
  key: string;
  utilization: number;
  hasUtilization: boolean;
  resetAt?: string;
};

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
      softQuotaThresholdPercent: clampPercent(options.softQuotaThresholdPercent ?? 95),
      planWeights: { ...DEFAULT_PLAN_WEIGHTS, ...options.planWeights },
      weightedSwitchMargin: Math.max(0, options.weightedSwitchMargin ?? DEFAULT_WEIGHTED_SWITCH_MARGIN),
    };
    this.stickySessionStore = options.stickySessionStore ?? new MemoryStickySessionStore();
  }

  async listByProvider(provider: ProviderId): Promise<AccountRecord[]> {
    return this.recoverExpiredRateLimits(await this.store.listByProvider(provider));
  }

  async select(input: AccountSelectionInput): Promise<AccountRecord | undefined> {
    return (await this.selectWithDiagnostics(input)).account;
  }

  async selectWithDiagnostics(input: AccountSelectionInput): Promise<AccountSelectionResult> {
    const allAccounts = await this.listByProvider(input.provider);
    const stickyKind = readStickySessionKind(input.sessionKey, input.kind);
    const stickyKey = `${input.provider}:${stickyKind}:${input.sessionKey}`;
    const poolKey = `${input.provider}:${input.kind ?? "any"}`;
    const accounts = allAccounts.filter((account) => isEligible(account, input));
    const usable = accounts.filter((account) => !exceedsSoftQuota(account, this.options));
    const pool = usable.length > 0 ? usable : accounts;
    const diagnostics: AccountSelectionDiagnostics = {
      strategy: this.options.strategy,
      stickyKey,
      poolKey,
      preferredAccountId: input.preferredAccountId,
      excludedAccountIds: [...(input.excludeAccountIds ?? [])],
      eligibleAccountIds: accounts.map((account) => account.id),
      ineligibleAccounts: allAccounts
        .filter((account) => !accounts.includes(account))
        .map((account) => ineligibleAccountDiagnostic(account, input)),
      softQuotaThresholdPercent: this.options.softQuotaThresholdPercent,
      softQuotaSkippedAccountIds: accounts
        .filter((account) => exceedsSoftQuota(account, this.options))
        .map((account) => account.id),
      softQuotaFallbackUsed: accounts.length > 0 && usable.length === 0,
      poolAccountIds: pool.map((account) => account.id),
    };

    if (accounts.length === 0 || pool.length === 0) return { diagnostics };

    const preferred = pool.find((account) => account.id === input.preferredAccountId);
    if (preferred) {
      this.setStickySession(stickyKey, preferred.id);
      diagnostics.selectedReason = "preferred";
      diagnostics.selectedAccount = accountSelectionSnapshot(preferred);
      return { account: preferred, diagnostics };
    }

    if (this.options.strategy === "round-robin") {
      const selected = this.selectRoundRobin(pool, poolKey, stickyKey);
      diagnostics.selectedReason = "round_robin";
      diagnostics.selectedAccount = selected ? accountSelectionSnapshot(selected) : undefined;
      return { account: selected, diagnostics };
    }

    if (this.options.strategy === "weighted") {
      const selected = this.selectWeighted(pool, stickyKey, diagnostics);
      diagnostics.selectedAccount = selected ? accountSelectionSnapshot(selected) : undefined;
      return { account: selected, diagnostics };
    }

    const selected = this.selectSticky(pool, stickyKey, diagnostics);
    diagnostics.selectedAccount = selected ? accountSelectionSnapshot(selected) : undefined;
    return { account: selected, diagnostics };
  }

  private selectSticky(
    accounts: AccountRecord[],
    stickyKey: string,
    diagnostics?: AccountSelectionDiagnostics,
  ): AccountRecord | undefined {
    const stickySession = this.stickySessionStore.getStickySession(stickyKey);
    const stickyAccount = accounts.find((account) => account.id === stickySession?.accountId);
    if (stickyAccount) {
      if (diagnostics) diagnostics.selectedReason = "sticky_existing";
      return stickyAccount;
    }

    const selected = accounts[0];
    this.setStickySession(stickyKey, selected.id);
    if (diagnostics) diagnostics.selectedReason = "sticky_new";
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
    diagnostics?: AccountSelectionDiagnostics,
  ): AccountRecord | undefined {
    const stickySession = this.stickySessionStore.getStickySession(stickyKey);
    const stickyAccount = accounts.find((account) => account.id === stickySession?.accountId);

    let best = accounts[0];
    let bestScore = best ? scoreAccount(best, false, this.options) : Number.NEGATIVE_INFINITY;
    const scores: Array<{ id: string; score: number; sticky: boolean }> = [];
    if (best) scores.push({ id: best.id, score: bestScore, sticky: false });

    for (const account of accounts.slice(1)) {
      const score = scoreAccount(account, false, this.options);
      scores.push({ id: account.id, score, sticky: false });
      if (score > bestScore) {
        best = account;
        bestScore = score;
      }
    }

    if (stickyAccount && best && stickyAccount.id !== best.id) {
      const stickyScore = scoreAccount(stickyAccount, true, this.options);
      scores.push({ id: stickyAccount.id, score: stickyScore, sticky: true });
      if (bestScore <= stickyScore + this.options.weightedSwitchMargin) {
        if (diagnostics) {
          diagnostics.selectedReason = "weighted_sticky";
          diagnostics.weightedScores = scores;
        }
        return stickyAccount;
      }
    }

    if (best) {
      this.setStickySession(stickyKey, best.id);
      if (diagnostics) {
        diagnostics.selectedReason = "weighted_best";
        diagnostics.weightedScores = scores;
      }
    }
    return best;
  }

  async update(
    accountId: string,
    input: AccountUpdateInput,
  ): Promise<AccountRecord | undefined> {
    return this.store.update(accountId, input);
  }

  async recordSuccess(accountId: string, input: AccountSuccessInput = {}): Promise<void> {
    await this.store.recordSuccess(accountId, input);
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
      if (shouldRecoverRateLimitBlock(account, now)) {
        recovered.push(await this.store.resetState(account.id));
      } else {
        recovered.push(account);
      }
    }

    return recovered.filter((account): account is AccountRecord => Boolean(account));
  }
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
      !isCurrentlyRateLimited(account) &&
      !isCurrentlyAuthCoolingDown(account) &&
      !input.excludeAccountIds?.includes(account.id) &&
      (!input.kind || account.kind === input.kind),
  );
}

function ineligibleAccountDiagnostic(
  account: AccountRecord,
  input: AccountSelectionInput,
): AccountSelectionDiagnostics["ineligibleAccounts"][number] {
  const state = readAccountAvailabilityState(account);
  let reason: string = state;
  if (input.excludeAccountIds?.includes(account.id)) reason = "excluded";
  else if (input.kind && account.kind !== input.kind) reason = "kind_mismatch";
  return { id: account.id, state, reason };
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
  const resetPaceScore = getResetPaceScore(account) * planWeight;
  const healthScore = Math.max(0, 250 - account.failureCount * 60);
  const freshnessScore = getFreshnessScore(account);
  const stickinessBonus = isSticky ? 120 : 0;

  return usageScore + resetPaceScore + healthScore + freshnessScore + stickinessBonus;
}

function getMaxUtilization(account: AccountRecord): number {
  const tiers = readUsageTiers(account);
  if (tiers.length === 0) return 65;
  return Math.min(100, Math.max(0, Math.max(...tiers.map((tier) => tier.utilization))));
}

function accountSelectionSnapshot(account: AccountRecord): AccountSelectionAccountSnapshot {
  const fiveHour = readUsageUtilization(account, "five_hour");
  const sevenDay = readUsageUtilization(account, "seven_day");
  const max = getMaxUtilization(account);
  return {
    id: account.id,
    planTier: typeof account.metadata.planTier === "string" ? account.metadata.planTier : undefined,
    failureCount: account.failureCount,
    lastUsedAt: account.lastUsedAt,
    usage: {
      ...(Number.isFinite(max) ? { max } : {}),
      ...(fiveHour !== undefined ? { five_hour: fiveHour } : {}),
      ...(sevenDay !== undefined ? { seven_day: sevenDay } : {}),
    },
  };
}

function readUsageUtilization(account: AccountRecord, key: string): number | undefined {
  const usage = readRecord(account.metadata.cachedUsage) ?? readRecord(account.metadata.usage);
  const window = readRecord(usage?.[key]);
  return window ? readNumber(window.utilization) : undefined;
}

function readUsageTiers(account: AccountRecord): UsageTier[] {
  const usage = readRecord(account.metadata.cachedUsage) ?? readRecord(account.metadata.usage);
  if (!usage) return [];

  return Object.entries(usage)
    .filter(([key]) => key === "five_hour" || key === "seven_day" || key.startsWith("seven_day_"))
    .map(([key, value]) => ({ key, tier: readRecord(value) }))
    .filter((item): item is { key: string; tier: Record<string, unknown> } => Boolean(item.tier))
    .map(({ key, tier }) => {
      const utilization = readNumber(tier.utilization);
      return {
        key,
        utilization: utilization ?? 0,
        hasUtilization: utilization !== undefined,
        resetAt: readUsageWindowResetAt(tier),
      };
    });
}

function getResetPaceScore(account: AccountRecord): number {
  return scoreQuotaResetPace(readUsageTiers(account).map(toQuotaRoutingWindow));
}

function readUsageWindowResetAt(tier: Record<string, unknown>): string | undefined {
  return readString(tier.reset_at) ??
    readString(tier.resetAt) ??
    readString(tier.resets_at) ??
    readString(tier.resetsAt);
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toQuotaRoutingWindow(tier: UsageTier): QuotaRoutingWindow {
  return {
    key: tier.key,
    utilization: tier.hasUtilization ? tier.utilization : undefined,
    resetAt: tier.resetAt,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(100, value));
}
