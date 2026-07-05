import type { AccountRecord, AccountStore } from "@kyoli-gam/core";
import type { CodexOAuthTokens } from "@kyoli-gam/provider-codex-chatgpt";

export type AccountReconcileAction = "created" | "updated";

export interface AccountReconcileResult {
  action: AccountReconcileAction;
  account: AccountRecord;
  matchedBy?: "account" | "accountId" | "email";
}

export interface CodexAccountReconcileOptions {
  accountId?: string;
  force?: boolean;
}

export async function reconcileCodexOAuthAccount(
  store: AccountStore,
  tokens: CodexOAuthTokens,
  options: CodexAccountReconcileOptions = {},
): Promise<AccountReconcileResult> {
  const explicitAccount = options.accountId
    ? await requireCodexAccount(store, options.accountId)
    : undefined;
  const matched = explicitAccount
    ? { account: explicitAccount, matchedBy: "account" as const }
    : await findExistingCodexAccount(store, tokens);

  if (!matched) {
    return {
      action: "created",
      account: await store.create(createCodexAccountInput(tokens)),
    };
  }

  assertCompatibleCodexIdentity(matched.account, tokens, Boolean(options.force));
  const updated = await replaceCodexAccountCredentials(store, matched.account, tokens, {
    enable: matched.matchedBy === "account" || Boolean(matched.account.reauthRequiredReason) || matched.account.enabled,
  });
  return {
    action: "updated",
    account: updated,
    matchedBy: matched.matchedBy,
  };
}

async function requireCodexAccount(store: AccountStore, id: string): Promise<AccountRecord> {
  const account = await store.get(id);
  if (!account) throw new Error(`Account not found: ${id}`);
  if (account.provider !== "codex") {
    throw new Error(`Account ${id} is ${account.provider}, not codex.`);
  }
  if (account.kind !== "oauth") {
    throw new Error(`Account ${id} is ${account.kind}, not oauth.`);
  }
  return account;
}

async function findExistingCodexAccount(
  store: AccountStore,
  tokens: CodexOAuthTokens,
): Promise<{ account: AccountRecord; matchedBy: "accountId" | "email" } | undefined> {
  const accounts = await store.listByProvider("codex");
  const byAccountId = tokens.accountId
    ? accounts.filter((account) => readStoredAccountId(account) === tokens.accountId)
    : [];
  if (byAccountId.length === 1) return { account: byAccountId[0]!, matchedBy: "accountId" };
  if (byAccountId.length > 1) {
    throw new Error(`Multiple codex accounts match ChatGPT account id ${tokens.accountId}; pass --account.`);
  }

  const byEmail = tokens.email
    ? accounts.filter((account) => readStoredEmail(account) === tokens.email)
    : [];
  if (byEmail.length === 1) return { account: byEmail[0]!, matchedBy: "email" };
  if (byEmail.length > 1) {
    throw new Error(`Multiple codex accounts match email ${tokens.email}; pass --account.`);
  }

  return undefined;
}

function assertCompatibleCodexIdentity(
  account: AccountRecord,
  tokens: CodexOAuthTokens,
  force: boolean,
): void {
  if (force) return;

  const storedAccountId = readStoredAccountId(account);
  if (tokens.accountId && storedAccountId && tokens.accountId !== storedAccountId) {
    throw new Error(
      `OAuth account id ${tokens.accountId} does not match stored account id ${storedAccountId}; pass --force to override.`,
    );
  }

  const storedEmail = readStoredEmail(account);
  if (tokens.email && storedEmail && tokens.email !== storedEmail) {
    throw new Error(
      `OAuth email ${tokens.email} does not match stored email ${storedEmail}; pass --force to override.`,
    );
  }

  if (!tokens.accountId && !tokens.email && (storedAccountId || storedEmail)) {
    throw new Error("OAuth response did not include account identity; pass --force to update this account.");
  }
}

async function replaceCodexAccountCredentials(
  store: AccountStore,
  account: AccountRecord,
  tokens: CodexOAuthTokens,
  options: { enable: boolean },
): Promise<AccountRecord> {
  const input = createCodexAccountInput(tokens, account);
  const updated = await store.update(account.id, input);
  if (!updated) throw new Error(`Account not found: ${account.id}`);

  const reset = await store.resetState(updated.id, { enable: options.enable });
  if (!reset) throw new Error(`Account not found: ${updated.id}`);
  return reset;
}

function createCodexAccountInput(
  tokens: CodexOAuthTokens,
  existing?: AccountRecord,
): {
  provider: "codex";
  kind: "oauth";
  name: string;
  credentials: Record<string, unknown>;
  metadata: Record<string, unknown>;
} {
  const metadata = { ...existing?.metadata };
  delete metadata.cachedUsage;
  delete metadata.cachedUsageAt;
  delete metadata.usageCachedAt;
  delete metadata.usage_cached_at;

  return {
    provider: "codex",
    kind: "oauth",
    name: tokens.email ? `Codex ${tokens.email}` : existing?.name ?? "Codex OAuth account",
    credentials: {
      ...existing?.credentials,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? existing?.credentials.refreshToken,
      expiresAt: tokens.expiresAt,
      accountId: tokens.accountId ?? existing?.credentials.accountId,
    },
    metadata: {
      ...metadata,
      email: tokens.email ?? existing?.metadata.email,
      accountId: tokens.accountId ?? existing?.metadata.accountId,
      planTier: tokens.planTier ?? existing?.metadata.planTier,
    },
  };
}

function readStoredAccountId(account: AccountRecord): string | undefined {
  return readString(account.credentials.accountId) ?? readString(account.metadata.accountId);
}

function readStoredEmail(account: AccountRecord): string | undefined {
  return readString(account.metadata.email);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
