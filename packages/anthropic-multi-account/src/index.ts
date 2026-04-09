import { tool } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode-ai/plugin";
import {
  CascadeStateManager,
  loadPoolChainConfig,
  migrateFromAuthJson,
  PoolManager,
  type PoolChainConfig,
} from "opencode-multi-account-core";
import { AccountManager } from "./account-manager";
import { executeWithAccountRotation } from "./executor";
import { getPlanLabel, getUsageSummary } from "./usage";
import { handleAuthorize } from "./auth-handler";
import { getInjectedSystemPrompt, buildBillingHeader } from "./request-transform";
import { ANTHROPIC_BETA_HEADER } from "./constants";
import { loadConfig } from "./config";
import { ProactiveRefreshQueue } from "./proactive-refresh";
import { AccountStore } from "./account-store";
import { AccountRuntimeFactory } from "./runtime-factory";
import { formatWaitTime, getAccountLabel, showToast } from "./utils";
import { ANTHROPIC_OAUTH_ADAPTER } from "./constants";
import { getUserAgent } from "./model-config";
import { syncBootstrapAuth } from "./bootstrap-auth";
import type { OAuthCredentials, PluginClient } from "./types";

const EMPTY_OAUTH_CREDENTIALS: OAuthCredentials = {
  type: "oauth",
  refresh: "",
  access: "",
  expires: 0,
};

function extractFirstUserText(input: Record<string, unknown>): string {
  try {
    const raw = input as { messages?: unknown; request?: { messages?: unknown } };
    const messages = (raw.messages ?? raw.request?.messages) as
      Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }> | undefined;
    if (!Array.isArray(messages)) return "";
    for (const msg of messages) {
      if (msg.role !== "user") continue;
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) return block.text;
        }
      }
    }
  } catch {}
  return "";
}

function injectSystemPrompt(output: { system?: string[] }): void {
  const systemPrompt = getInjectedSystemPrompt();

  if (!Array.isArray(output.system)) {
    output.system = [systemPrompt];
    return;
  }

  if (!output.system.includes(systemPrompt)) {
    output.system.unshift(systemPrompt);
  }
}

export const ClaudeMultiAuthPlugin: Plugin = async (ctx) => {
  const { client } = ctx as unknown as { client: PluginClient } & Record<string, unknown>;

  await loadConfig();

  const store = new AccountStore();
  await syncBootstrapAuth(client, store).catch(() => {});

  let manager: AccountManager | null = null;
  let runtimeFactory: AccountRuntimeFactory | null = null;
  let refreshQueue: ProactiveRefreshQueue | null = null;
  let poolManager: PoolManager | null = null;
  let cascadeStateManager: CascadeStateManager | null = null;
  let poolChainConfig: PoolChainConfig = { pools: [], chains: [] };

  async function ensureExecutionInfrastructure(): Promise<void> {
    runtimeFactory ??= new AccountRuntimeFactory(store, client);
    poolChainConfig = await loadPoolChainConfig();

    poolManager ??= new PoolManager();
    poolManager.loadPools(poolChainConfig.pools);
    cascadeStateManager ??= new CascadeStateManager();

    if (manager) {
      manager.setRuntimeFactory(runtimeFactory);
      manager.setClient(client);
    }
  }

  async function startRefreshQueueIfNeeded(): Promise<void> {
    if (!manager || manager.getAccountCount() === 0) {
      return;
    }

    await ensureExecutionInfrastructure();

    if (refreshQueue) {
      return;
    }

    refreshQueue = new ProactiveRefreshQueue(
      client,
      store,
      (uuid) => {
        runtimeFactory?.invalidate(uuid);
        void manager?.refresh();
      },
    );
    refreshQueue.start();
  }

  async function initializeManagerFromStore(): Promise<boolean> {
    if (manager) {
      return manager.getAccountCount() > 0;
    }

    const storage = await store.load();
    if (storage.accounts.length === 0) {
      return false;
    }

    manager = await AccountManager.create(store, EMPTY_OAUTH_CREDENTIALS, client);
    await ensureExecutionInfrastructure();
    await startRefreshQueueIfNeeded();
    return manager.getAccountCount() > 0;
  }

  async function initializeManagerFromAuth(credentials: OAuthCredentials): Promise<void> {
    if (!manager) {
      manager = await AccountManager.create(store, credentials, client);
    }

    await ensureExecutionInfrastructure();
    await startRefreshQueueIfNeeded();
  }

  await initializeManagerFromStore().catch(() => {});

  return {
    "experimental.chat.system.transform": (input: Record<string, unknown>, output: { system?: string[] }) => {
      injectSystemPrompt(output);
      const billingHeader = buildBillingHeader(extractFirstUserText(input));
      if (billingHeader && !output.system?.includes(billingHeader)) {
        output.system?.unshift(billingHeader);
      }
    },

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

            if (account.rateLimitResetAt) {
              if (account.rateLimitResetAt > Date.now()) {
                const remaining = formatWaitTime(account.rateLimitResetAt - Date.now());
                statusParts.push(`RATE LIMITED (resets in ${remaining})`);
              } else {
                statusParts.push("RATE LIMIT RESET");
              }
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
            return handleAuthorize(manager, inputs, client);
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
          return { apiKey: "", fetch };
        }

        for (const model of Object.values((provider as Record<string, unknown>).models ?? {}) as Record<string, unknown>[]) {
          if (model) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
          }
        }

        const credentials = auth as OAuthCredentials;
        await migrateFromAuthJson("anthropic", store);
        await initializeManagerFromAuth(credentials);

        const initializedManager = manager;
        if (!initializedManager) {
          return { apiKey: "", fetch };
        }

        if (initializedManager.getAccountCount() > 0) {
          const activeAccount = initializedManager.getActiveAccount();
          const activeLabel = activeAccount ? getAccountLabel(activeAccount) : "none";
          void showToast(
            client,
            `Multi-Auth: ${initializedManager.getAccountCount()} account(s) loaded. Active: ${activeLabel}`,
            "info",
          );
          await initializedManager.validateNonActiveTokens(client);

          const disabledCount = initializedManager.getAccounts().filter((a) => a.isAuthDisabled).length;
          if (disabledCount > 0) {
            void showToast(
              client,
              `${disabledCount} account(s) have auth failures.`,
              "warning",
            );
          }
        }

        return {
          apiKey: "",
          "chat.headers": async (input: { provider?: { info?: { id?: string } } }, output: { headers: Record<string, string> }) => {
            if (input.provider?.info?.id !== ANTHROPIC_OAUTH_ADAPTER.authProviderId) return;
            output.headers["user-agent"] = getUserAgent();
            output.headers["anthropic-beta"] = ANTHROPIC_BETA_HEADER;
            output.headers["x-app"] = "cli";
          },
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            if (!initializedManager || !runtimeFactory) {
              return fetch(input, init);
            }

            if (initializedManager.getAccountCount() === 0) {
              throw new Error(
                "No Anthropic accounts configured. Run `opencode auth login` to add an account.",
              );
            }

            if (!poolManager || !cascadeStateManager) {
              poolManager = new PoolManager();
              poolManager.loadPools(poolChainConfig.pools);
              cascadeStateManager = new CascadeStateManager();
            }

            return executeWithAccountRotation(
              initializedManager,
              runtimeFactory,
              client,
              input,
              init,
              {
                poolManager,
                cascadeStateManager,
                poolChainConfig,
              },
            );
          },
        };
      },
    },
  };
};
