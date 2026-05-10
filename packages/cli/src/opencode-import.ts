import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountStore, ProviderId } from "@kyoli-gam/core";
import { loadClaudeCodeIdentity, type ClaudeCodeIdentity } from "@kyoli-gam/provider-claude-code";

export type OpenCodeImportProvider = "all" | "codex" | "claude-code";

export interface OpenCodeImportOptions {
  dryRun?: boolean;
  provider?: OpenCodeImportProvider;
  configDir?: string;
  claudeIdentity?: ClaudeCodeIdentity;
}

export interface OpenCodeImportResult {
  created: number;
  duplicates: number;
  skipped: number;
  sources: Array<{
    provider: ProviderId;
    path: string;
    total: number;
    eligible: number;
    created: number;
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
      if (await hasDuplicateAccount(store, source.provider, normalized)) {
        sourceResult.duplicates += 1;
        result.duplicates += 1;
        continue;
      }

      if (!options.dryRun) {
        const providerAccountId = source.provider === "claude-code"
          ? normalized.accountId ?? normalized.uuid
          : normalized.accountId;
        await store.create({
          provider: source.provider,
          kind: "oauth",
          name: normalized.email
            ? `${source.provider === "codex" ? "Codex" : "Claude"} ${normalized.email}`
            : `${source.provider} ${normalized.uuid}`,
          credentials: {
            accessToken: normalized.accessToken,
            refreshToken: normalized.refreshToken,
            expiresAt: normalized.expiresAt,
            accountId: providerAccountId,
          },
          metadata: {
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
          },
        });
      }

      sourceResult.created += 1;
      result.created += 1;
    }

    result.sources.push(sourceResult);
  }

  return result;
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

async function hasDuplicateAccount(
  store: AccountStore,
  provider: ProviderId,
  account: { uuid: string; accountId?: string; email?: string },
): Promise<boolean> {
  const existing = await store.listByProvider(provider);
  return existing.some((stored) =>
    stored.metadata.sourceUuid === account.uuid ||
    (account.accountId && (
      stored.metadata.accountId === account.accountId ||
      stored.credentials.accountId === account.accountId
    )) ||
    (account.email && stored.metadata.email === account.email)
  );
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
