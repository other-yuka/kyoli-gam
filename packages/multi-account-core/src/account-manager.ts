import { randomUUID } from "node:crypto";
import { readClaims, writeClaim, isClaimedByOther, type ClaimsMap } from "./claims";
import { getConfig } from "./config";
import { isQuotaWindowActive, normalizeUsagePercent, scoreQuotaResetPace, type QuotaRoutingWindow } from "./routing";
import { getClearedOAuthBody } from "./utils";
import type { AccountStore, DiskCredentials } from "./account-store";
import type {
  AccountMetadataPatch,
  AccountStorage,
  ManagedAccount,
  OAuthCredentials,
  PluginClient,
  PluginConfig,
  StoredAccount,
  TokenRefreshResult,
  UsageLimits,
} from "./types";

const STARTUP_REFRESH_CONCURRENCY = 3;
const RECENT_429_COOLDOWN_MS = 30_000;
const HYBRID_SWITCH_MARGIN = 40;
const STICKY_BINDING_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_STICKY_BINDINGS = 2_000;

interface StickyBinding {
  accountUuid: string;
  updatedAt: number;
}

type ManagedUsageTier = QuotaRoutingWindow & {
  utilization: number;
  hasUtilization: boolean;
  resetAt: string | null;
};

export interface ProfileData {
  email?: string;
  planTier: string;
}

export interface RuntimeFactoryLike {
  invalidate(uuid: string): void;
}

export interface MarkRateLimitedOptions {
  rateLimitResetMs?: number;
  usage?: UsageLimits;
}

export interface ApplyUsageCacheOptions {
  observedAt?: number;
  rateLimitResetMs?: number;
  expectedRateLimitObservedAt?: number | null;
}

export interface ApplyUsageCacheAtRevisionOptions {
  observedAt?: number;
  rateLimitResetMs?: number;
  expectedRateLimitRevision: RateLimitRevision | null;
}

declare const rateLimitRevisionBrand: unique symbol;
export type RateLimitRevision = number & { readonly [rateLimitRevisionBrand]: true };

export function captureRateLimitRevision(
  account: Pick<ManagedAccount, "rateLimitObservedAt">,
): RateLimitRevision | null {
  return account.rateLimitObservedAt === undefined
    ? null
    : account.rateLimitObservedAt as RateLimitRevision;
}

export interface AccountManagerDependencies {
  providerAuthId: string;
  getConfig?: () => Pick<PluginConfig, "soft_quota_threshold_percent" | "cross_process_claims" | "account_selection_strategy" | "max_consecutive_auth_failures" | "rate_limit_min_backoff_ms">;
  isTokenExpired: (account: Pick<ManagedAccount, "accessToken" | "expiresAt">) => boolean;
  refreshToken: (
    currentRefreshToken: string,
    accountId: string,
    client: PluginClient,
  ) => Promise<TokenRefreshResult>;
  readClaims?: () => Promise<ClaimsMap>;
  writeClaim?: (accountId: string) => Promise<void>;
  isClaimedByOther?: (claims: ClaimsMap, accountId: string | undefined) => boolean;
}

export interface AccountManagerInstance {
  initialize(currentAuth: OAuthCredentials, client?: PluginClient): Promise<void>;
  refresh(): Promise<void>;
  getAccountCount(): number;
  getAccounts(): ManagedAccount[];
  getActiveAccount(): ManagedAccount | null;
  setClient(client: PluginClient): void;
  setRuntimeFactory(factory: RuntimeFactoryLike): void;
  hasAnyUsableAccount(): boolean;
  isRateLimited(account: ManagedAccount): boolean;
  clearExpiredRateLimits(): void;
  getMinWaitTime(): number;
  selectAccount(stickyKey?: string): Promise<ManagedAccount | null>;
  markRateLimited(uuid: string, backoffMs?: number, options?: MarkRateLimitedOptions): Promise<void>;
  markRateLimitedAtRevision?(
    uuid: string,
    backoffMs?: number,
    options?: MarkRateLimitedOptions,
  ): Promise<RateLimitRevision | undefined>;
  markRevoked(uuid: string): Promise<void>;
  markSuccess(uuid: string, requestStartedAt?: number): Promise<void>;
  markSuccessAtRevision?(uuid: string, expectedRateLimitRevision: RateLimitRevision | null): Promise<void>;
  markAuthFailure(uuid: string, result: TokenRefreshResult, expected?: DiskCredentials): Promise<void>;
  applyUsageCache(uuid: string, usage: UsageLimits, options?: ApplyUsageCacheOptions): Promise<void>;
  applyUsageCacheAtRevision?(
    uuid: string,
    usage: UsageLimits,
    options: ApplyUsageCacheAtRevisionOptions,
  ): Promise<void>;
  applyProfileCache(uuid: string, profile: ProfileData): Promise<void>;
  ensureValidToken(uuid: string, client: PluginClient): Promise<TokenRefreshResult>;
  validateNonActiveTokens(client: PluginClient): Promise<void>;
  removeAccount(index: number): Promise<boolean>;
  clearAllAccounts(): Promise<void>;
  addAccount(auth: OAuthCredentials, email?: string, metadata?: AccountMetadataPatch): Promise<void>;
  toggleEnabled(uuid: string): Promise<void>;
  replaceAccountCredentials(uuid: string, auth: OAuthCredentials, metadata?: AccountMetadataPatch): Promise<void>;
  retryAuth(uuid: string, client: PluginClient): Promise<TokenRefreshResult>;
}

export interface AccountManagerClass {
  new (store: AccountStore): AccountManagerInstance;
  create(store: AccountStore, currentAuth: OAuthCredentials, client?: PluginClient): Promise<AccountManagerInstance>;
}

export function createAccountManagerForProvider(dependencies: AccountManagerDependencies): AccountManagerClass {
  const {
    providerAuthId,
    getConfig: getProviderConfig = getConfig,
    isTokenExpired,
    refreshToken,
    readClaims: readProviderClaims = readClaims,
    writeClaim: writeProviderClaim = writeClaim,
    isClaimedByOther: isClaimedByOtherProvider = isClaimedByOther,
  } = dependencies;

  return class AccountManager {
    private cached: ManagedAccount[] = [];
    private activeAccountUuid?: string;
    private client: PluginClient | null = null;
    private runtimeFactory: RuntimeFactoryLike | null = null;
    private roundRobinCursor = 0;
    private last429Map = new Map<string, number>();
    private stickyBindings = new Map<string, StickyBinding>();

    constructor(private store: AccountStore) {}

    static async create(
      store: AccountStore,
      currentAuth: OAuthCredentials,
      client?: PluginClient,
    ): Promise<AccountManager> {
      const manager = new AccountManager(store);
      await manager.initialize(currentAuth, client);
      return manager;
    }

    async initialize(currentAuth: OAuthCredentials, client?: PluginClient): Promise<void> {
      if (client) this.client = client;

      const storage = await this.store.load();
      if (storage.accounts.length > 0) {
        this.cached = storage.accounts.map((account, index) => this.toManagedAccount(account, index));
        this.activeAccountUuid = storage.activeAccountUuid;
        if (!this.getActiveAccount() && this.cached.length > 0) {
          this.activeAccountUuid = this.cached[0]!.uuid;
        }
        return;
      }

      if (currentAuth.refresh) {
        const newAccount = this.createNewAccount(currentAuth, Date.now());
        await this.store.addAccount(newAccount);
        await this.store.setActiveUuid(newAccount.uuid);
        this.cached = [this.toManagedAccount(newAccount, 0)];
        this.activeAccountUuid = newAccount.uuid;
      }
    }

    async refresh(): Promise<void> {
      const storage = await this.store.load();
      this.cached = storage.accounts.map((account, index) => this.toManagedAccount(account, index));
      if (storage.activeAccountUuid) {
        this.activeAccountUuid = storage.activeAccountUuid;
      }
    }

    private toManagedAccount(storedAccount: StoredAccount, index: number): ManagedAccount {
      return {
        index,
        uuid: storedAccount.uuid,
        accountId: storedAccount.accountId,
        accountUuid: storedAccount.accountUuid,
        deviceId: storedAccount.deviceId,
        label: storedAccount.label,
        email: storedAccount.email,
        planTier: storedAccount.planTier,
        refreshToken: storedAccount.refreshToken,
        accessToken: storedAccount.accessToken,
        expiresAt: storedAccount.expiresAt,
        addedAt: storedAccount.addedAt,
        lastUsed: storedAccount.lastUsed,
        enabled: storedAccount.enabled,
        rateLimitResetAt: storedAccount.rateLimitResetAt,
        rateLimitCooldownUntil: storedAccount.rateLimitCooldownUntil,
        rateLimitObservedAt: storedAccount.rateLimitObservedAt,
        cachedUsage: storedAccount.cachedUsage,
        cachedUsageAt: storedAccount.cachedUsageAt,
        consecutiveAuthFailures: storedAccount.consecutiveAuthFailures,
        isAuthDisabled: storedAccount.isAuthDisabled,
        authDisabledReason: storedAccount.authDisabledReason,
        last429At: storedAccount.uuid ? this.last429Map.get(storedAccount.uuid) : undefined,
      };
    }

    private applyAccountMetadata(account: StoredAccount, metadata?: AccountMetadataPatch): void {
      if (!metadata) return;

      if (metadata.accountId) account.accountId = metadata.accountId;
      if (metadata.accountUuid) account.accountUuid = metadata.accountUuid;
      if (metadata.deviceId) account.deviceId = metadata.deviceId;
      if (metadata.email) account.email = metadata.email;
      if (metadata.label) account.label = metadata.label;
      if (metadata.planTier !== undefined) account.planTier = metadata.planTier;
    }

    private createNewAccount(
      auth: OAuthCredentials,
      now: number,
      metadata?: AccountMetadataPatch,
    ): StoredAccount {
      const account: StoredAccount = {
        uuid: randomUUID(),
        refreshToken: auth.refresh,
        accessToken: auth.access,
        expiresAt: auth.expires,
        addedAt: now,
        lastUsed: now,
        enabled: true,
        planTier: "",
        consecutiveAuthFailures: 0,
        isAuthDisabled: false,
      };
      this.applyAccountMetadata(account, metadata);
      return account;
    }

    getAccountCount(): number {
      return this.getEligibleAccounts().length;
    }

    getAccounts(): ManagedAccount[] {
      return [...this.cached];
    }

    getActiveAccount(): ManagedAccount | null {
      if (this.activeAccountUuid) {
        return this.cached.find((account) => account.uuid === this.activeAccountUuid) ?? null;
      }
      return this.cached[0] ?? null;
    }

    setClient(client: PluginClient): void {
      this.client = client;
    }

    setRuntimeFactory(factory: RuntimeFactoryLike): void {
      this.runtimeFactory = factory;
    }

    private getEligibleAccounts(): ManagedAccount[] {
      return this.cached.filter((account) => account.uuid && account.enabled && !account.isAuthDisabled);
    }

    private exceedsSoftQuota(account: ManagedAccount): boolean {
      const threshold = getProviderConfig().soft_quota_threshold_percent;
      if (threshold >= 100) return false;

      const usage = account.cachedUsage;
      if (!usage) return false;

      return readAccountWideUsageTiers(usage).some((tier) =>
        tier.hasUtilization && tier.utilization >= threshold,
      );
    }

    hasAnyUsableAccount(): boolean {
      return this.getEligibleAccounts().length > 0;
    }

    isRateLimited(account: ManagedAccount): boolean {
      if (account.rateLimitCooldownUntil && Date.now() < account.rateLimitCooldownUntil) {
        return true;
      }
      if (account.rateLimitResetAt && Date.now() < account.rateLimitResetAt) {
        return true;
      }
      return this.isUsageExhausted(account);
    }

    private isUsageExhausted(account: ManagedAccount): boolean {
      const usage = account.cachedUsage;
      if (!usage) return false;

      const now = Date.now();
      return readAccountWideUsageTiers(usage).some((tier) => {
        const utilization = normalizeUsagePercent(tier.utilization);
        return utilization === 100
          && tier.resetAt != null
          && Date.parse(tier.resetAt) > now;
      });
    }

    clearExpiredRateLimits(): void {
      const now = Date.now();
      for (const account of this.cached) {
        if (account.rateLimitCooldownUntil && now >= account.rateLimitCooldownUntil) {
          account.rateLimitCooldownUntil = undefined;
        }
        if (account.rateLimitResetAt && now >= account.rateLimitResetAt) {
          account.rateLimitResetAt = undefined;
        }
      }
    }

    getMinWaitTime(): number {
      const eligible = this.getEligibleAccounts();
      const available = eligible.filter((account) => !this.isRateLimited(account));
      if (available.length > 0) return 0;

      const now = Date.now();
      const waits: number[] = [];

      for (const account of eligible) {
        let accountWaitMs = 0;
        if (account.rateLimitCooldownUntil) {
          const ms = account.rateLimitCooldownUntil - now;
          if (ms > 0) accountWaitMs = ms;
        }
        if (account.rateLimitResetAt) {
          const ms = account.rateLimitResetAt - now;
          if (ms > 0) accountWaitMs = Math.max(accountWaitMs, ms);
        }

        const usageResetMs = this.getUsageResetMs(account);
        if (usageResetMs !== null && usageResetMs > 0) {
          accountWaitMs = Math.max(accountWaitMs, usageResetMs);
        }

        if (accountWaitMs > 0) waits.push(accountWaitMs);
      }

      return waits.length > 0 ? Math.min(...waits) : 0;
    }

    private getUsageResetMs(account: ManagedAccount): number | null {
      const usage = account.cachedUsage;
      if (!usage) return null;

      const now = Date.now();
      const candidates: number[] = [];

      for (const tier of readAccountWideUsageTiers(usage)) {
        if (tier.hasUtilization && tier.utilization >= 100 && tier.resetAt != null) {
          const ms = Date.parse(tier.resetAt) - now;
          if (ms > 0) candidates.push(ms);
        }
      }

      return candidates.length > 0 ? Math.max(...candidates) : null;
    }

    async selectAccount(stickyKey?: string): Promise<ManagedAccount | null> {
      await this.refresh();
      this.clearExpiredRateLimits();
      this.cleanupStickyBindings();

      const eligible = this.getEligibleAccounts();
      if (eligible.length === 0) return null;

      const config = getProviderConfig();
      const claims = config.cross_process_claims ? await readProviderClaims() : {};

      const strategy = config.account_selection_strategy;
      let selected: ManagedAccount | null;
      switch (strategy) {
        case "round-robin":
          selected = this.selectRoundRobin(eligible, claims);
          break;
        case "hybrid":
          selected = this.selectHybrid(eligible, claims);
          break;
        case "sticky":
        default:
          selected = this.selectSticky(eligible, claims, stickyKey);
          break;
      }

      if (selected?.uuid) {
        this.activeAccountUuid = selected.uuid;
        this.store.setActiveUuid(selected.uuid).catch(() => {});
      }

      if (config.cross_process_claims && selected?.uuid) {
        writeProviderClaim(selected.uuid).catch(() => {});
      }

      return selected;
    }

    private isUsable(account: ManagedAccount): boolean {
      return !this.isRateLimited(account)
        && !this.isInRecentCooldown(account)
        && !this.exceedsSoftQuota(account);
    }

    private isInRecentCooldown(account: ManagedAccount): boolean {
      if (!account.last429At) return false;
      return Date.now() - account.last429At < RECENT_429_COOLDOWN_MS;
    }

    private fallbackNotRateLimited(eligible: ManagedAccount[]): ManagedAccount | null {
      const account = eligible.find((candidate) => !this.isRateLimited(candidate));
      if (account) {
        this.activateAccount(account);
        return account;
      }
      return null;
    }

    private selectSticky(eligible: ManagedAccount[], claims: ClaimsMap, stickyKey?: string): ManagedAccount | null {
      const boundAccount = this.getBoundStickyAccount(stickyKey, eligible);
      if (boundAccount) {
        this.activateAccount(boundAccount);
        return boundAccount;
      }

      const current = this.getActiveAccount();
      if (current?.enabled && !current.isAuthDisabled && this.isUsable(current)) {
        this.bindStickyAccount(stickyKey, current);
        this.activateAccount(current);
        return current;
      }

      const unclaimed = eligible.find(
        (account) => this.isUsable(account) && !isClaimedByOtherProvider(claims, account.uuid),
      );
      if (unclaimed) {
        this.bindStickyAccount(stickyKey, unclaimed);
        this.activateAccount(unclaimed);
        return unclaimed;
      }

      const available = eligible.find((account) => this.isUsable(account));
      if (available) {
        this.bindStickyAccount(stickyKey, available);
        this.activateAccount(available);
        return available;
      }

      const fallback = this.fallbackNotRateLimited(eligible);
      if (fallback) {
        this.bindStickyAccount(stickyKey, fallback);
      }
      return fallback;
    }

    private getBoundStickyAccount(stickyKey: string | undefined, eligible: ManagedAccount[]): ManagedAccount | null {
      if (!stickyKey) {
        return null;
      }

      const binding = this.stickyBindings.get(stickyKey);
      if (!binding) {
        return null;
      }

      const account = eligible.find((candidate) => candidate.uuid === binding.accountUuid);
      if (!account || !this.isUsable(account)) {
        return null;
      }

      binding.updatedAt = Date.now();
      this.stickyBindings.set(stickyKey, binding);
      return account;
    }

    private bindStickyAccount(stickyKey: string | undefined, account: ManagedAccount): void {
      if (!stickyKey || !account.uuid) {
        return;
      }

      this.stickyBindings.set(stickyKey, {
        accountUuid: account.uuid,
        updatedAt: Date.now(),
      });
      this.cleanupStickyBindings();
    }

    private cleanupStickyBindings(): void {
      const now = Date.now();
      const validUuids = new Set(
        this.cached
          .map((account) => account.uuid)
          .filter((uuid): uuid is string => typeof uuid === "string" && uuid.length > 0),
      );

      for (const [stickyKey, binding] of this.stickyBindings) {
        const isExpired = now - binding.updatedAt > STICKY_BINDING_TTL_MS;
        if (isExpired || !validUuids.has(binding.accountUuid)) {
          this.stickyBindings.delete(stickyKey);
        }
      }

      if (this.stickyBindings.size <= MAX_STICKY_BINDINGS) {
        return;
      }

      const bindingsByAge = [...this.stickyBindings.entries()]
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt);
      const overflow = this.stickyBindings.size - MAX_STICKY_BINDINGS;

      for (const [stickyKey] of bindingsByAge.slice(0, overflow)) {
        this.stickyBindings.delete(stickyKey);
      }
    }

    private removeStickyBindingsForAccount(uuid: string): void {
      for (const [stickyKey, binding] of this.stickyBindings) {
        if (binding.accountUuid === uuid) {
          this.stickyBindings.delete(stickyKey);
        }
      }
    }

    private replaceStickyBindingAccountUuid(previousUuid: string, nextUuid: string): void {
      for (const binding of this.stickyBindings.values()) {
        if (binding.accountUuid === previousUuid) {
          binding.accountUuid = nextUuid;
          binding.updatedAt = Date.now();
        }
      }
    }

    private selectRoundRobin(eligible: ManagedAccount[], claims: ClaimsMap): ManagedAccount | null {
      for (let i = 0; i < eligible.length; i++) {
        const index = (this.roundRobinCursor + i) % eligible.length;
        const account = eligible[index]!;
        if (this.isUsable(account) && !isClaimedByOtherProvider(claims, account.uuid)) {
          this.roundRobinCursor = (index + 1) % eligible.length;
          this.activateAccount(account);
          return account;
        }
      }

      for (let i = 0; i < eligible.length; i++) {
        const index = (this.roundRobinCursor + i) % eligible.length;
        const account = eligible[index]!;
        if (this.isUsable(account)) {
          this.roundRobinCursor = (index + 1) % eligible.length;
          this.activateAccount(account);
          return account;
        }
      }

      return this.fallbackNotRateLimited(eligible);
    }

    private selectHybrid(eligible: ManagedAccount[], claims: ClaimsMap): ManagedAccount | null {
      const usable = eligible.filter((account) => this.isUsable(account));
      const pool = usable.length > 0
        ? usable
        : eligible.filter((account) => !this.isRateLimited(account));

      if (pool.length === 0) return null;

      const activeUuid = this.activeAccountUuid;

      let best = pool[0]!;
      let bestScore = this.calculateHybridScore(best, best.uuid === activeUuid, claims);

      for (let i = 1; i < pool.length; i++) {
        const account = pool[i]!;
        const score = this.calculateHybridScore(account, account.uuid === activeUuid, claims);
        if (score > bestScore) {
          best = account;
          bestScore = score;
        }
      }

      const current = pool.find((account) => account.uuid === activeUuid);
      if (current && current !== best) {
        const currentScore = this.calculateHybridScore(current, true, claims);
        const bestWithoutStickiness = this.calculateHybridScore(best, false, claims);
        if (bestWithoutStickiness <= currentScore + HYBRID_SWITCH_MARGIN) {
          this.activateAccount(current);
          return current;
        }
      }

      this.activateAccount(best);
      return best;
    }

    private calculateHybridScore(account: ManagedAccount, isActive: boolean, claims: ClaimsMap): number {
      const maxUtilization = Math.min(100, Math.max(0, this.getMaxUtilization(account)));
      const usageScore = ((100 - maxUtilization) / 100) * 450;
      const resetPaceScore = scoreQuotaResetPace(
        readRoutingUsageTiers(account.cachedUsage).filter((tier) => tier.hasUtilization),
      );

      const maxFailures = Math.max(1, getProviderConfig().max_consecutive_auth_failures);
      const healthScore = Math.max(0, ((maxFailures - account.consecutiveAuthFailures) / maxFailures) * 250);

      const secondsSinceUsed = (Date.now() - account.lastUsed) / 1000;
      const freshnessScore = (Math.min(secondsSinceUsed, 900) / 900) * 60;

      const stickinessBonus = isActive ? 120 : 0;
      const claimPenalty = isClaimedByOtherProvider(claims, account.uuid) ? -200 : 0;

      return usageScore + resetPaceScore + healthScore + freshnessScore + stickinessBonus + claimPenalty;
    }

    private getMaxUtilization(account: ManagedAccount): number {
      const usage = account.cachedUsage;
      if (!usage) return 65;

      const utilizations = readAccountWideUsageTiers(usage)
        .filter((tier) => tier.hasUtilization)
        .map((tier) => tier.utilization);

      return utilizations.length > 0 ? Math.max(...utilizations) : 65;
    }

    private activateAccount(account: ManagedAccount): void {
      this.activeAccountUuid = account.uuid;
      account.lastUsed = Date.now();
    }

    async markRateLimited(
      uuid: string,
      backoffMs?: number,
      options: MarkRateLimitedOptions = {},
    ): Promise<void> {
      await this.recordRateLimited(uuid, backoffMs, options);
    }

    async markRateLimitedAtRevision(
      uuid: string,
      backoffMs?: number,
      options: MarkRateLimitedOptions = {},
    ): Promise<RateLimitRevision | undefined> {
      return this.recordRateLimited(uuid, backoffMs, options);
    }

    private async recordRateLimited(
      uuid: string,
      backoffMs: number | undefined,
      options: MarkRateLimitedOptions,
    ): Promise<RateLimitRevision | undefined> {
      const effectiveBackoff = backoffMs ?? getProviderConfig().rate_limit_min_backoff_ms;
      const now = Date.now();
      this.last429Map.set(uuid, now);
      const updated = await this.store.mutateAccount(uuid, (account) => {
        const usageResetAt = options.usage
          ? getExhaustedAccountWideUsageResetAt(options.usage, now)
          : undefined;
        const explicitResetAt = readFutureResetAt(options.rateLimitResetMs, now);
        const rateLimitResetAt = latestResetAt(usageResetAt, explicitResetAt);

        if (options.usage) {
          account.cachedUsage = options.usage;
          account.cachedUsageAt = now;
        }
        account.rateLimitCooldownUntil = now + effectiveBackoff;
        account.rateLimitResetAt = latestResetAt(rateLimitResetAt, account.rateLimitCooldownUntil);
        account.rateLimitObservedAt = nextRateLimitRevision(account.rateLimitObservedAt, now);
      });
      return updated?.rateLimitObservedAt as RateLimitRevision | undefined;
    }

    async markRevoked(uuid: string): Promise<void> {
      await this.removeAccountByUuid(uuid);
    }

    async markSuccess(uuid: string, requestStartedAt?: number): Promise<void> {
      await this.recordSuccessfulUse(
        uuid,
        (account) => !(
          requestStartedAt !== undefined
          && account.rateLimitObservedAt !== undefined
          && account.rateLimitObservedAt >= requestStartedAt
        ),
        false,
      );
    }

    async markSuccessAtRevision(
      uuid: string,
      expectedRateLimitRevision: RateLimitRevision | null,
    ): Promise<void> {
      await this.recordSuccessfulUse(
        uuid,
        (account) => readStoredRateLimitRevision(account) === expectedRateLimitRevision,
        true,
      );
    }

    private async recordSuccessfulUse(
      uuid: string,
      canClearRateLimit: (account: StoredAccount) => boolean,
      invalidateUsageSnapshots: boolean,
    ): Promise<void> {
      let clearedRateLimit = false;
      await this.store.mutateAccount(uuid, (account) => {
        const now = Date.now();
        if (canClearRateLimit(account)) {
          const clearsUsage = account.rateLimitResetAt !== undefined
            || account.rateLimitCooldownUntil !== undefined
            || (account.cachedUsage !== undefined
              && getExhaustedAccountWideUsageResetAt(account.cachedUsage, now) !== undefined);
          account.rateLimitResetAt = undefined;
          account.rateLimitCooldownUntil = undefined;
          if (invalidateUsageSnapshots && clearsUsage) {
            account.cachedUsage = undefined;
            account.cachedUsageAt = undefined;
          }
          if (invalidateUsageSnapshots && clearsUsage) {
            account.rateLimitObservedAt = nextRateLimitRevision(account.rateLimitObservedAt, now);
          }
          clearedRateLimit = true;
        }
        account.consecutiveAuthFailures = 0;
        account.lastUsed = now;
      });
      if (clearedRateLimit) this.last429Map.delete(uuid);
    }

    private syncToOpenCode(account: Pick<StoredAccount, "refreshToken" | "accessToken" | "expiresAt">): void {
      if (!this.client || !account.accessToken || !account.expiresAt) return;
      this.client.auth.set({
        path: { id: providerAuthId },
        body: {
          type: "oauth",
          refresh: account.refreshToken,
          access: account.accessToken,
          expires: account.expiresAt,
        },
      }).catch(() => {});
    }

    private async clearOpenCodeAuthIfNoAccountsRemain(): Promise<void> {
      if (!this.client) return;

      const storage = await this.store.load();
      if (storage.accounts.length > 0) return;

      await this.client.auth
        .set({
          path: { id: providerAuthId },
          body: getClearedOAuthBody(),
        })
        .catch(() => {});
    }

    private async removeAccountByUuid(uuid: string): Promise<void> {
      const removed = await this.store.removeAccount(uuid);
      if (!removed) return;

      this.last429Map.delete(uuid);
      this.removeStickyBindingsForAccount(uuid);
      this.runtimeFactory?.invalidate(uuid);
      await this.refresh();
      await this.clearOpenCodeAuthIfNoAccountsRemain();
    }

    async markAuthFailure(
      uuid: string,
      result: TokenRefreshResult,
      expected?: DiskCredentials,
    ): Promise<void> {
      const applyFailure = (account: StoredAccount, storage: AccountStorage): void => {
        if (!result.ok && result.permanent) {
          account.consecutiveAuthFailures = Math.max(
            (account.consecutiveAuthFailures ?? 0) + 1,
            getProviderConfig().max_consecutive_auth_failures,
          );
          account.isAuthDisabled = true;
          account.authDisabledReason = "refresh failed permanently";
          return;
        }

        account.consecutiveAuthFailures = (account.consecutiveAuthFailures ?? 0) + 1;
        const maxFailures = getProviderConfig().max_consecutive_auth_failures;
        const usableCount = storage.accounts.filter(
          (entry) => entry.enabled && !entry.isAuthDisabled && entry.uuid !== account.uuid,
        ).length;

        if (account.consecutiveAuthFailures >= maxFailures && usableCount > 0) {
          account.isAuthDisabled = true;
          account.authDisabledReason = `${maxFailures} consecutive auth failures`;
        }
      };

      if (expected) {
        await this.store.mutateStorageIfCredentialsMatch(uuid, expected, applyFailure);
        return;
      }

      await this.store.mutateStorage((storage) => {
        const account = storage.accounts.find((entry) => entry.uuid === uuid);
        if (!account) return;
        applyFailure(account, storage);
      });
    }

    async applyUsageCache(
      uuid: string,
      usage: UsageLimits,
      options: ApplyUsageCacheOptions = {},
    ): Promise<void> {
      await this.writeUsageCache(
        uuid,
        usage,
        options,
        (account, observedAt) => options.expectedRateLimitObservedAt !== undefined
          ? readStoredRateLimitRevision(account) === options.expectedRateLimitObservedAt
          : (account.rateLimitObservedAt ?? 0) <= observedAt,
        false,
      );
    }

    async applyUsageCacheAtRevision(
      uuid: string,
      usage: UsageLimits,
      options: ApplyUsageCacheAtRevisionOptions,
    ): Promise<void> {
      await this.writeUsageCache(
        uuid,
        usage,
        options,
        (account) => readStoredRateLimitRevision(account) === options.expectedRateLimitRevision,
        true,
      );
    }

    private async writeUsageCache(
      uuid: string,
      usage: UsageLimits,
      options: { observedAt?: number; rateLimitResetMs?: number },
      canApplyUsage: (account: StoredAccount, observedAt: number) => boolean,
      invalidateUsageSnapshots: boolean,
    ): Promise<void> {
      const observedAt = options.observedAt ?? Date.now();
      await this.store.mutateAccount(uuid, (account) => {
        const now = Date.now();
        if ((account.cachedUsageAt ?? 0) > observedAt) return;
        if (!canApplyUsage(account, observedAt)) return;
        const previousUsageResetAt = account.cachedUsage
          ? getExhaustedAccountWideUsageResetAt(account.cachedUsage, now)
          : undefined;
        const previousRateLimitResetAt = account.rateLimitResetAt;
        const previousRateLimitCooldownUntil = account.rateLimitCooldownUntil;
        const activeProviderCooldownUntil = account.rateLimitCooldownUntil
          && account.rateLimitCooldownUntil > now
          ? account.rateLimitCooldownUntil
          : undefined;
        const providerCooldownUntil = account.rateLimitCooldownUntil === undefined
          ? getLegacyProviderCooldownUntil(account, now)
          : activeProviderCooldownUntil;
        const usageResetAt = getExhaustedAccountWideUsageResetAt(usage, now);
        const explicitResetAt = readFutureResetAt(options.rateLimitResetMs, now);
        account.cachedUsage = usage;
        account.cachedUsageAt = observedAt;
        account.rateLimitCooldownUntil = providerCooldownUntil;
        account.rateLimitResetAt = latestResetAt(
          usageResetAt,
          explicitResetAt,
          providerCooldownUntil,
        );
        if (invalidateUsageSnapshots && (
          previousUsageResetAt !== usageResetAt
          || previousRateLimitResetAt !== account.rateLimitResetAt
          || previousRateLimitCooldownUntil !== account.rateLimitCooldownUntil
        )) {
          account.rateLimitObservedAt = nextRateLimitRevision(account.rateLimitObservedAt, now);
        }
      });
    }

    async applyProfileCache(uuid: string, profile: ProfileData): Promise<void> {
      await this.store.mutateAccount(uuid, (account) => {
        account.email = profile.email ?? account.email;
        account.planTier = profile.planTier;
      });
    }

    async ensureValidToken(uuid: string, client: PluginClient): Promise<TokenRefreshResult> {
      const credentials = await this.store.readCredentials(uuid);
      if (!credentials) return { ok: false, permanent: true };

      if (credentials.accessToken && credentials.expiresAt && !isTokenExpired(credentials)) {
        return {
          ok: true,
          patch: { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt },
        };
      }

      const { result, account: updated } = await this.store.refreshAccountCredentials(
        uuid,
        credentials,
        (refreshTokenValue) => refreshToken(refreshTokenValue, uuid, client),
      );
      if (!result.ok) return result;

      const nextUuid = updated?.uuid ?? uuid;
      if (nextUuid !== uuid && this.activeAccountUuid === uuid) {
        this.activeAccountUuid = nextUuid;
        this.store.setActiveUuid(nextUuid).catch(() => {});
      }

      if (nextUuid !== uuid) {
        this.replaceStickyBindingAccountUuid(uuid, nextUuid);
      }

      if (updated && (uuid === this.activeAccountUuid || updated.uuid === this.activeAccountUuid)) {
        this.syncToOpenCode(updated);
      }

      return result;
    }

    async validateNonActiveTokens(client: PluginClient): Promise<void> {
      await this.refresh();

      const activeUuid = this.activeAccountUuid;
      const eligible = this.cached.filter(
        (account) => account.enabled && !account.isAuthDisabled && account.uuid && account.uuid !== activeUuid,
      );

      for (let i = 0; i < eligible.length; i += STARTUP_REFRESH_CONCURRENCY) {
        const batch = eligible.slice(i, i + STARTUP_REFRESH_CONCURRENCY);
        await Promise.all(
          batch.map(async (account) => {
            if (!account.uuid || !isTokenExpired(account)) return;

            const result = await this.ensureValidToken(account.uuid, client);
            if (!result.ok) {
              await this.markAuthFailure(account.uuid, result, account);
            }
          }),
        );
      }
    }

    async removeAccount(index: number): Promise<boolean> {
      const account = this.cached[index];
      if (!account?.uuid) return false;

      const removed = await this.store.removeAccount(account.uuid);
      if (removed) {
        this.removeStickyBindingsForAccount(account.uuid);
        await this.refresh();
      }
      return removed;
    }

    async clearAllAccounts(): Promise<void> {
      await this.store.clear();
      this.cached = [];
      this.activeAccountUuid = undefined;
      this.stickyBindings.clear();
    }

    async addAccount(auth: OAuthCredentials, email?: string, metadata?: AccountMetadataPatch): Promise<void> {
      if (!auth.refresh) return;

      const existingByToken = this.cached.find((account) => account.refreshToken === auth.refresh);
      if (existingByToken) return;

      if (email) {
        const existingByEmail = this.cached.find(
          (account) => account.email && account.email === email,
        );
        if (existingByEmail?.uuid) {
          await this.replaceAccountCredentials(existingByEmail.uuid, auth, metadata);
          return;
        }
      }

      const newAccount = this.createNewAccount(auth, Date.now(), metadata);
      if (email) newAccount.email = email;
      await this.store.addAccount(newAccount);
      this.activeAccountUuid = newAccount.uuid;
      await this.store.setActiveUuid(newAccount.uuid);
      await this.refresh();
    }

    async toggleEnabled(uuid: string): Promise<void> {
      await this.store.mutateAccount(uuid, (account) => {
        account.enabled = !(account.enabled ?? true);
        if (account.enabled) {
          account.isAuthDisabled = false;
          account.authDisabledReason = undefined;
          account.consecutiveAuthFailures = 0;
        }
      });
    }

    async replaceAccountCredentials(
      uuid: string,
      auth: OAuthCredentials,
      metadata?: AccountMetadataPatch,
    ): Promise<void> {
      const updated = await this.store.mutateAccount(uuid, (account) => {
        account.refreshToken = auth.refresh;
        account.accessToken = auth.access;
        account.expiresAt = auth.expires;
        this.applyAccountMetadata(account, metadata);
        account.lastUsed = Date.now();
        account.enabled = true;
        account.isAuthDisabled = false;
        account.authDisabledReason = undefined;
        account.consecutiveAuthFailures = 0;
        account.rateLimitResetAt = undefined;
        account.rateLimitCooldownUntil = undefined;
        account.cachedUsage = undefined;
        account.cachedUsageAt = undefined;
        account.rateLimitObservedAt = nextRateLimitRevision(account.rateLimitObservedAt);
      });
      this.runtimeFactory?.invalidate(uuid);

      if (updated && uuid === this.activeAccountUuid) {
        this.syncToOpenCode(updated);
      }
    }

    async retryAuth(uuid: string, client: PluginClient): Promise<TokenRefreshResult> {
      await this.store.mutateAccount(uuid, (account) => {
        account.consecutiveAuthFailures = 0;
        account.isAuthDisabled = false;
        account.authDisabledReason = undefined;
      });
      this.runtimeFactory?.invalidate(uuid);

      const credentials = await this.store.readCredentials(uuid);
      if (!credentials) return { ok: false, permanent: true };

      const { result, account: refreshedAccount } = await this.store.refreshAccountCredentials(
        uuid,
        credentials,
        (refreshTokenValue) => refreshToken(refreshTokenValue, uuid, client),
      );
      if (result.ok) {
        const nextUuid = refreshedAccount?.uuid ?? uuid;
        const updated = await this.store.mutateAccount(nextUuid, (account) => {
          account.enabled = true;
          account.consecutiveAuthFailures = 0;
        });
        this.runtimeFactory?.invalidate(uuid);
        if (nextUuid !== uuid) {
          this.runtimeFactory?.invalidate(nextUuid);
        }

        if (this.activeAccountUuid === uuid && nextUuid !== uuid) {
          this.activeAccountUuid = nextUuid;
          await this.store.setActiveUuid(nextUuid);
        }

        if (nextUuid !== uuid) {
          this.replaceStickyBindingAccountUuid(uuid, nextUuid);
        }

        if (updated && (uuid === this.activeAccountUuid || nextUuid === this.activeAccountUuid)) {
          const freshCredentials = await this.store.readCredentials(nextUuid);
          if (freshCredentials) {
            this.syncToOpenCode({
              refreshToken: freshCredentials.refreshToken,
              accessToken: freshCredentials.accessToken,
              expiresAt: freshCredentials.expiresAt,
            });
          }
        }
      } else {
        await this.markAuthFailure(uuid, result, credentials);
        this.runtimeFactory?.invalidate(uuid);
      }

      return result;
    }
  };
}

function readAccountWideUsageTiers(usage: UsageLimits | undefined): ManagedUsageTier[] {
  if (!usage) return [];

  return [
    { key: "five_hour", tier: usage.five_hour },
    { key: "seven_day", tier: usage.seven_day },
  ].flatMap(({ key, tier }) =>
    tier == null
      ? []
      : [{
        key,
        utilization: tier.utilization,
        hasUtilization: normalizeUsagePercent(tier.utilization) !== undefined
          && isQuotaWindowActive(tier.resets_at),
        resetAt: tier.resets_at,
      }]
  );
}

function readStoredRateLimitRevision(
  account: Pick<StoredAccount, "rateLimitObservedAt">,
): RateLimitRevision | null {
  return account.rateLimitObservedAt === undefined
    ? null
    : account.rateLimitObservedAt as RateLimitRevision;
}

function nextRateLimitRevision(
  previous: number | undefined,
  now = Date.now(),
): RateLimitRevision {
  return Math.max(now, (previous ?? 0) + 1) as RateLimitRevision;
}

function getExhaustedAccountWideUsageResetAt(usage: UsageLimits, now: number): number | undefined {
  const resetTimes = [usage.five_hour, usage.seven_day]
    .flatMap((tier) => {
      if (tier == null || normalizeUsagePercent(tier.utilization) !== 100 || tier.resets_at == null) {
        return [];
      }
      if (!isQuotaWindowActive(tier.resets_at, now)) return [];
      return [Date.parse(tier.resets_at)];
    })
    .filter((resetAt) => Number.isFinite(resetAt) && resetAt > now);

  return resetTimes.length > 0 ? Math.max(...resetTimes) : undefined;
}

function getLegacyProviderCooldownUntil(account: StoredAccount, now: number): number | undefined {
  // The split cooldown/reset fields and revision token were introduced together.
  // A revision therefore identifies a modern reset that must not be reclassified.
  if (account.rateLimitObservedAt !== undefined) return undefined;
  const legacyResetAt = account.rateLimitResetAt;
  if (!legacyResetAt || legacyResetAt <= now) return undefined;

  const usageResetAt = account.cachedUsage
    ? getExhaustedAccountWideUsageResetAt(account.cachedUsage, now)
    : undefined;
  return usageResetAt === legacyResetAt ? undefined : legacyResetAt;
}

function readFutureResetAt(resetMs: number | undefined, now: number): number | undefined {
  return resetMs !== undefined && Number.isFinite(resetMs) && resetMs > 0
    ? now + resetMs
    : undefined;
}

function latestResetAt(...resetTimes: Array<number | undefined>): number | undefined {
  const activeResetTimes = resetTimes.filter((resetAt): resetAt is number => resetAt !== undefined);
  return activeResetTimes.length > 0 ? Math.max(...activeResetTimes) : undefined;
}

function readRoutingUsageTiers(usage: UsageLimits | undefined): ManagedUsageTier[] {
  if (!usage) return [];

  const sonnetTier = usage.seven_day_sonnet == null
    ? []
    : [{
      key: "seven_day_sonnet",
      utilization: usage.seven_day_sonnet.utilization,
      hasUtilization: normalizeUsagePercent(usage.seven_day_sonnet.utilization) !== undefined
        && isQuotaWindowActive(usage.seven_day_sonnet.resets_at),
      resetAt: usage.seven_day_sonnet.resets_at,
    }];

  return [...readAccountWideUsageTiers(usage), ...sonnetTier];
}
