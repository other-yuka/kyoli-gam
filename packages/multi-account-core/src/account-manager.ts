import { randomUUID } from "node:crypto";
import { readClaims, writeClaim, isClaimedByOther, type ClaimsMap } from "./claims";
import { getConfig } from "./config";
import type { AccountStore } from "./account-store";
import type {
  ManagedAccount,
  OAuthCredentials,
  PluginClient,
  StoredAccount,
  TokenRefreshResult,
  UsageLimits,
} from "./types";

const STARTUP_REFRESH_CONCURRENCY = 3;
const RECENT_429_COOLDOWN_MS = 30_000;
const HYBRID_SWITCH_MARGIN = 40;

export interface ProfileData {
  email?: string;
  planTier: string;
}

export interface RuntimeFactoryLike {
  invalidate(uuid: string): void;
}

export interface AccountManagerDependencies {
  providerAuthId: string;
  isTokenExpired: (account: Pick<ManagedAccount, "accessToken" | "expiresAt">) => boolean;
  refreshToken: (
    currentRefreshToken: string,
    accountId: string,
    client: PluginClient,
  ) => Promise<TokenRefreshResult>;
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
  selectAccount(): Promise<ManagedAccount | null>;
  markRateLimited(uuid: string, backoffMs?: number): Promise<void>;
  markRevoked(uuid: string): Promise<void>;
  markSuccess(uuid: string): Promise<void>;
  markAuthFailure(uuid: string, result: TokenRefreshResult): Promise<void>;
  applyUsageCache(uuid: string, usage: UsageLimits): Promise<void>;
  applyProfileCache(uuid: string, profile: ProfileData): Promise<void>;
  ensureValidToken(uuid: string, client: PluginClient): Promise<TokenRefreshResult>;
  validateNonActiveTokens(client: PluginClient): Promise<void>;
  removeAccount(index: number): Promise<boolean>;
  clearAllAccounts(): Promise<void>;
  addAccount(auth: OAuthCredentials): Promise<void>;
  toggleEnabled(uuid: string): Promise<void>;
  replaceAccountCredentials(uuid: string, auth: OAuthCredentials): Promise<void>;
  retryAuth(uuid: string, client: PluginClient): Promise<TokenRefreshResult>;
}

export interface AccountManagerClass {
  new (store: AccountStore): AccountManagerInstance;
  create(store: AccountStore, currentAuth: OAuthCredentials, client?: PluginClient): Promise<AccountManagerInstance>;
}

export function createAccountManagerForProvider(dependencies: AccountManagerDependencies): AccountManagerClass {
  const {
    providerAuthId,
    isTokenExpired,
    refreshToken,
  } = dependencies;

  return class AccountManager {
    private cached: ManagedAccount[] = [];
    private activeAccountUuid?: string;
    private client: PluginClient | null = null;
    private runtimeFactory: RuntimeFactoryLike | null = null;
    private roundRobinCursor = 0;
    private last429Map = new Map<string, number>();

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
        cachedUsage: storedAccount.cachedUsage,
        cachedUsageAt: storedAccount.cachedUsageAt,
        consecutiveAuthFailures: storedAccount.consecutiveAuthFailures,
        isAuthDisabled: storedAccount.isAuthDisabled,
        authDisabledReason: storedAccount.authDisabledReason,
        last429At: storedAccount.uuid ? this.last429Map.get(storedAccount.uuid) : undefined,
      };
    }

    private createNewAccount(auth: OAuthCredentials, now: number): StoredAccount {
      return {
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
      const threshold = getConfig().soft_quota_threshold_percent;
      if (threshold >= 100) return false;

      const usage = account.cachedUsage;
      if (!usage) return false;

      const tiers = [usage.five_hour, usage.seven_day];
      return tiers.some((tier) => tier != null && tier.utilization >= threshold);
    }

    hasAnyUsableAccount(): boolean {
      return this.getEligibleAccounts().length > 0;
    }

    isRateLimited(account: ManagedAccount): boolean {
      if (account.rateLimitResetAt && Date.now() < account.rateLimitResetAt) {
        return true;
      }
      return this.isUsageExhausted(account);
    }

    private isUsageExhausted(account: ManagedAccount): boolean {
      const usage = account.cachedUsage;
      if (!usage) return false;

      const now = Date.now();
      const tiers = [usage.five_hour, usage.seven_day];
      return tiers.some((tier) =>
        tier != null
        && tier.utilization >= 100
        && tier.resets_at != null
        && Date.parse(tier.resets_at) > now,
      );
    }

    clearExpiredRateLimits(): void {
      const now = Date.now();
      for (const account of this.cached) {
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
        if (account.rateLimitResetAt) {
          const ms = account.rateLimitResetAt - now;
          if (ms > 0) waits.push(ms);
        }

        const usageResetMs = this.getUsageResetMs(account);
        if (usageResetMs !== null && usageResetMs > 0) {
          waits.push(usageResetMs);
        }
      }

      return waits.length > 0 ? Math.min(...waits) : 0;
    }

    private getUsageResetMs(account: ManagedAccount): number | null {
      const usage = account.cachedUsage;
      if (!usage) return null;

      const now = Date.now();
      const candidates: number[] = [];
      const tiers = [usage.five_hour, usage.seven_day];

      for (const tier of tiers) {
        if (tier != null && tier.utilization >= 100 && tier.resets_at != null) {
          const ms = Date.parse(tier.resets_at) - now;
          if (ms > 0) candidates.push(ms);
        }
      }

      return candidates.length > 0 ? Math.min(...candidates) : null;
    }

    async selectAccount(): Promise<ManagedAccount | null> {
      await this.refresh();
      this.clearExpiredRateLimits();

      const eligible = this.getEligibleAccounts();
      if (eligible.length === 0) return null;

      const config = getConfig();
      const claims = config.cross_process_claims ? await readClaims() : {};

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
          selected = this.selectSticky(eligible, claims);
          break;
      }

      if (selected?.uuid) {
        this.activeAccountUuid = selected.uuid;
        this.store.setActiveUuid(selected.uuid).catch(() => {});
      }

      if (config.cross_process_claims && selected?.uuid) {
        writeClaim(selected.uuid).catch(() => {});
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

    private selectSticky(eligible: ManagedAccount[], claims: ClaimsMap): ManagedAccount | null {
      const current = this.getActiveAccount();
      if (current?.enabled && !current.isAuthDisabled && this.isUsable(current)) {
        this.activateAccount(current);
        return current;
      }

      const unclaimed = eligible.find(
        (account) => this.isUsable(account) && !isClaimedByOther(claims, account.uuid),
      );
      if (unclaimed) {
        this.activateAccount(unclaimed);
        return unclaimed;
      }

      const available = eligible.find((account) => this.isUsable(account));
      if (available) {
        this.activateAccount(available);
        return available;
      }

      return this.fallbackNotRateLimited(eligible);
    }

    private selectRoundRobin(eligible: ManagedAccount[], claims: ClaimsMap): ManagedAccount | null {
      for (let i = 0; i < eligible.length; i++) {
        const index = (this.roundRobinCursor + i) % eligible.length;
        const account = eligible[index]!;
        if (this.isUsable(account) && !isClaimedByOther(claims, account.uuid)) {
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

      const maxFailures = Math.max(1, getConfig().max_consecutive_auth_failures);
      const healthScore = Math.max(0, ((maxFailures - account.consecutiveAuthFailures) / maxFailures) * 250);

      const secondsSinceUsed = (Date.now() - account.lastUsed) / 1000;
      const freshnessScore = (Math.min(secondsSinceUsed, 900) / 900) * 60;

      const stickinessBonus = isActive ? 120 : 0;
      const claimPenalty = isClaimedByOther(claims, account.uuid) ? -200 : 0;

      return usageScore + healthScore + freshnessScore + stickinessBonus + claimPenalty;
    }

    private getMaxUtilization(account: ManagedAccount): number {
      const usage = account.cachedUsage;
      if (!usage) return 65;

      const tiers = [usage.five_hour, usage.seven_day];
      const utilizations = tiers
        .filter((tier): tier is NonNullable<typeof tier> => tier != null)
        .map((tier) => tier.utilization);

      return utilizations.length > 0 ? Math.max(...utilizations) : 65;
    }

    private activateAccount(account: ManagedAccount): void {
      this.activeAccountUuid = account.uuid;
      account.lastUsed = Date.now();
    }

    async markRateLimited(uuid: string, backoffMs?: number): Promise<void> {
      const effectiveBackoff = backoffMs ?? getConfig().rate_limit_min_backoff_ms;
      this.last429Map.set(uuid, Date.now());
      await this.store.mutateAccount(uuid, (account) => {
        account.rateLimitResetAt = Date.now() + effectiveBackoff;
      });
    }

    async markRevoked(uuid: string): Promise<void> {
      await this.store.mutateAccount(uuid, (account) => {
        account.isAuthDisabled = true;
        account.authDisabledReason = "OAuth token revoked (403)";
        account.accessToken = undefined;
        account.expiresAt = undefined;
      });
      this.runtimeFactory?.invalidate(uuid);
    }

    async markSuccess(uuid: string): Promise<void> {
      this.last429Map.delete(uuid);
      await this.store.mutateAccount(uuid, (account) => {
        account.rateLimitResetAt = undefined;
        account.consecutiveAuthFailures = 0;
        account.lastUsed = Date.now();
      });
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

    async markAuthFailure(uuid: string, result: TokenRefreshResult): Promise<void> {
      await this.store.mutateStorage((storage) => {
        const account = storage.accounts.find((entry) => entry.uuid === uuid);
        if (!account) return;

        if (!result.ok && result.permanent) {
          account.isAuthDisabled = true;
          account.authDisabledReason = "Token permanently rejected (400/401/403)";
          return;
        }

        account.consecutiveAuthFailures = (account.consecutiveAuthFailures ?? 0) + 1;
        const maxFailures = getConfig().max_consecutive_auth_failures;
        const usableCount = storage.accounts.filter(
          (entry) => entry.enabled && !entry.isAuthDisabled && entry.uuid !== uuid,
        ).length;

        if (account.consecutiveAuthFailures >= maxFailures && usableCount > 0) {
          account.isAuthDisabled = true;
          account.authDisabledReason = `${maxFailures} consecutive auth failures`;
        }
      });
    }

    async applyUsageCache(uuid: string, usage: UsageLimits): Promise<void> {
      await this.store.mutateAccount(uuid, (account) => {
        const now = Date.now();
        const exhaustedTierResetTimes = [usage.five_hour, usage.seven_day]
          .flatMap((tier) => {
            if (tier == null || tier.utilization < 100 || tier.resets_at == null) {
              return [];
            }
            return [Date.parse(tier.resets_at)];
          })
          .filter((resetAt) => Number.isFinite(resetAt) && resetAt > now);

        account.cachedUsage = usage;
        account.cachedUsageAt = Date.now();
        account.rateLimitResetAt = exhaustedTierResetTimes.length > 0
          ? Math.min(...exhaustedTierResetTimes)
          : undefined;
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

      const result = await refreshToken(credentials.refreshToken, uuid, client);
      if (!result.ok) return result;

      const updated = await this.store.mutateAccount(uuid, (account) => {
        account.accessToken = result.patch.accessToken;
        account.expiresAt = result.patch.expiresAt;
        if (result.patch.refreshToken) account.refreshToken = result.patch.refreshToken;
        if (result.patch.uuid && result.patch.uuid !== uuid) account.uuid = result.patch.uuid;
        if (result.patch.accountId) account.accountId = result.patch.accountId;
        if (result.patch.email) account.email = result.patch.email;
        account.consecutiveAuthFailures = 0;
        account.isAuthDisabled = false;
        account.authDisabledReason = undefined;
      });

      if (result.patch.uuid && result.patch.uuid !== uuid && this.activeAccountUuid === uuid) {
        this.activeAccountUuid = result.patch.uuid;
        this.store.setActiveUuid(result.patch.uuid).catch(() => {});
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
              await this.markAuthFailure(account.uuid, result);
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
        await this.refresh();
      }
      return removed;
    }

    async clearAllAccounts(): Promise<void> {
      await this.store.clear();
      this.cached = [];
      this.activeAccountUuid = undefined;
    }

    async addAccount(auth: OAuthCredentials): Promise<void> {
      if (!auth.refresh) return;

      const existing = this.cached.find((account) => account.refreshToken === auth.refresh);
      if (existing) return;

      const newAccount = this.createNewAccount(auth, Date.now());
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

    async replaceAccountCredentials(uuid: string, auth: OAuthCredentials): Promise<void> {
      const updated = await this.store.mutateAccount(uuid, (account) => {
        account.refreshToken = auth.refresh;
        account.accessToken = auth.access;
        account.expiresAt = auth.expires;
        account.lastUsed = Date.now();
        account.enabled = true;
        account.isAuthDisabled = false;
        account.authDisabledReason = undefined;
        account.consecutiveAuthFailures = 0;
        account.rateLimitResetAt = undefined;
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

      const result = await refreshToken(credentials.refreshToken, uuid, client);
      if (result.ok) {
        const updated = await this.store.mutateAccount(uuid, (account) => {
          account.accessToken = result.patch.accessToken;
          account.expiresAt = result.patch.expiresAt;
          if (result.patch.refreshToken) account.refreshToken = result.patch.refreshToken;
          if (result.patch.uuid) account.uuid = result.patch.uuid;
          if (result.patch.accountId) account.accountId = result.patch.accountId;
          if (result.patch.email) account.email = result.patch.email;
          account.enabled = true;
          account.consecutiveAuthFailures = 0;
        });
        this.runtimeFactory?.invalidate(uuid);
        if (result.patch.uuid) {
          this.runtimeFactory?.invalidate(result.patch.uuid);
        }

        const nextUuid = result.patch.uuid ?? uuid;
        if (this.activeAccountUuid === uuid && result.patch.uuid && result.patch.uuid !== uuid) {
          this.activeAccountUuid = result.patch.uuid;
          await this.store.setActiveUuid(result.patch.uuid);
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
        await this.markAuthFailure(uuid, result);
        this.runtimeFactory?.invalidate(uuid);
      }

      return result;
    }
  };
}
