import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import {
  readUsageRateLimitBoundary,
  shouldRecoverRateLimitStateAfterUsage,
} from "./account-state";
import type { ProviderId } from "./index";
import type { AccountFailureClass, AccountFailurePhase } from "./provider-executor";
import { Database } from "./sqlite";

export type AccountKind = "oauth";

declare const rateLimitRevisionBrand: unique symbol;
export type RateLimitRevision = number & { readonly [rateLimitRevisionBrand]: true };

export interface AccountRecord {
  id: string;
  provider: ProviderId;
  kind: AccountKind;
  name: string;
  enabled: boolean;
  credentials: Record<string, unknown>;
  metadata: Record<string, unknown>;
  failureCount: number;
  lastUsedAt?: string;
  lastErrorAt?: string;
  rateLimitResetAt?: string;
  rateLimitBlockedAt?: string;
  rateLimitCooldownUntil?: string;
  rateLimitObservedAt?: number;
  authCooldownUntil?: string;
  consecutiveAuthFailures: number;
  lastFailureClass?: AccountFailureClass;
  lastFailureCode?: string;
  lastFailureMessage?: string;
  lastFailurePhase?: AccountFailurePhase;
  reauthRequiredReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCreateInput {
  provider: ProviderId;
  kind: AccountKind;
  name?: string;
  enabled?: boolean;
  credentials?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AccountUpdateInput {
  name?: string;
  enabled?: boolean;
  credentials?: Record<string, unknown>;
  credentialsPatch?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  metadataPatch?: Record<string, unknown>;
  metadataMergePatch?: Record<string, unknown>;
  expectedCredentials?: Record<string, unknown>;
  refreshedCredentials?: Record<string, unknown>;
  usageSnapshotGuard?: {
    observedAt: number;
    cachedUsageAt?: number;
    rateLimitBlockedAt?: string;
    expectedRateLimitRevision: RateLimitRevision | null;
  };
  recoverRateLimitState?: boolean;
}

export function createAccountRefreshUpdate(
  account: Pick<
    AccountRecord,
    "credentials" | "metadata" | "rateLimitBlockedAt" | "rateLimitObservedAt"
  >,
  refreshed: {
    credentials?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
  options: {
    usageObservedAt?: number;
    recoverRateLimitState?: boolean;
  } = {},
): AccountUpdateInput {
  return {
    expectedCredentials: toPersistedRecordShape(account.credentials),
    ...(refreshed.credentials
      ? {
        refreshedCredentials: toPersistedRecordShape({
          ...account.credentials,
          ...refreshed.credentials,
        }),
      }
      : {}),
    ...(refreshed.credentials
      ? { credentialsPatch: changedRecordFields(account.credentials, refreshed.credentials) }
      : {}),
    ...(refreshed.metadata
      ? { metadataMergePatch: changedRecordFields(account.metadata, refreshed.metadata) }
      : {}),
    ...(options.usageObservedAt !== undefined
      ? {
        usageSnapshotGuard: {
          observedAt: options.usageObservedAt,
          cachedUsageAt: readMetadataUsageTimestamp(account.metadata),
          rateLimitBlockedAt: account.rateLimitBlockedAt,
          expectedRateLimitRevision: captureRateLimitRevision(account),
        },
      }
      : {}),
    ...(options.recoverRateLimitState ? { recoverRateLimitState: true } : {}),
  };
}

export interface AccountResetStateInput {
  enable?: boolean;
}

export type AccountSuccessInput =
  | { kind: "transport" }
  | { kind: "request"; expectedRateLimitRevision: RateLimitRevision | null }
  | { kind?: "manual"; expectedRateLimitRevision?: never };

export function captureRateLimitRevision(
  account: Pick<AccountRecord, "rateLimitObservedAt">,
): RateLimitRevision | null {
  return account.rateLimitObservedAt === undefined
    ? null
    : account.rateLimitObservedAt as RateLimitRevision;
}

export interface AccountStore {
  list(): Promise<AccountRecord[]>;
  get(id: string): Promise<AccountRecord | undefined>;
  listByProvider(provider: ProviderId): Promise<AccountRecord[]>;
  create(input: AccountCreateInput): Promise<AccountRecord>;
  update(id: string, input: AccountUpdateInput): Promise<AccountRecord | undefined>;
  resetState(id: string, input?: AccountResetStateInput): Promise<AccountRecord | undefined>;
  recordSuccess(id: string, input?: AccountSuccessInput): Promise<AccountRecord | undefined>;
  recordFailure(id: string, input: AccountFailureInput): Promise<AccountRecord | undefined>;
  delete(id: string): Promise<boolean>;
}

export interface AccountFailureInput {
  status: number;
  message?: string;
  metadata?: Record<string, unknown>;
  rateLimitResetAt?: string;
  rateLimitCooldownUntil?: string;
  failureClass?: AccountFailureClass;
  failureCode?: string;
  failurePhase?: AccountFailurePhase;
  reauthRequiredReason?: string;
}

export interface PublicAccountRecord {
  id: string;
  provider: ProviderId;
  kind: AccountKind;
  name: string;
  enabled: boolean;
  credentialKeys: string[];
  metadata: Record<string, unknown>;
  failureCount: number;
  lastUsedAt?: string;
  lastErrorAt?: string;
  rateLimitResetAt?: string;
  rateLimitBlockedAt?: string;
  rateLimitCooldownUntil?: string;
  authCooldownUntil?: string;
  consecutiveAuthFailures: number;
  lastFailureClass?: AccountFailureClass;
  lastFailureCode?: string;
  lastFailureMessage?: string;
  lastFailurePhase?: AccountFailurePhase;
  reauthRequiredReason?: string;
  createdAt: string;
  updatedAt: string;
}

export class MemoryAccountStore implements AccountStore {
  private readonly accounts = new Map<string, AccountRecord>();

  async list(): Promise<AccountRecord[]> {
    return [...this.accounts.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<AccountRecord | undefined> {
    return this.accounts.get(id);
  }

  async listByProvider(provider: ProviderId): Promise<AccountRecord[]> {
    return (await this.list()).filter((account) => account.provider === provider);
  }

  async create(input: AccountCreateInput): Promise<AccountRecord> {
    const account = createAccountRecord(input);
    this.accounts.set(account.id, account);
    return account;
  }

  async update(id: string, input: AccountUpdateInput): Promise<AccountRecord | undefined> {
    const existing = this.accounts.get(id);
    if (!existing) return undefined;
    if (!matchesCredentialPrecondition(existing.credentials, input)) return undefined;

    const updated = updateAccountRecord(existing, input);
    this.accounts.set(id, updated);
    return updated;
  }

  async resetState(
    id: string,
    input: AccountResetStateInput = {},
  ): Promise<AccountRecord | undefined> {
    const existing = this.accounts.get(id);
    if (!existing) return undefined;

    const updated = resetAccountState(existing, input);
    this.accounts.set(id, updated);
    return updated;
  }

  async recordSuccess(
    id: string,
    input: AccountSuccessInput = {},
  ): Promise<AccountRecord | undefined> {
    const existing = this.accounts.get(id);
    if (!existing) return undefined;

    const updated = recordAccountSuccess(existing, input);
    this.accounts.set(id, updated);
    return updated;
  }

  async recordFailure(
    id: string,
    input: AccountFailureInput,
  ): Promise<AccountRecord | undefined> {
    const existing = this.accounts.get(id);
    if (!existing) return undefined;

    const updated = recordAccountFailure(existing, input);
    this.accounts.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.accounts.delete(id);
  }
}

export class SQLiteAccountStore implements AccountStore {
  private readonly db: Database;

  constructor(path = defaultDatabasePath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      create table if not exists accounts (
        id text primary key,
        provider text not null,
        kind text not null,
        name text not null,
        enabled integer not null,
        credentials_json text not null,
        metadata_json text not null,
        failure_count integer not null default 0,
          last_used_at text,
          last_error_at text,
          rate_limit_reset_at text,
          rate_limit_blocked_at text,
          rate_limit_cooldown_until text,
          rate_limit_observed_at integer,
          auth_cooldown_until text,
        consecutive_auth_failures integer not null default 0,
        last_failure_class text,
        last_failure_code text,
        last_failure_message text,
        last_failure_phase text,
        reauth_required_reason text,
        created_at text not null,
        updated_at text not null
      );
    `);
    addColumnIfMissing(this.db, "failure_count", "integer not null default 0");
    addColumnIfMissing(this.db, "last_used_at", "text");
      addColumnIfMissing(this.db, "last_error_at", "text");
      addColumnIfMissing(this.db, "rate_limit_reset_at", "text");
      addColumnIfMissing(this.db, "rate_limit_blocked_at", "text");
      addColumnIfMissing(this.db, "rate_limit_cooldown_until", "text");
      addColumnIfMissing(this.db, "rate_limit_observed_at", "integer");
      addColumnIfMissing(this.db, "auth_cooldown_until", "text");
    addColumnIfMissing(this.db, "consecutive_auth_failures", "integer not null default 0");
    addColumnIfMissing(this.db, "last_failure_class", "text");
    addColumnIfMissing(this.db, "last_failure_code", "text");
    addColumnIfMissing(this.db, "last_failure_message", "text");
    addColumnIfMissing(this.db, "last_failure_phase", "text");
    addColumnIfMissing(this.db, "reauth_required_reason", "text");
  }

  async list(): Promise<AccountRecord[]> {
    const rows = this.db
      .query("select * from accounts order by created_at asc")
      .all() as AccountRow[];
    return rows.map(rowToAccount);
  }

  async get(id: string): Promise<AccountRecord | undefined> {
    return this.read(id);
  }

  private read(id: string): AccountRecord | undefined {
    const row = this.db
      .query("select * from accounts where id = ?")
      .get(id) as AccountRow | null;
    return row ? rowToAccount(row) : undefined;
  }

  async listByProvider(provider: ProviderId): Promise<AccountRecord[]> {
    const rows = this.db
      .query("select * from accounts where provider = ? order by created_at asc")
      .all(provider) as AccountRow[];
    return rows.map(rowToAccount);
  }

  async create(input: AccountCreateInput): Promise<AccountRecord> {
    const account = createAccountRecord(input);
    this.db
      .query(
        `insert into accounts (
          id, provider, kind, name, enabled,
          credentials_json, metadata_json, failure_count,
            last_used_at, last_error_at, rate_limit_reset_at,
            rate_limit_blocked_at, rate_limit_cooldown_until,
            rate_limit_observed_at,
            auth_cooldown_until, consecutive_auth_failures,
            last_failure_class, last_failure_code, last_failure_message, last_failure_phase,
            reauth_required_reason, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.id,
        account.provider,
        account.kind,
        account.name,
        account.enabled ? 1 : 0,
        JSON.stringify(account.credentials),
        JSON.stringify(account.metadata),
        account.failureCount,
          account.lastUsedAt ?? null,
          account.lastErrorAt ?? null,
          account.rateLimitResetAt ?? null,
          account.rateLimitBlockedAt ?? null,
          account.rateLimitCooldownUntil ?? null,
          account.rateLimitObservedAt ?? null,
          account.authCooldownUntil ?? null,
        account.consecutiveAuthFailures,
        account.lastFailureClass ?? null,
        account.lastFailureCode ?? null,
        account.lastFailureMessage ?? null,
        account.lastFailurePhase ?? null,
        account.reauthRequiredReason ?? null,
        account.createdAt,
        account.updatedAt,
      );
    return account;
  }

  async update(id: string, input: AccountUpdateInput): Promise<AccountRecord | undefined> {
    this.db.exec("begin immediate");
    try {
      const existing = this.read(id);
      if (!existing || !matchesCredentialPrecondition(existing.credentials, input)) {
        this.db.exec("commit");
        return undefined;
      }

      const updated = updateAccountRecord(existing, input);
      const result = this.db
        .query(
          `update accounts
            set name = ?,
                enabled = ?,
                credentials_json = ?,
                metadata_json = ?,
                updated_at = ?
            where id = ?`,
        )
        .run(
          updated.name,
          updated.enabled ? 1 : 0,
          JSON.stringify(updated.credentials),
          JSON.stringify(updated.metadata),
          updated.updatedAt,
          id,
        );
      if (result.changes > 0) this.persistAccountState(updated);
      this.db.exec("commit");
      return result.changes > 0 ? updated : undefined;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  async resetState(
    id: string,
    input: AccountResetStateInput = {},
  ): Promise<AccountRecord | undefined> {
    return this.mutateAccountState(id, (existing) => resetAccountState(existing, input));
  }

  async recordSuccess(
    id: string,
    input: AccountSuccessInput = {},
  ): Promise<AccountRecord | undefined> {
    return this.mutateAccountState(id, (existing) => recordAccountSuccess(existing, input));
  }

  async recordFailure(
    id: string,
    input: AccountFailureInput,
  ): Promise<AccountRecord | undefined> {
    return this.mutateAccountState(id, (existing) => recordAccountFailure(existing, input));
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.query("delete from accounts where id = ?").run(id);
    return result.changes > 0;
  }

  private mutateAccountState(
    id: string,
    mutate: (existing: AccountRecord) => AccountRecord,
  ): AccountRecord | undefined {
    this.db.exec("begin immediate");
    try {
      const existing = this.read(id);
      if (!existing) {
        this.db.exec("commit");
        return undefined;
      }
      const updated = mutate(existing);
      this.persistAccountState(updated);
      this.db.exec("commit");
      return updated;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private persistAccountState(account: AccountRecord): void {
    this.db
      .query(
        `update accounts
          set enabled = ?,
              metadata_json = ?,
              failure_count = ?,
                last_used_at = ?,
                last_error_at = ?,
                rate_limit_reset_at = ?,
                rate_limit_blocked_at = ?,
                rate_limit_cooldown_until = ?,
                rate_limit_observed_at = ?,
                auth_cooldown_until = ?,
              consecutive_auth_failures = ?,
              last_failure_class = ?,
              last_failure_code = ?,
              last_failure_message = ?,
              last_failure_phase = ?,
              reauth_required_reason = ?,
              updated_at = ?
          where id = ?`,
      )
      .run(
        account.enabled ? 1 : 0,
        JSON.stringify(account.metadata),
        account.failureCount,
          account.lastUsedAt ?? null,
          account.lastErrorAt ?? null,
          account.rateLimitResetAt ?? null,
          account.rateLimitBlockedAt ?? null,
          account.rateLimitCooldownUntil ?? null,
          account.rateLimitObservedAt ?? null,
          account.authCooldownUntil ?? null,
        account.consecutiveAuthFailures,
        account.lastFailureClass ?? null,
        account.lastFailureCode ?? null,
        account.lastFailureMessage ?? null,
        account.lastFailurePhase ?? null,
        account.reauthRequiredReason ?? null,
        account.updatedAt,
        account.id,
      );
  }
}

export function toPublicAccount(account: AccountRecord): PublicAccountRecord {
  return {
    id: account.id,
    provider: account.provider,
    kind: account.kind,
    name: account.name,
    enabled: account.enabled,
    credentialKeys: Object.keys(account.credentials),
    metadata: account.metadata,
    failureCount: account.failureCount,
      lastUsedAt: account.lastUsedAt,
      lastErrorAt: account.lastErrorAt,
      rateLimitResetAt: account.rateLimitResetAt,
      rateLimitBlockedAt: account.rateLimitBlockedAt,
      rateLimitCooldownUntil: account.rateLimitCooldownUntil,
      authCooldownUntil: account.authCooldownUntil,
    consecutiveAuthFailures: account.consecutiveAuthFailures,
    lastFailureClass: account.lastFailureClass,
    lastFailureCode: account.lastFailureCode,
    lastFailureMessage: account.lastFailureMessage,
    lastFailurePhase: account.lastFailurePhase,
    reauthRequiredReason: account.reauthRequiredReason,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export function defaultDatabasePath(): string {
  if (process.env.KYOLI_DATABASE_PATH) return process.env.KYOLI_DATABASE_PATH;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "kyoli-gam", "kyoli.db");
}

interface AccountRow {
  id: string;
  provider: ProviderId;
  kind: AccountKind;
  name: string;
  enabled: number;
  credentials_json: string;
  metadata_json: string;
  failure_count?: number;
  last_used_at?: string | null;
    last_error_at?: string | null;
    rate_limit_reset_at?: string | null;
    rate_limit_blocked_at?: string | null;
    rate_limit_cooldown_until?: string | null;
    rate_limit_observed_at?: number | null;
    auth_cooldown_until?: string | null;
  consecutive_auth_failures?: number;
  last_failure_class?: string | null;
  last_failure_code?: string | null;
  last_failure_message?: string | null;
  last_failure_phase?: string | null;
  reauth_required_reason?: string | null;
  created_at: string;
  updated_at: string;
}

function createAccountRecord(input: AccountCreateInput): AccountRecord {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    id,
    provider: input.provider,
    kind: input.kind,
    name: input.name ?? `${input.provider} ${input.kind}`,
    enabled: input.enabled ?? true,
    credentials: input.credentials ?? {},
    metadata: input.metadata ?? {},
    failureCount: 0,
    consecutiveAuthFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function updateAccountRecord(
  existing: AccountRecord,
  input: AccountUpdateInput,
): AccountRecord {
  const nowMs = Date.now();
  const previousUsageBoundary = readUsageRateLimitBoundary(existing.metadata, nowMs);
  const credentials = input.credentials ?? existing.credentials;
  const credentialsReplaced = input.credentials !== undefined
    && hasCredentialGenerationChanged(existing.credentials, input.credentials);
  const metadata = input.metadata ?? existing.metadata;
  const metadataPatched = input.metadataPatch
    ? { ...metadata, ...input.metadataPatch }
    : metadata;
  const hasConcurrentUsage = hasConcurrentUsageObservation(existing, input);
  const metadataMergePatch = input.metadataMergePatch && hasConcurrentUsage
    ? withoutUsageSnapshot(input.metadataMergePatch)
    : input.metadataMergePatch;
  const updated: AccountRecord = {
    ...existing,
    name: input.name ?? existing.name,
    enabled: input.enabled ?? existing.enabled,
    credentials: input.credentialsPatch
      ? { ...credentials, ...input.credentialsPatch }
      : credentials,
    metadata: metadataMergePatch
      ? applyRecordMergePatch(metadataPatched, metadataMergePatch)
      : metadataPatched,
    failureCount: existing.failureCount,
      lastUsedAt: existing.lastUsedAt,
      lastErrorAt: existing.lastErrorAt,
      rateLimitResetAt: existing.rateLimitResetAt,
      rateLimitBlockedAt: existing.rateLimitBlockedAt,
      rateLimitCooldownUntil: existing.rateLimitCooldownUntil,
      rateLimitObservedAt: existing.rateLimitObservedAt,
      authCooldownUntil: existing.authCooldownUntil,
    consecutiveAuthFailures: existing.consecutiveAuthFailures,
    lastFailureClass: existing.lastFailureClass,
    lastFailureCode: existing.lastFailureCode,
    lastFailureMessage: existing.lastFailureMessage,
    lastFailurePhase: existing.lastFailurePhase,
    reauthRequiredReason: existing.reauthRequiredReason,
    updatedAt: new Date(nowMs).toISOString(),
  };
  if (credentialsReplaced) {
    return recoverAccountRateLimitState(updated, { clearUsage: true, nowMs });
  }
  if (!input.usageSnapshotGuard || hasConcurrentUsage) return updated;
  if (input.recoverRateLimitState && shouldRecoverRateLimitStateAfterUsage(updated, nowMs)) {
    return recoverAccountRateLimitState(updated, { nowMs });
  }
  if (previousUsageBoundary !== readUsageRateLimitBoundary(updated.metadata, nowMs)) {
    updated.rateLimitObservedAt = nextRateLimitRevision(updated.rateLimitObservedAt, nowMs);
  }
  return updated;
}

function hasConcurrentUsageObservation(
  current: AccountRecord,
  input: AccountUpdateInput,
): boolean {
  const guard = input.usageSnapshotGuard;
  if (!guard) return false;

  if (captureRateLimitRevision(current) !== guard.expectedRateLimitRevision) return true;
  if (current.rateLimitBlockedAt !== guard.rateLimitBlockedAt) return true;

  const currentUsageAt = readMetadataUsageTimestamp(current.metadata);
  if (currentUsageAt !== guard.cachedUsageAt && currentUsageAt !== undefined && currentUsageAt >= guard.observedAt) {
    return true;
  }

  return false;
}

function withoutUsageSnapshot(metadata: Record<string, unknown>): Record<string, unknown> {
  const preserved = { ...metadata };
  delete preserved.cachedUsage;
  delete preserved.cachedUsageAt;
  delete preserved.usage;
  delete preserved.usageCachedAt;
  return preserved;
}

function hasCredentialGenerationChanged(
  existing: Record<string, unknown>,
  replacement: Record<string, unknown>,
): boolean {
  return !isDeepStrictEqual(
    toPersistedRecordShape({
      accessToken: existing.accessToken,
      refreshToken: existing.refreshToken,
    }),
    toPersistedRecordShape({
      accessToken: replacement.accessToken,
      refreshToken: replacement.refreshToken,
    }),
  );
}

function readMetadataUsageTimestamp(metadata: Record<string, unknown>): number | undefined {
  return readFiniteNumber(metadata.cachedUsageAt ?? metadata.usageCachedAt);
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function changedRecordFields(
  previous: Record<string, unknown>,
  refreshed: Record<string, unknown>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(refreshed)) {
    const previousValue = previous[key];
    if (isRecordValue(previousValue) && isRecordValue(value)) {
      const nested = changedRecordFields(previousValue, value);
      if (Object.keys(nested).length > 0) changed[key] = nested;
    } else if (!isDeepStrictEqual(previousValue, value)) {
      changed[key] = value;
    }
  }
  return changed;
}

function applyRecordMergePatch(
  previous: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete merged[key];
      continue;
    }
    if (isRecordValue(merged[key]) && isRecordValue(value)) {
      merged[key] = applyRecordMergePatch(merged[key] as Record<string, unknown>, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matchesCredentialPrecondition(
  current: Record<string, unknown>,
  input: AccountUpdateInput,
): boolean {
  if (!input.expectedCredentials) return true;
  const persistedCurrent = toPersistedRecordShape(current);
  return isDeepStrictEqual(persistedCurrent, toPersistedRecordShape(input.expectedCredentials))
    || (input.refreshedCredentials !== undefined
      && isDeepStrictEqual(
        persistedCurrent,
        toPersistedRecordShape(input.refreshedCredentials),
      ));
}

function toPersistedRecordShape(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function recordAccountSuccess(
  existing: AccountRecord,
  input: AccountSuccessInput,
): AccountRecord {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const clearsUsage = existing.rateLimitResetAt !== undefined
    || existing.rateLimitBlockedAt !== undefined
    || existing.rateLimitCooldownUntil !== undefined
    || readUsageRateLimitBoundary(existing.metadata, nowMs) !== "";
  const lostRateLimitRace = input.kind === "request"
    && captureRateLimitRevision(existing) !== input.expectedRateLimitRevision;
  if (input.kind === "transport" || lostRateLimitRace) {
    return {
      ...existing,
      lastUsedAt: now,
      updatedAt: now,
    };
  }

  return {
    ...existing,
    failureCount: 0,
    lastUsedAt: now,
    lastErrorAt: undefined,
    metadata: clearsUsage ? withoutUsageSnapshot(existing.metadata) : existing.metadata,
    rateLimitResetAt: undefined,
    rateLimitBlockedAt: undefined,
    rateLimitCooldownUntil: undefined,
    rateLimitObservedAt: clearsUsage
      ? nextRateLimitRevision(existing.rateLimitObservedAt, nowMs)
      : existing.rateLimitObservedAt,
    authCooldownUntil: undefined,
    consecutiveAuthFailures: 0,
    lastFailureClass: undefined,
    lastFailureCode: undefined,
    lastFailureMessage: undefined,
    lastFailurePhase: undefined,
    updatedAt: now,
  };
}

function resetAccountState(
  existing: AccountRecord,
  input: AccountResetStateInput,
): AccountRecord {
  const nowMs = Date.now();
  return {
    ...existing,
    enabled: input.enable ? true : existing.enabled,
    failureCount: 0,
    lastErrorAt: undefined,
    metadata: withoutUsageSnapshot(existing.metadata),
    rateLimitResetAt: undefined,
    rateLimitBlockedAt: undefined,
    rateLimitCooldownUntil: undefined,
    rateLimitObservedAt: nextRateLimitRevision(existing.rateLimitObservedAt, nowMs),
    authCooldownUntil: undefined,
    consecutiveAuthFailures: 0,
    lastFailureClass: undefined,
    lastFailureCode: undefined,
    lastFailureMessage: undefined,
    lastFailurePhase: undefined,
    reauthRequiredReason: undefined,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function recoverAccountRateLimitState(
  existing: AccountRecord,
  options: { clearUsage?: boolean; nowMs?: number } = {},
): AccountRecord {
  const nowMs = options.nowMs ?? Date.now();
  const recoveringRateLimitFailure = existing.lastFailureClass === "rate_limit"
    || existing.lastFailureClass === "quota";
  return {
    ...existing,
    metadata: options.clearUsage ? withoutUsageSnapshot(existing.metadata) : existing.metadata,
    failureCount: recoveringRateLimitFailure ? 0 : existing.failureCount,
    lastErrorAt: recoveringRateLimitFailure ? undefined : existing.lastErrorAt,
    rateLimitResetAt: undefined,
    rateLimitBlockedAt: undefined,
    rateLimitCooldownUntil: undefined,
    rateLimitObservedAt: nextRateLimitRevision(existing.rateLimitObservedAt, nowMs),
    lastFailureClass: recoveringRateLimitFailure ? undefined : existing.lastFailureClass,
    lastFailureCode: recoveringRateLimitFailure ? undefined : existing.lastFailureCode,
    lastFailureMessage: recoveringRateLimitFailure ? undefined : existing.lastFailureMessage,
    lastFailurePhase: recoveringRateLimitFailure ? undefined : existing.lastFailurePhase,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function nextRateLimitRevision(
  previous: number | undefined,
  nowMs = Date.now(),
): RateLimitRevision {
  return Math.max(nowMs, (previous ?? 0) + 1) as RateLimitRevision;
}

function recordAccountFailure(
  existing: AccountRecord,
  input: AccountFailureInput,
): AccountRecord {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const authFailure = input.status === 401 || input.status === 403;
  const rateLimitFailure = input.status === 429;
  const consecutiveAuthFailures = authFailure
    ? existing.consecutiveAuthFailures + 1
    : existing.consecutiveAuthFailures;
  const reauthRequiredReason = input.reauthRequiredReason ?? existing.reauthRequiredReason;
  const preserveExistingReauthFailure = Boolean(existing.reauthRequiredReason && !input.reauthRequiredReason);

  return {
    ...existing,
    enabled: reauthRequiredReason ? false : existing.enabled,
    metadata: input.metadata ? { ...existing.metadata, ...input.metadata } : existing.metadata,
    failureCount: existing.failureCount + 1,
    lastErrorAt: now,
    rateLimitResetAt: rateLimitFailure ? input.rateLimitResetAt : existing.rateLimitResetAt,
    rateLimitBlockedAt: rateLimitFailure ? now : existing.rateLimitBlockedAt,
    rateLimitCooldownUntil: rateLimitFailure
      ? input.rateLimitCooldownUntil ?? input.rateLimitResetAt
      : existing.rateLimitCooldownUntil,
    rateLimitObservedAt: rateLimitFailure
      ? nextRateLimitRevision(existing.rateLimitObservedAt, nowMs)
      : existing.rateLimitObservedAt,
    lastFailureClass: preserveExistingReauthFailure
      ? existing.lastFailureClass ?? input.failureClass ?? failureClassFromStatus(input.status)
      : input.failureClass ?? failureClassFromStatus(input.status),
    lastFailureCode: preserveExistingReauthFailure
      ? existing.lastFailureCode ?? input.failureCode
      : input.failureCode,
    lastFailureMessage: preserveExistingReauthFailure
      ? existing.lastFailureMessage ?? input.message
      : input.message,
    lastFailurePhase: preserveExistingReauthFailure
      ? existing.lastFailurePhase ?? input.failurePhase
      : input.failurePhase,
    authCooldownUntil: reauthRequiredReason
      ? undefined
      : authFailure
        ? calculateAuthCooldownUntil(consecutiveAuthFailures)
        : existing.authCooldownUntil,
    consecutiveAuthFailures,
    reauthRequiredReason,
    updatedAt: now,
  };
}

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled === 1,
    credentials: parseJsonRecord(row.credentials_json),
    metadata: parseJsonRecord(row.metadata_json),
    failureCount: row.failure_count ?? 0,
    lastUsedAt: row.last_used_at ?? undefined,
      lastErrorAt: row.last_error_at ?? undefined,
      rateLimitResetAt: row.rate_limit_reset_at ?? undefined,
      rateLimitBlockedAt: row.rate_limit_blocked_at ?? undefined,
      rateLimitCooldownUntil: row.rate_limit_cooldown_until ?? undefined,
      rateLimitObservedAt: row.rate_limit_observed_at ?? undefined,
      authCooldownUntil: row.auth_cooldown_until ?? undefined,
    consecutiveAuthFailures: row.consecutive_auth_failures ?? 0,
    lastFailureClass: readFailureClass(row.last_failure_class),
    lastFailureCode: row.last_failure_code ?? undefined,
    lastFailureMessage: row.last_failure_message ?? undefined,
    lastFailurePhase: readFailurePhase(row.last_failure_phase),
    reauthRequiredReason: row.reauth_required_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function calculateAuthCooldownUntil(consecutiveAuthFailures: number): string {
  const baseMs = 60_000;
  const maxMs = 30 * 60_000;
  const exponent = Math.max(0, consecutiveAuthFailures - 1);
  const delayMs = Math.min(maxMs, baseMs * 2 ** exponent);
  return new Date(Date.now() + delayMs).toISOString();
}

function failureClassFromStatus(status: number): AccountFailureClass | undefined {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "transient";
  return undefined;
}

function readFailureClass(value: unknown): AccountFailureClass | undefined {
  return value === "rate_limit" ||
    value === "quota" ||
    value === "auth" ||
    value === "permanent" ||
    value === "transient" ||
    value === "neutral"
    ? value
    : undefined;
}

function readFailurePhase(value: unknown): AccountFailurePhase | undefined {
  return value === "connect" ||
    value === "headers" ||
    value === "startup" ||
    value === "mid_stream" ||
    value === "terminal"
    ? value
    : undefined;
}

function addColumnIfMissing(db: Database, column: string, definition: string): void {
  try {
    db.exec(`alter table accounts add column ${column} ${definition}`);
  } catch {
    // SQLite throws when the column already exists. That is the desired steady state.
  }
}
