import { tool } from "@opencode-ai/plugin";
import { migrateFromAuthJson } from "@other-yuka/multi-account-core";
import { AccountManager } from "./account-manager";
import { executeWithAccountRotation } from "./executor";
import { getUsageSummary } from "./usage";
import { handleAuthorize } from "./auth-handler";
import { loadConfig } from "./config";
import { ProactiveRefreshQueue } from "./proactive-refresh";
import { AccountStore } from "./account-store";
import { AccountRuntimeFactory } from "./runtime-factory";
import { formatWaitTime, getAccountLabel, showToast } from "./utils";
import { OPENAI_OAUTH_ADAPTER } from "./constants";
import type { OAuthCredentials, PluginClient } from "./types";

export const CodexMultiAuthPlugin = async (ctx: unknown) => {
  const { client } = ctx as unknown as { client: PluginClient } & Record<string, unknown>;

  await loadConfig();

  const store = new AccountStore();
  let manager: AccountManager | null = null;
  let runtimeFactory: AccountRuntimeFactory | null = null;
  let refreshQueue: ProactiveRefreshQueue | null = null;

  return {
    tool: {
      [OPENAI_OAUTH_ADAPTER.statusToolName]: tool({
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
            `## Codex Multi-Auth Status (${accounts.length} accounts)\n`,
          ];

          for (const account of accounts) {
            const isActive = account.uuid === manager.getActiveAccount()?.uuid;
            const marker = isActive ? " **[ACTIVE]**" : "";
            const label = getAccountLabel(account);
            const usage = getUsageSummary(account);

            const statusParts: string[] = [];
            if (account.isAuthDisabled) statusParts.push(`AUTH DISABLED: ${account.authDisabledReason}`);
            else if (!account.enabled) statusParts.push("disabled");
            else statusParts.push("enabled");

            if (account.rateLimitResetAt && account.rateLimitResetAt > Date.now()) {
              const remaining = formatWaitTime(account.rateLimitResetAt - Date.now());
              statusParts.push(`RATE LIMITED (resets in ${remaining})`);
            }

            lines.push(
              `- **${label}**${marker}: ${statusParts.join(" | ")} | ${usage}`,
            );
          }

          return lines.join("\n");
        },
      }),
    },

    auth: {
      provider: OPENAI_OAUTH_ADAPTER.authProviderId,
      methods: [
        {
          label: OPENAI_OAUTH_ADAPTER.authMethodLabel,
          type: "oauth" as const,
          async authorize() {
            const inputs = arguments.length > 0 ? (arguments[0] as Record<string, string>) : undefined;
            return handleAuthorize(manager, inputs, client);
          },
        },
        { type: "api" as const, label: "Manually enter API Key" },
      ],

      async loader(
        getAuth: () => Promise<unknown>,
        provider: Record<string, unknown>,
      ) {
        const auth = await getAuth() as Record<string, unknown>;
        if (auth.type !== "oauth") {
          return { apiKey: "", fetch };
        }

        for (const model of Object.values((provider as Record<string, unknown>).models ?? {}) as Record<string, unknown>[]) {
          if (model) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
          }
        }

        const credentials = auth as OAuthCredentials;
        await migrateFromAuthJson("openai", store);
        manager = await AccountManager.create(store, credentials, client);
        runtimeFactory = new AccountRuntimeFactory(store, client);
        manager.setRuntimeFactory(runtimeFactory);

        if (manager.getAccountCount() > 0) {
          const activeAccount = manager.getActiveAccount();
          const activeLabel = activeAccount ? getAccountLabel(activeAccount) : "none";
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
          apiKey: "CODEX_OAUTH",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            if (!manager || !runtimeFactory) {
              return fetch(input, init);
            }

            if (manager.getAccountCount() === 0) {
              throw new Error(
                "No Codex accounts configured. Run `opencode auth login` to add an account.",
              );
            }

            return executeWithAccountRotation(manager, runtimeFactory, client, input, init);
          },
        };
      },
    },
  };
};
