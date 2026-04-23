import { promises as fs } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "opencode-multi-account-core";
import { ANTHROPIC_OAUTH_ADAPTER } from "../shared/constants";
import type { AccountStore } from "../accounts/store";
import type { OAuthCredentials, PluginClient, StoredAccount } from "../shared/types";

const AUTH_JSON_FILENAME = "auth.json";

function hasCompleteOAuthCredential(account: StoredAccount): account is StoredAccount & {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
} {
  return (
    typeof account.refreshToken === "string"
    && account.refreshToken.length > 0
    && typeof account.accessToken === "string"
    && account.accessToken.length > 0
    && typeof account.expiresAt === "number"
    && Number.isFinite(account.expiresAt)
  );
}

function selectBootstrapAccount(
  accounts: StoredAccount[],
  activeAccountUuid?: string,
): (StoredAccount & { refreshToken: string; accessToken: string; expiresAt: number }) | null {
  const completeAccounts = accounts.filter(hasCompleteOAuthCredential);
  if (completeAccounts.length === 0) {
    return null;
  }

  const activeAccount = activeAccountUuid
    ? completeAccounts.find((account) => account.uuid === activeAccountUuid)
    : undefined;
  if (activeAccount) {
    return activeAccount;
  }

  const firstUsableAccount = completeAccounts.find(
    (account) => account.enabled !== false && account.isAuthDisabled !== true,
  );
  return firstUsableAccount ?? completeAccounts[0]!;
}

async function readCurrentAuth(providerId: string): Promise<OAuthCredentials | null> {
  const authPath = join(getConfigDir(), AUTH_JSON_FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(authPath, "utf-8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const providerAuth = parsed[providerId] as Partial<OAuthCredentials> | undefined;
    if (
      providerAuth?.type !== "oauth"
      || typeof providerAuth.refresh !== "string"
      || typeof providerAuth.access !== "string"
      || typeof providerAuth.expires !== "number"
    ) {
      return null;
    }

    return {
      type: "oauth",
      refresh: providerAuth.refresh,
      access: providerAuth.access,
      expires: providerAuth.expires,
    };
  } catch {
    return null;
  }
}

function shouldSyncBootstrapAuth(currentAuth: OAuthCredentials | null, nextAuth: OAuthCredentials): boolean {
  if (!currentAuth) {
    return true;
  }

  if (
    currentAuth.refresh === nextAuth.refresh
    && currentAuth.access === nextAuth.access
    && currentAuth.expires === nextAuth.expires
  ) {
    return false;
  }

  return currentAuth.expires < nextAuth.expires;
}

export async function syncBootstrapAuth(
  client: PluginClient,
  store: AccountStore,
): Promise<boolean> {
  const storage = await store.load();
  const bootstrapAccount = selectBootstrapAccount(storage.accounts, storage.activeAccountUuid);
  if (!bootstrapAccount) {
    return false;
  }

  const nextAuth: OAuthCredentials = {
    type: "oauth",
    refresh: bootstrapAccount.refreshToken,
    access: bootstrapAccount.accessToken,
    expires: bootstrapAccount.expiresAt,
  };

  const currentAuth = await readCurrentAuth(ANTHROPIC_OAUTH_ADAPTER.authProviderId);
  if (!shouldSyncBootstrapAuth(currentAuth, nextAuth)) {
    return false;
  }

  await client.auth.set({
    path: { id: ANTHROPIC_OAUTH_ADAPTER.authProviderId },
    body: nextAuth,
  });
  return true;
}

export const __bootstrapAuthTestUtils = {
  selectBootstrapAccount,
  shouldSyncBootstrapAuth,
};
