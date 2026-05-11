import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountRecord, AccountStore, ProviderId } from "@kyoli-gam/core";
import { loadClaudeCodeIdentity, type ClaudeCodeIdentity } from "@kyoli-gam/provider-claude-code";

export type OpenCodeImportProvider = "all" | "codex" | "claude-code";

export interface OpenCodeImportOptions {
  dryRun?: boolean;
  provider?: OpenCodeImportProvider;
  configDir?: string;
  claudeIdentity?: ClaudeCodeIdentity;
  sync?: boolean;
}

export interface OpenCodeImportResult {
  created: number;
  updated: number;
  unchanged: number;
  duplicates: number;
  skipped: number;
  sources: Array<{
    provider: ProviderId;
    path: string;
    total: number;
    eligible: number;
    created: number;
    updated: number;
    unchanged: number;
    duplicates: number;
    skipped: number;
  }>;
}

interface OpenCodeStoredAccount {
  uuid?: unknown;
  accountId?: unknown;
  email?: unknown;
  planTier?: unknown;
  refreshToken?: unknown;
  accessToken?: unknown;
  expiresAt?: unknown;
  addedAt?: unknown;
  lastUsed?: unknown;
  enabled?: unknown;
  rateLimitResetAt?: unknown;
  cachedUsage?: unknown;
  cachedUsageAt?: unknown;
  consecutiveAuthFailures?: unknown;
  isAuthDisabled?: unknown;
}

interface OpenCodeStorage {
  accounts?: unknown;
}

const PROVIDER_SOURCES: Array<{
  provider: Exclude<OpenCodeImportProvider, "all">;
  filename: string;
  source: string;
}> = [
  {
    provider: "codex",
    filename: "openai-multi-account-accounts.json",
    source: "opencode-openai-multi-account",
  },
  {
    provider: "claude-code",
    filename: "anthropic-multi-account-accounts.json",
    source: "opencode-anthropic-multi-account",
  },
];

export async function importOpenCodeAccounts(
  store: AccountStore,
  options: OpenCodeImportOptions = {},
): Promise<OpenCodeImportResult> {
  const provider = options.provider ?? "all";
  const configDir = expandHome(options.configDir ?? join("~", ".config", "opencode"));
  const claudeIdentity = shouldImportClaude(provider)
    ? options.claudeIdentity ?? loadClaudeCodeIdentity()
    : undefined;
  const sources = PROVIDER_SOURCES.filter((source) =>
    provider === "all" || source.provider === provider
  );
  const result: OpenCodeImportResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    duplicates: 0,
    skipped: 0,
    sources: [],
  };

  for (const source of sources) {
    const path = join(configDir, source.filename);
    const accounts = await readOpenCodeAccounts(path);
    const sourceResult = {
      provider: source.provider as ProviderId,
      path,
      total: accounts.length,
      eligible: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      duplicates: 0,
      skipped: 0,
    };

    for (const account of accounts) {
      const normalized = normalizeOpenCodeAccount(account);
      if (!normalized) {
        sourceResult.skipped += 1;
        result.skipped += 1;
        continue;
      }

      sourceResult.eligible += 1;
      const existing = await findMatchingAccount(store, source.provider, normalized);
      if (existing) {
        if (options.sync) {
          const input = createAccountInput(source, normalized, claudeIdentity);
          const needsUpdate = shouldUpdateAccount(existing, input);
          const shouldResetState = shouldResetSyncedAccountState(existing, input);
          if (needsUpdate || shouldResetState) {
            if (!options.dryRun) {
              await store.update(existing.id, {
                name: input.name,
                credentials: input.credentials,
                metadata: { ...existing.metadata, ...input.metadata },
              });
              if (shouldResetState) {
                await store.resetState(existing.id, {
                  enable: Boolean(existing.reauthRequiredReason) || existing.enabled,
                });
              }
            }
            sourceResult.updated += 1;
            result.updated += 1;
          } else {
            sourceResult.unchanged += 1;
            result.unchanged += 1;
          }
          continue;
        }

        sourceResult.duplicates += 1;
        result.duplicates += 1;
        continue;
      }

      if (!options.dryRun) {
        await store.create(createAccountInput(source, normalized, claudeIdentity));
      }

      sourceResult.created += 1;
      result.created += 1;
    }

    result.sources.push(sourceResult);
  }

  return result;
}

function createAccountInput(
  source: (typeof PROVIDER_SOURCES)[number],
  normalized: NonNullable<ReturnType<typeof normalizeOpenCodeAccount>>,
  claudeIdentity: ClaudeCodeIdentity | undefined,
) {
  const providerAccountId = source.provider === "claude-code"
    ? normalized.accountId ?? normalized.uuid
    : normalized.accountId;
  return {
    provider: source.provider,
    kind: "oauth" as const,
    name: normalized.email
      ? `${source.provider === "codex" ? "Codex" : "Claude"} ${normalized.email}`
      : `${source.provider} ${normalized.uuid}`,
    credentials: compactRecord({
      accessToken: normalized.accessToken,
      refreshToken: normalized.refreshToken,
      expiresAt: normalized.expiresAt,
      accountId: providerAccountId,
    }),
    metadata: compactRecord({
      source: source.source,
      sourceUuid: normalized.uuid,
      email: normalized.email,
      accountId: providerAccountId,
      deviceId: source.provider === "claude-code" ? claudeIdentity?.deviceId : undefined,
      localAccountUuid: source.provider === "claude-code" ? claudeIdentity?.accountUuid : undefined,
      planTier: normalized.planTier,
      cachedUsage: normalized.cachedUsage,
      cachedUsageAt: normalized.cachedUsageAt,
      addedAt: normalized.addedAt,
      lastUsed: normalized.lastUsed,
      rateLimitResetAt: normalized.rateLimitResetAt,
    }),
  };
}

function shouldImportClaude(provider: OpenCodeImportProvider): boolean {
  return provider === "all" || provider === "claude-code";
}

async function readOpenCodeAccounts(path: string): Promise<OpenCodeStoredAccount[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as OpenCodeStorage;
    return Array.isArray(parsed.accounts)
      ? (parsed.accounts.filter(isRecord) as OpenCodeStoredAccount[])
      : [];
  } catch {
    return [];
  }
}

function normalizeOpenCodeAccount(account: OpenCodeStoredAccount): {
  uuid: string;
  accountId?: string;
  email?: string;
  planTier?: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  addedAt?: number;
  lastUsed?: number;
  rateLimitResetAt?: number;
  cachedUsage?: unknown;
  cachedUsageAt?: number;
} | undefined {
  const uuid = readString(account.uuid);
  const refreshToken = readString(account.refreshToken);
  const accessToken = readString(account.accessToken);
  const expiresAt = readNumber(account.expiresAt);
  if (!uuid || !refreshToken || !accessToken || !expiresAt) return undefined;
  if (account.enabled !== true || account.isAuthDisabled === true) return undefined;

  return {
    uuid,
    accountId: readString(account.accountId),
    email: readString(account.email),
    planTier: readString(account.planTier),
    refreshToken,
    accessToken,
    expiresAt,
    addedAt: readNumber(account.addedAt),
    lastUsed: readNumber(account.lastUsed),
    rateLimitResetAt: readNumber(account.rateLimitResetAt),
    cachedUsage: account.cachedUsage,
    cachedUsageAt: readNumber(account.cachedUsageAt),
  };
}

async function findMatchingAccount(
  store: AccountStore,
  provider: ProviderId,
  account: { uuid: string; accountId?: string; email?: string },
): Promise<AccountRecord | undefined> {
  const existing = await store.listByProvider(provider);
  return existing.find((stored) =>
    stored.metadata.sourceUuid === account.uuid ||
    (account.accountId && (
      stored.metadata.accountId === account.accountId ||
      stored.credentials.accountId === account.accountId
    )) ||
    (account.email && stored.metadata.email === account.email)
  );
}

function shouldUpdateAccount(
  existing: AccountRecord,
  input: ReturnType<typeof createAccountInput>,
): boolean {
  return existing.name !== input.name ||
    !sameJson(existing.credentials, input.credentials) ||
    !sameJson(existing.metadata, { ...existing.metadata, ...input.metadata });
}

function shouldResetSyncedAccountState(
  existing: AccountRecord,
  input: ReturnType<typeof createAccountInput>,
): boolean {
  const tokenChanged = existing.credentials.accessToken !== input.credentials.accessToken ||
    existing.credentials.refreshToken !== input.credentials.refreshToken ||
    existing.credentials.expiresAt !== input.credentials.expiresAt;
  return Boolean(tokenChanged || existing.authCooldownUntil || existing.reauthRequiredReason);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
