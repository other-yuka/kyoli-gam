import { AccountManager } from "./account-manager";
import { fetchProfile, fetchUsage } from "./usage";
import { isTokenExpired } from "./token";
import { getConfig, updateConfigField } from "./config";
import { isTTY } from "./ui/ansi";
import { showAuthMenu, showManageAccounts, showStrategySelect, printQuotaReport, printQuotaError } from "./ui/auth-menu";
import { createMinimalClient, getAccountLabel } from "./utils";
import { AccountStore } from "./account-store";
import { loginWithOAuth } from "./anthropic-oauth";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import type { ManagedAccount, OAuthCredentials, PluginClient, StoredAccount } from "./types";

type OAuthCallbackResponse =
  | ({ type: "success" } & { refresh: string; access: string; expires: number })
  | { type: "failed" };

export interface OAuthFlowResult {
  url: string;
  instructions: string;
  method: "auto";
  callback(code?: string): Promise<OAuthCallbackResponse>;
  _email?: string;
}

function makeFailedFlowResult(message: string): OAuthFlowResult {
  return {
    url: "",
    instructions: message,
    method: "auto",
    callback: async () => ({ type: "failed" }),
  };
}

function toOAuthCredentials(result: OAuthCallbackResponse & { type: "success" }): OAuthCredentials {
  return { type: "oauth", refresh: result.refresh, access: result.access, expires: result.expires };
}

function asOAuthCallbackResponse(account: Partial<StoredAccount>): OAuthCallbackResponse {
  if (!account.refreshToken || !account.accessToken || typeof account.expiresAt !== "number") {
    return { type: "failed" };
  }

  return {
    type: "success",
    refresh: account.refreshToken,
    access: account.accessToken,
    expires: account.expiresAt,
  };
}

async function startOAuthFlow(): Promise<OAuthFlowResult> {
  try {
    const completedAccount = await loginWithOAuth({
      onAuth: (info) => {
        const instruction = info.instructions ?? "Complete authorization in your browser.";
        const urlLine = info.url ? `\nAuth URL (manual fallback): ${info.url}` : "";
        console.log(`\n${instruction}${urlLine}\n`);
      },
    });

    const completedResult = asOAuthCallbackResponse(completedAccount);
    const accountEmail = completedAccount.email;

    return {
      url: "",
      instructions: "",
      method: "auto",
      callback: async () => completedResult,
      _email: accountEmail,
    };
  } catch {
    return makeFailedFlowResult("Failed to start OAuth flow");
  }
}

function wrapCallbackWithAccountReplace(
  result: OAuthFlowResult,
  manager: AccountManager,
  targetAccount: ManagedAccount,
): OAuthFlowResult {
  const originalCallback = result.callback;
  return {
    ...result,
    callback: async function (code?: string) {
      const callbackResult = await originalCallback(code);

      if (callbackResult.type === "success") {
        if (targetAccount.uuid) {
          await manager.replaceAccountCredentials(targetAccount.uuid, toOAuthCredentials(callbackResult));
        }
        console.log(`\n✅ ${getAccountLabel(targetAccount)} re-authenticated successfully.\n`);
      }

      return callbackResult;
    },
  };
}

function wrapCallbackWithManagerSync(
  result: OAuthFlowResult & { _email?: string },
  manager: AccountManager | null,
): OAuthFlowResult {
  const originalCallback = result.callback;
  const email = result._email;
  return {
    ...result,
    callback: async function (code?: string) {
      const callbackResult = await originalCallback(code);

      if (callbackResult.type === "success") {
        const auth = toOAuthCredentials(callbackResult);

        if (manager) {
          const countBefore = manager.getAccounts().length;
          await manager.addAccount(auth, email);
          const countAfter = manager.getAccounts().length;
          const added = countAfter > countBefore;
          console.log(added
            ? `\n✅ Account added to multi-auth pool (${countAfter} total).\n`
            : `\nℹ️  Account already exists in multi-auth pool (${countAfter} total).\n`);
        } else {
          await persistFallback(auth);
          console.log("\n✅ Account saved.\n");
        }
      }

      return callbackResult;
    },
  };
}

function openBrowser(url: string): void {
  const commands: Record<string, string> = {
    darwin: "open",
    win32: "start",
  };
  const cmd = commands[process.platform] ?? "xdg-open";
  exec(`${cmd} ${JSON.stringify(url)}`);
}

async function persistFallback(auth: OAuthCredentials): Promise<void> {
  try {
    const store = new AccountStore();
    const now = Date.now();
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
    await store.addAccount(account);
    await store.setActiveUuid(account.uuid);
  } catch {
    // best-effort
  }
}

export async function handleAuthorize(
  manager: AccountManager | null,
  inputs?: Record<string, string>,
  client?: PluginClient,
): Promise<OAuthFlowResult> {
  if (!inputs || !isTTY()) {
    return wrapCallbackWithManagerSync(await startOAuthFlow(), manager);
  }

  const effectiveManager = manager ?? await loadManagerFromDisk(client);
  if (!effectiveManager || effectiveManager.getAccounts().length === 0) {
    return wrapCallbackWithManagerSync(await startOAuthFlow(), manager);
  }

  return runAccountManagementMenu(effectiveManager, client);
}

async function loadManagerFromDisk(client?: PluginClient): Promise<AccountManager | null> {
  const store = new AccountStore();
  const stored = await store.load();
  if (stored.accounts.length === 0) return null;
  const emptyAuth: OAuthCredentials = { type: "oauth", refresh: "", access: "", expires: 0 };
  return AccountManager.create(store, emptyAuth, client);
}

async function runAccountManagementMenu(
  manager: AccountManager,
  client?: PluginClient,
): Promise<OAuthFlowResult> {
  while (true) {
    const allAccounts = manager.getAccounts();
    const menuAction = await showAuthMenu(allAccounts);

    switch (menuAction.type) {
      case "add":
        return wrapCallbackWithManagerSync(await startOAuthFlow(), manager);

      case "check-quotas":
        await handleCheckQuotas(manager, client);
        continue;

      case "manage": {
        const result = await showManageAccounts(allAccounts);
        if (result.action === "back" || result.action === "cancel") continue;
        const manageResult = await handleManageAction(manager, result.action, result.account, client);
        if (manageResult.triggerOAuth) {
          return wrapCallbackWithAccountReplace(await startOAuthFlow(), manager, manageResult.account);
        }
        continue;
      }

      case "load-balancing":
        await handleLoadBalancing();
        continue;

      case "delete-all":
        await manager.clearAllAccounts();
        console.log("\nAll accounts deleted.\n");
        return wrapCallbackWithManagerSync(await startOAuthFlow(), manager);

      case "cancel":
        return makeFailedFlowResult("Authentication cancelled");
    }
  }
}

async function handleCheckQuotas(manager: AccountManager, client?: PluginClient): Promise<void> {
  await manager.refresh();
  const accounts = manager.getAccounts();
  const effectiveClient = client ?? createMinimalClient();
  if (client) manager.setClient(client);
  console.log(`\n📊 Checking quotas for ${accounts.length} account(s)...\n`);

  for (const account of accounts) {
    await checkAccountQuota(manager, account, effectiveClient);
  }
}

async function checkAccountQuota(
  manager: AccountManager,
  account: ManagedAccount,
  client: PluginClient,
): Promise<void> {
  if (account.isAuthDisabled || !account.accessToken || isTokenExpired(account)) {
    if (!account.uuid) {
      printQuotaError(account, "Missing account UUID");
      return;
    }

    const refreshResult = await manager.ensureValidToken(account.uuid, client);
    if (!refreshResult.ok) {
      await manager.markAuthFailure(account.uuid, refreshResult);
      await manager.refresh();

      const updatedAccount = manager.getAccounts().find((candidate) => candidate.uuid === account.uuid);
      if (!updatedAccount) {
        printQuotaError(account, refreshResult.permanent
          ? "Refresh failed permanently; account removed"
          : "Failed to refresh token");
        return;
      }

      printQuotaError(updatedAccount, updatedAccount.isAuthDisabled
        ? `${updatedAccount.authDisabledReason ?? "Auth disabled"} (refresh failed)`
        : "Failed to refresh token");
      return;
    }

    await manager.refresh();
  }

  const freshAccounts = manager.getAccounts();
  const freshAccount = freshAccounts.find((candidate) => candidate.uuid === account.uuid);

  if (!freshAccount?.accessToken) {
    printQuotaError(account, "No access token available");
    return;
  }

  const usageResult = await fetchUsage(freshAccount.accessToken);
  if (!usageResult.ok) {
    printQuotaError(freshAccount, `Failed to fetch usage: ${usageResult.reason}`);
    return;
  }

  if (freshAccount.uuid) {
    await manager.applyUsageCache(freshAccount.uuid, usageResult.data);
  }

  let reportAccount = freshAccount;
  const profileResult = await fetchProfile(freshAccount.accessToken);
  if (profileResult.ok) {
    if (freshAccount.uuid) {
      await manager.applyProfileCache(freshAccount.uuid, profileResult.data);
    }
    reportAccount = {
      ...freshAccount,
      email: profileResult.data.email ?? freshAccount.email,
      planTier: profileResult.data.planTier,
    };
  }

  printQuotaReport(reportAccount, usageResult.data);
}

async function handleLoadBalancing(): Promise<void> {
  const current = getConfig().account_selection_strategy;
  const selected = await showStrategySelect(current);

  if (!selected || selected === current) return;

  await updateConfigField("account_selection_strategy", selected);
  console.log(`\nLoad balancing strategy changed: ${current} → ${selected}\n`);
}

type ManageActionResult =
  | { triggerOAuth: false }
  | { triggerOAuth: true; account: ManagedAccount };

async function handleManageAction(
  manager: AccountManager,
  action: string,
  account?: ManagedAccount,
  client?: PluginClient,
): Promise<ManageActionResult> {
  if (!account) return { triggerOAuth: false };

  const label = getAccountLabel(account);

  switch (action) {
    case "toggle":
      if (!account.uuid) break;
      await manager.toggleEnabled(account.uuid);
      await manager.refresh();
      {
        const updated = manager.getAccounts().find((candidate) => candidate.uuid === account.uuid);
        console.log(`\n${label} ${updated?.enabled ? "enabled" : "disabled"}.\n`);
      }
      break;

    case "delete":
      if (!account.uuid) break;
      {
        const removed = await manager.removeAccount(account.index);
        console.log(removed ? "\nAccount deleted.\n" : "\nFailed to delete account.\n");
      }
      break;

    case "retry-auth": {
      if (!account.uuid) break;
      const effectiveClient = client ?? createMinimalClient();
      console.log(`\nRetrying authentication for ${label}...\n`);
      const result = await manager.retryAuth(account.uuid, effectiveClient);

      if (result.ok) {
        console.log(`✅ ${label} re-authenticated successfully.\n`);
      } else {
        console.log("Token refresh failed — starting OAuth flow...\n");
        return { triggerOAuth: true, account };
      }
      break;
    }
  }

  return { triggerOAuth: false };
}
