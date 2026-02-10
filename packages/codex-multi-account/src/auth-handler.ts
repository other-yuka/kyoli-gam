import * as v from "valibot";
import { AccountManager } from "./account-manager";
import { isTokenExpired } from "./token";
import { getConfig, updateConfigField } from "./config";
import { isTTY } from "./ui/ansi";
import { showAuthMenu, showManageAccounts, showMethodSelect, showStrategySelect, printQuotaError, printQuotaReport } from "./ui/auth-menu";
import { createMinimalClient, getAccountLabel } from "./utils";
import { fetchUsage, fetchProfile, derivePlanTier } from "./usage";
import { AccountStore } from "./account-store";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { exec } from "node:child_process";
import {
  startOAuthServer,
  stopOAuthServer,
  waitForOAuthCallback,
  generatePKCE,
  generateState,
  buildAuthorizeUrl,
  extractAccountId,
} from "./oauth";
import { OAUTH_ISSUER, OPENAI_CLIENT_ID } from "./constants";
import type { ManagedAccount, OAuthCredentials, PluginClient, StoredAccount, TokenResponse } from "./types";
import { TokenResponseSchema } from "./types";

type OAuthCallbackResponse =
  | ({ type: "success" } & { refresh: string; access: string; expires: number; accountId?: string })
  | { type: "failed" };

export interface OAuthFlowResult {
  url: string;
  instructions: string;
  method: "auto";
  callback(): Promise<OAuthCallbackResponse>;
}

const DeviceUserCodeResponseSchema = v.object({
  device_code: v.string(),
  user_code: v.string(),
  expires_in: v.number(),
  interval: v.optional(v.number()),
});

type DeviceUserCodeResponse = v.InferOutput<typeof DeviceUserCodeResponseSchema>;

function makeFailedFlowResult(message: string): OAuthFlowResult {
  return {
    url: "",
    instructions: message,
    method: "auto",
    callback: async () => ({ type: "failed" }),
  };
}

function normalizeMethod(method?: "browser" | "headless"): "browser" | "headless" {
  return method === "headless" ? "headless" : "browser";
}

function toCallbackResponse(tokens: TokenResponse): OAuthCallbackResponse {
  if (!tokens.refresh_token) {
    return { type: "failed" };
  }

  return {
    type: "success",
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens),
  };
}

async function pollDeviceAuthToken(startResult: DeviceUserCodeResponse): Promise<TokenResponse> {
  const expiresAt = Date.now() + startResult.expires_in * 1000;
  let intervalMs = Math.max(1, startResult.interval ?? 5) * 1000;

  while (Date.now() < expiresAt) {
    const response = await fetch(`${OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: OPENAI_CLIENT_ID,
        device_code: startResult.device_code,
      }),
    });

    if (response.ok) {
      return v.parse(TokenResponseSchema, await response.json());
    }

    const payload = await response.json().catch(() => ({} as Record<string, unknown>));
    const error = typeof payload.error === "string" ? payload.error : "";

    if (error === "authorization_pending") {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }

    if (error === "slow_down") {
      intervalMs += 5000;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }

    if (error === "expired_token") {
      throw new Error("Device code expired. Start authentication again.");
    }

    if (error === "access_denied") {
      throw new Error("Device authorization denied by user.");
    }

    throw new Error(`Device token polling failed: ${response.status}`);
  }

  throw new Error("Device authorization timed out");
}

async function startBrowserAuth(): Promise<OAuthFlowResult> {
  const { redirectUri } = await startOAuthServer();
  const pkce = await generatePKCE();
  const state = generateState();
  const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);

  return {
    url: authUrl,
    instructions: "Complete authorization in your browser.",
    method: "auto",
    callback: async () => {
      try {
        const tokens = await waitForOAuthCallback(pkce, state);
        return toCallbackResponse(tokens);
      } finally {
        stopOAuthServer();
      }
    },
  };
}

async function startDeviceAuth(): Promise<OAuthFlowResult> {
  const response = await fetch(`${OAUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
  });

  if (!response.ok) {
    throw new Error(`Failed to start device authorization: ${response.status}`);
  }

  const startResult = v.parse(DeviceUserCodeResponseSchema, await response.json());

  return {
    url: `${OAUTH_ISSUER}/codex/device`,
    instructions: `Enter code: ${startResult.user_code}`,
    method: "auto",
    callback: async () => {
      const tokens = await pollDeviceAuthToken(startResult);
      return toCallbackResponse(tokens);
    },
  };
}

async function startFlow(method?: "browser" | "headless"): Promise<OAuthFlowResult> {
  if (normalizeMethod(method) === "headless") {
    return startDeviceAuth();
  }
  return startBrowserAuth();
}

function wrapCallbackWithAccountReplace(
  result: OAuthFlowResult,
  manager: AccountManager,
  targetAccount: ManagedAccount,
): OAuthFlowResult {
  const originalCallback = result.callback;
  return {
    ...result,
    callback: async function () {
      const code = arguments.length > 0 ? (arguments[0] as string) : undefined;
      const callbackResult = await (originalCallback as (code?: string) => Promise<OAuthCallbackResponse>)(code);

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
): OAuthFlowResult {
  const originalCallback = result.callback;
  return {
    ...result,
    callback: async function () {
      const code = arguments.length > 0 ? (arguments[0] as string) : undefined;
      const callbackResult = await (originalCallback as (code?: string) => Promise<OAuthCallbackResponse>)(code);

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
        } else {
          await persistFallback(auth, callbackResult.accountId);
          console.log("\n✅ Account saved.\n");
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
): Promise<void> {
  while (true) {
    const currentCount = manager.getAccounts().length;
    const shouldAdd = await promptYesNo(`Add another account? (${currentCount} added) (y/n): `);
    if (!shouldAdd) break;

    const methodResult = await selectMethodAndStartFlow();
    if (!methodResult) break;

    let flow: OAuthFlowResult;
    try {
      flow = methodResult.flow;
    } catch {
      console.log("\n❌ Failed to start OAuth flow.\n");
      break;
    }

    if (flow.url) {
      openBrowser(flow.url);
    }
    if (flow.instructions) {
      console.log(`\n${flow.instructions}\n`);
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

async function persistFallback(auth: OAuthCredentials, accountId?: string): Promise<void> {
  try {
    const store = new AccountStore();
    const now = Date.now();
    const account: StoredAccount = {
      uuid: randomUUID(),
      accountId,
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

async function selectMethodAndStartFlow(): Promise<{ flow: OAuthFlowResult; method: "browser" | "headless" } | null> {
  if (!isTTY()) {
    const flow = await startFlow("browser");
    return { flow, method: "browser" };
  }

  const selected = await showMethodSelect();
  if (!selected) return null;

  const flow = await startFlow(selected);
  return { flow, method: selected };
}

export async function handleAuthorize(
  manager: AccountManager | null,
  inputs?: Record<string, string>,
  client?: PluginClient,
): Promise<OAuthFlowResult> {
  if (!inputs || !isTTY()) {
    return wrapCallbackWithManagerSync(await startFlow("browser"), manager);
  }

  const effectiveManager = manager ?? await loadManagerFromDisk(client);
  if (!effectiveManager || effectiveManager.getAccounts().length === 0) {
    const result = await selectMethodAndStartFlow();
    if (!result) return makeFailedFlowResult("Authentication cancelled");
    return wrapCallbackWithManagerSync(result.flow, manager);
  }

  return runAccountManagementMenu(effectiveManager, client);
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
  manager: AccountManager,
  client?: PluginClient,
): Promise<OAuthFlowResult> {
  while (true) {
    const allAccounts = manager.getAccounts();
    const menuAction = await showAuthMenu(allAccounts);

    switch (menuAction.type) {
      case "add": {
        const result = await selectMethodAndStartFlow();
        if (!result) continue;
        return wrapCallbackWithManagerSync(result.flow, manager);
      }

      case "check-quotas":
        await handleCheckQuotas(manager, client);
        continue;

      case "manage": {
        const result = await showManageAccounts(allAccounts);
        if (result.action === "back" || result.action === "cancel") continue;
        const manageResult = await handleManageAction(manager, result.action, result.account, client);
        if (manageResult.triggerOAuth) {
          const methodResult = await selectMethodAndStartFlow();
          if (!methodResult) continue;
          return wrapCallbackWithAccountReplace(methodResult.flow, manager, manageResult.account);
        }
        continue;
      }

      case "load-balancing":
        await handleLoadBalancing();
        continue;

      case "delete-all": {
        await manager.clearAllAccounts();
        console.log("\nAll accounts deleted.\n");
        const result = await selectMethodAndStartFlow();
        if (!result) return makeFailedFlowResult("Authentication cancelled");
        return wrapCallbackWithManagerSync(result.flow, manager);
      }

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

    const usageResult = await fetchUsage(freshAccount.accessToken, freshAccount.accountId);
    if (!usageResult.ok) {
      printQuotaError(freshAccount, `Failed to fetch usage: ${usageResult.reason}`);
      continue;
    }

    if (freshAccount.uuid) {
      await manager.applyUsageCache(freshAccount.uuid, usageResult.data);
    }

    // Determine plan: JWT profile first, WHAM plan_type as fallback
    const profileResult = fetchProfile(freshAccount.accessToken);
    let email = freshAccount.email;
    let planTier = freshAccount.planTier ?? "";

    if (profileResult.ok) {
      email = profileResult.data.email ?? email;
      planTier = profileResult.data.planTier;
    }

    // If JWT didn't have plan info, use WHAM plan_type as fallback
    if ((!planTier || planTier === "free") && usageResult.planType) {
      planTier = derivePlanTier(usageResult.planType);
    }

    const profileData = { email, planTier };
    if (freshAccount.uuid) {
      await manager.applyProfileCache(freshAccount.uuid, profileData);
    }

    const reportAccount = { ...freshAccount, email, planTier };
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
        console.log("Token refresh failed — starting OAuth flow...\n");
        return { triggerOAuth: true, account };
      }
      break;
    }
  }

  return { triggerOAuth: false };
}
