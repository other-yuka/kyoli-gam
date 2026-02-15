import { AnthropicAuthPlugin } from "opencode-anthropic-auth";
import { tool } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode-ai/plugin";
import { migrateFromAuthJson } from "opencode-multi-account-core";
import { AccountManager } from "./account-manager";
import { executeWithAccountRotation } from "./executor";
import { getPlanLabel, getUsageSummary } from "./usage";
import { handleAuthorize } from "./auth-handler";
import { loadConfig } from "./config";
import { ProactiveRefreshQueue } from "./proactive-refresh";
import { AccountStore } from "./account-store";
import { AccountRuntimeFactory } from "./runtime-factory";
import { formatWaitTime, getAccountLabel, showToast } from "./utils";
import { ANTHROPIC_OAUTH_ADAPTER } from "./constants";
import type { OAuthCredentials, OriginalAuthHook, PluginClient } from "./types";

export const ClaudeMultiAuthPlugin: Plugin = async (ctx) => {
  const { client } = ctx as unknown as { client: PluginClient } & Record<string, unknown>;

  await loadConfig();

  const originalHooks = await AnthropicAuthPlugin(ctx);
  const originalAuth = (originalHooks as Record<string, unknown>).auth as OriginalAuthHook;

  const store = new AccountStore();
  let manager: AccountManager | null = null;
  let runtimeFactory: AccountRuntimeFactory | null = null;
  let refreshQueue: ProactiveRefreshQueue | null = null;

  return {
    "experimental.chat.system.transform": (originalHooks as Record<string, unknown>)[
      "experimental.chat.system.transform"
    ],

    tool: {
      [ANTHROPIC_OAUTH_ADAPTER.statusToolName]: tool({
        description:
          "Show status of all multi-auth accounts including rate limits and usage.",
        args: {},
        async execute(_args, _context) {
          if (!manager) {
            return "Multi-auth not initialized. No OAuth accounts detected.";
          }

          const accounts = manager.getAccounts();
          if (accounts.length === 0) {
            return "No accounts configured. Run `opencode auth login` to add an account.";
          }

          const lines: string[] = [
            `## ${ANTHROPIC_OAUTH_ADAPTER.modelDisplayName} Multi-Auth Status (${accounts.length} accounts)\n`,
          ];

          for (const account of accounts) {
            const isActive = account.uuid === manager.getActiveAccount()?.uuid;
            const marker = isActive ? " **[ACTIVE]**" : "";
            const label = getAccountLabel(account);
            const usage = getUsageSummary(account);
            const planLabel = getPlanLabel(account);
            const planBadge = planLabel ? ` [${planLabel}]` : "";

            const statusParts: string[] = [];
            if (account.isAuthDisabled) statusParts.push(`AUTH DISABLED: ${account.authDisabledReason}`);
            else if (!account.enabled) statusParts.push("disabled");
            else statusParts.push("enabled");

            if (account.rateLimitResetAt && account.rateLimitResetAt > Date.now()) {
              const remaining = formatWaitTime(account.rateLimitResetAt - Date.now());
              statusParts.push(`RATE LIMITED (resets in ${remaining})`);
            }

            if (account.cachedUsage) {
              const now = Date.now();
              const usage = account.cachedUsage;
              const exhaustedTiers = [usage.five_hour, usage.seven_day].filter((tier) =>
                tier
                && tier.utilization >= 100
                && tier.resets_at != null
                && Date.parse(tier.resets_at) > now,
              );
              if (exhaustedTiers.length > 0) {
                statusParts.push("USAGE EXHAUSTED");
              }
            }

            lines.push(
              `- **${label}**${planBadge}${marker}: ${statusParts.join(" | ")} | ${usage}`,
            );
          }

          return lines.join("\n");
        },
      }),
    },

    auth: {
      provider: ANTHROPIC_OAUTH_ADAPTER.authProviderId,
      methods: [
        {
          label: ANTHROPIC_OAUTH_ADAPTER.authMethodLabel,
          type: "oauth" as const,
          async authorize() {
            const inputs = arguments.length > 0 ? (arguments[0] as Record<string, string>) : undefined;
            return handleAuthorize(originalAuth, manager, inputs, client);
          },
        },
        { type: "api" as const, label: "Create an API Key" },
        { type: "api" as const, label: "Manually enter API Key" },
      ],

      async loader(
        getAuth: () => Promise<unknown>,
        provider: Record<string, unknown>,
      ) {
        const auth = await getAuth() as Record<string, unknown>;
        if (auth.type !== "oauth") {
          return originalAuth.loader(getAuth, provider);
        }

        for (const model of Object.values((provider as Record<string, unknown>).models ?? {}) as Record<string, unknown>[]) {
          if (model) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
          }
        }

        const credentials = auth as OAuthCredentials;
        await migrateFromAuthJson("anthropic", store);
        manager = await AccountManager.create(store, credentials, client);
        runtimeFactory = new AccountRuntimeFactory(ctx as Record<string, unknown>, store, client, provider);
        manager.setRuntimeFactory(runtimeFactory);

        if (manager.getAccountCount() > 0) {
          const activeLabel = manager.getActiveAccount() ? getAccountLabel(manager.getActiveAccount()!) : "none";
          void showToast(
            client,
            `Multi-Auth: ${manager.getAccountCount()} account(s) loaded. Active: ${activeLabel}`,
            "info",
          );
          await manager.validateNonActiveTokens(client);

          const disabledCount = manager.getAccounts().filter((a) => a.isAuthDisabled).length;
          if (disabledCount > 0) {
            void showToast(
              client,
              `${disabledCount} account(s) have auth failures.`,
              "warning",
            );
          }

          if (refreshQueue) {
            await refreshQueue.stop();
          }
          refreshQueue = new ProactiveRefreshQueue(
            client,
            store,
            (uuid) => runtimeFactory?.invalidate(uuid),
          );
          refreshQueue.start();
        }

        return {
          apiKey: "",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            if (!manager || !runtimeFactory) {
              return fetch(input, init);
            }

            if (manager.getAccountCount() === 0) {
              throw new Error(
                "No Anthropic accounts configured. Run `opencode auth login` to add an account.",
              );
            }

            return executeWithAccountRotation(manager, runtimeFactory, client, input, init);
          },
        };
      },
    },
  };
};
