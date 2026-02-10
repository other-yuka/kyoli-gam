import { AccountManager } from "./account-manager";
import { fetchProfile, fetchUsage } from "./usage";
import { isTokenExpired } from "./token";
import { getConfig, updateConfigField } from "./config";
import { isTTY } from "./ui/ansi";
import { showAuthMenu, showManageAccounts, showStrategySelect, printQuotaReport, printQuotaError } from "./ui/auth-menu";
import { createMinimalClient, getAccountLabel } from "./utils";
import { AccountStore } from "./account-store";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { exec } from "node:child_process";
import type { ManagedAccount, OAuthCredentials, OriginalAuthHook, PluginClient, StoredAccount } from "./types";

type OAuthCallbackResponse =
  | ({ type: "success" } & { refresh: string; access: string; expires: number })
  | { type: "failed" };

export interface OAuthFlowResult {
  url: string;
  instructions: string;
  method: "auto";
  callback(code?: string): Promise<OAuthCallbackResponse>;
}

function makeFailedFlowResult(message: string): OAuthFlowResult {
  return {
    url: "",
    instructions: message,
    method: "auto",
    callback: async () => ({ type: "failed" }),
  };
}

function delegateToOriginalAuth(
  originalAuth: OriginalAuthHook,
  manager: AccountManager | null,
  inputs?: Record<string, string>,
): Promise<OAuthFlowResult> {
  const originalMethod = originalAuth.methods?.[0];
  if (!originalMethod?.authorize) {
    return Promise.resolve(makeFailedFlowResult("Original OAuth method not available"));
  }
  return originalMethod.authorize(inputs).then((result) =>
    wrapCallbackWithManagerSync(result as OAuthFlowResult, manager, originalAuth, inputs),
  );
}

function delegateReauthForAccount(
  originalAuth: OriginalAuthHook,
  manager: AccountManager,
  targetAccount: ManagedAccount,
  inputs?: Record<string, string>,
): Promise<OAuthFlowResult> {
  const originalMethod = originalAuth.methods?.[0];
  if (!originalMethod?.authorize) {
    return Promise.resolve(makeFailedFlowResult("Original OAuth method not available"));
  }
  return originalMethod.authorize(inputs).then((result) =>
    wrapCallbackWithAccountReplace(result as OAuthFlowResult, manager, targetAccount),
  );
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

      if (callbackResult?.type === "success" && callbackResult.refresh) {
        const auth: OAuthCredentials = {
          type: "oauth",
          refresh: callbackResult.refresh,
          access: callbackResult.access,
          expires: callbackResult.expires,
        };

        if (targetAccount.uuid) {
          await manager.replaceAccountCredentials(targetAccount.uuid, auth);
        }

        const label = getAccountLabel(targetAccount);
        console.log(`\n✅ ${label} re-authenticated successfully.\n`);
      }

      return callbackResult;
    },
  };
}

function wrapCallbackWithManagerSync(
  result: OAuthFlowResult,
  manager: AccountManager | null,
  originalAuth?: OriginalAuthHook,
  inputs?: Record<string, string>,
): OAuthFlowResult {
  const originalCallback = result.callback;
  return {
    ...result,
    callback: async function (code?: string) {
      const callbackResult = await originalCallback(code);

      if (callbackResult?.type === "success" && callbackResult.refresh) {
        const auth: OAuthCredentials = {
          type: "oauth",
          refresh: callbackResult.refresh,
          access: callbackResult.access,
          expires: callbackResult.expires,
        };

        if (manager) {
          const countBefore = manager.getAccounts().length;
          await manager.addAccount(auth);
          const countAfter = manager.getAccounts().length;

          if (countAfter > countBefore) {
            console.log(`\n✅ Account added to multi-auth pool (${countAfter} total).\n`);
          } else {
            console.log(`\nℹ️  Account already exists in multi-auth pool (${countAfter} total).\n`);
          }

          if (originalAuth && inputs && isTTY()) {
            await addMoreAccountsLoop(manager, originalAuth, inputs);
          }

        } else {
          await persistFallback(auth);
          console.log(`\n✅ Account saved.\n`);
        }
      }

      return callbackResult;
    },
  };
}

function promptYesNo(message: string): Promise<boolean> {
  if (!isTTY()) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  exec(`${cmd} ${JSON.stringify(url)}`);
}

async function addMoreAccountsLoop(
  manager: AccountManager,
  originalAuth: OriginalAuthHook,
  inputs: Record<string, string>,
): Promise<void> {
  const originalMethod = originalAuth.methods?.[0];
  if (!originalMethod?.authorize) return;

  while (true) {
    const currentCount = manager.getAccounts().length;
    const shouldAdd = await promptYesNo(`Add another account? (${currentCount} added) (y/n): `);
    if (!shouldAdd) break;

    let flow: OAuthFlowResult;
    try {
      flow = await originalMethod.authorize(inputs) as OAuthFlowResult;
    } catch {
      console.log("\n❌ Failed to start OAuth flow.\n");
      break;
    }

    if (flow.url) {
      openBrowser(flow.url);
    }

    let callbackResult: OAuthCallbackResponse;
    try {
      callbackResult = await flow.callback();
    } catch {
      console.log("\n❌ Authentication failed.\n");
      break;
    }

    if (callbackResult?.type !== "success" || !("refresh" in callbackResult)) {
      console.log("\n❌ Authentication failed.\n");
      break;
    }

    const auth: OAuthCredentials = {
      type: "oauth",
      refresh: callbackResult.refresh,
      access: callbackResult.access,
      expires: callbackResult.expires,
    };

    const countBefore = manager.getAccounts().length;
    await manager.addAccount(auth);
    const countAfter = manager.getAccounts().length;

    if (countAfter > countBefore) {
      console.log(`\n✅ Account added to multi-auth pool (${countAfter} total).\n`);
    } else {
      console.log(`\nℹ️  Account already exists in multi-auth pool (${countAfter} total).\n`);
    }
  }
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
  originalAuth: OriginalAuthHook,
  manager: AccountManager | null,
  inputs?: Record<string, string>,
  client?: PluginClient,
): Promise<OAuthFlowResult> {
  if (!inputs || !isTTY()) {
    return delegateToOriginalAuth(originalAuth, manager, inputs);
  }

  const effectiveManager = manager ?? await loadManagerFromDisk(client);
  if (!effectiveManager || effectiveManager.getAccounts().length === 0) {
    return delegateToOriginalAuth(originalAuth, manager, inputs);
  }

  return runAccountManagementMenu(originalAuth, effectiveManager, inputs, client);
}

async function loadManagerFromDisk(client?: PluginClient): Promise<AccountManager | null> {
  const store = new AccountStore();
  const stored = await store.load();
  if (stored.accounts.length === 0) return null;
  const emptyAuth: OAuthCredentials = { type: "oauth", refresh: "", access: "", expires: 0 };
  const mgr = await AccountManager.create(store, emptyAuth, client);
  return mgr;
}

async function runAccountManagementMenu(
  originalAuth: OriginalAuthHook,
  manager: AccountManager,
  inputs: Record<string, string>,
  client?: PluginClient,
): Promise<OAuthFlowResult> {
  while (true) {
    const allAccounts = manager.getAccounts();
    const menuAction = await showAuthMenu(allAccounts);

    switch (menuAction.type) {
      case "add":
        return delegateToOriginalAuth(originalAuth, manager, inputs);

      case "check-quotas":
        await handleCheckQuotas(manager, client);
        continue;

      case "manage": {
        const result = await showManageAccounts(allAccounts);
        if (result.action === "back" || result.action === "cancel") continue;
        const manageResult = await handleManageAction(manager, result.action, result.account, client);
        if (manageResult.triggerOAuth) {
          return delegateReauthForAccount(originalAuth, manager, manageResult.account, inputs);
        }
        continue;
      }

      case "load-balancing":
        await handleLoadBalancing();
        continue;

      case "delete-all":
        await manager.clearAllAccounts();
        console.log("\nAll accounts deleted.\n");
        return delegateToOriginalAuth(originalAuth, manager, inputs);

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
    if (account.isAuthDisabled || !account.accessToken || isTokenExpired(account)) {
      if (!account.uuid) {
        printQuotaError(account, "Missing account UUID");
        continue;
      }

      const result = await manager.ensureValidToken(account.uuid, effectiveClient);
      if (!result.ok) {
        printQuotaError(account, account.isAuthDisabled
          ? `${account.authDisabledReason ?? "Auth disabled"} (refresh failed)`
          : "Failed to refresh token");
        continue;
      }

      await manager.refresh();
    }

    const freshAccounts = manager.getAccounts();
    const freshAccount = freshAccounts.find((candidate) => candidate.uuid === account.uuid);

    if (!freshAccount?.accessToken) {
      printQuotaError(account, "No access token available");
      continue;
    }

    const usageResult = await fetchUsage(freshAccount.accessToken);
    if (!usageResult.ok) {
      printQuotaError(freshAccount, `Failed to fetch usage: ${usageResult.reason}`);
      continue;
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
        console.log(`Token refresh failed — starting OAuth flow...\n`);
        return { triggerOAuth: true, account };
      }
      break;
    }
  }

  return { triggerOAuth: false };
}
