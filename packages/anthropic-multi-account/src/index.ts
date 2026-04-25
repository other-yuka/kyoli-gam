import { tool } from "@opencode-ai/plugin/tool";
import type { Plugin } from "@opencode-ai/plugin";
import {
  CascadeStateManager,
  loadPoolChainConfig,
  migrateFromAuthJson,
  PoolManager,
  type PoolChainConfig,
} from "opencode-multi-account-core";
import { AccountManager } from "./accounts/manager";
import { executeWithAccountRotation } from "./runtime/executor";
import { getPlanLabel, getUsageSummary } from "./usage";
import { handleAuthorize } from "./auth-ux/handler";
import { loadConfig } from "./shared/config";
import { ProactiveRefreshQueue } from "./accounts/proactive-refresh";
import { AccountStore } from "./accounts/store";
import { AccountRuntimeFactory } from "./runtime/factory";
import { debugLog, formatWaitTime, getAccountLabel, showToast } from "./shared/utils";
import { ANTHROPIC_OAUTH_ADAPTER } from "./shared/constants";
import { loadCCDerivedAuthProfile, loadCCDerivedRequestProfile } from "./claude-code/derived-profile";
import {
  checkCCCompat,
  detectDrift,
  refreshLiveFingerprintAsync,
} from "./claude-code/fingerprint/capture";
import {
  getBetaHeader,
  getPerRequestHeaders,
  getStaticHeaders,
  orderHeadersForOutbound,
} from "./request/headers";
import { computeBuildTag, getUpstreamSessionId } from "./request/upstream-request";
import { loadClaudeIdentity } from "./claude-code/identity";
import { syncBootstrapAuth } from "./oauth/bootstrap";
import { sanitizeError } from "./shared/error-utils";
import { getSessionId, startHeartbeat } from "./session-heartbeat";
import type { OAuthCredentials, PluginClient } from "./shared/types";
import { ingestProviderModelsCapabilities } from "./model/capabilities";

const EMPTY_OAUTH_CREDENTIALS: OAuthCredentials = {
  type: "oauth",
  refresh: "",
  access: "",
  expires: 0,
};

if (process.env.CLAUDE_MULTI_ACCOUNT_TRACE_PLUGIN === "1") {
  console.error("[anthropic-multi-account] module loaded");
}

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

function composeBillingSystemEntry(firstUserMessage: string, version: string): string {
  const buildTag = computeBuildTag(firstUserMessage, version);
  return `x-anthropic-billing-header: cc_version=${version}.${buildTag}; cc_entrypoint=sdk-cli; cch=00000;`;
}

function prependMissingSystemEntries(output: { system?: string[] }, entries: string[]): void {
  output.system ??= [];

  for (const entry of entries.toReversed()) {
    if (entry && !output.system.includes(entry)) {
      output.system.unshift(entry);
    }
  }
}

function applyOrderedHeaders(
  output: { headers: Record<string, string> },
  headers: Record<string, string>,
): void {
  const orderedHeaders = orderHeadersForOutbound(headers);
  output.headers = Array.isArray(orderedHeaders)
    ? Object.fromEntries(orderedHeaders)
    : orderedHeaders;
}

export const ClaudeMultiAuthPlugin: Plugin = async (ctx) => {
  if (process.env.CLAUDE_MULTI_ACCOUNT_TRACE_PLUGIN === "1") {
    console.error("[anthropic-multi-account] plugin function called");
  }

  const { client } = ctx as unknown as { client: PluginClient } & Record<string, unknown>;

  await loadConfig();

  const requestProfile = loadCCDerivedRequestProfile();
  const template = requestProfile.template;
  const claudeIdentity = loadClaudeIdentity();
  const claudeCodeVersion = template.cc_version ?? requestProfile.cliVersion;
  const upstreamAgentIdentity = template.agent_identity;
  const upstreamSystemPrompt = template.system_prompt;

  let heartbeatHandle: { stop(): void } | null = null;
  let heartbeatToken: string | null = null;
  let heartbeatSessionId: string | null = null;

  const stopHeartbeat = (): void => {
    heartbeatHandle?.stop();
    heartbeatHandle = null;
    heartbeatToken = null;
    heartbeatSessionId = null;
  };

  const ensureHeartbeat = (accessToken: string | undefined): void => {
    if (!accessToken || !claudeIdentity.deviceId) {
      stopHeartbeat();
      return;
    }

    const sessionId = getSessionId();

    if (heartbeatHandle && heartbeatToken === accessToken && heartbeatSessionId === sessionId) {
      return;
    }

    stopHeartbeat();
    heartbeatToken = accessToken;
    heartbeatSessionId = sessionId;
    heartbeatHandle = startHeartbeat({
      sessionId,
      deviceId: claudeIdentity.deviceId,
      accessToken,
    });
  };

  const ensurePoolInfrastructure = (): void => {
    if (!poolManager || !cascadeStateManager) {
      poolManager = new PoolManager();
      poolManager.loadPools(poolChainConfig.pools);
      cascadeStateManager = new CascadeStateManager();
    }
  };

  const createAuthLoaderResult = (
    activeManager: AccountManager | null,
  ): {
    apiKey: string;
    "chat.headers": (input: { provider?: { info?: { id?: string } } }, output: { headers: Record<string, string> }) => Promise<void>;
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  } => ({
    apiKey: "",
    "chat.headers": async (input, output) => {
      if (input.provider?.info?.id !== ANTHROPIC_OAUTH_ADAPTER.authProviderId) return;

      const sessionId = getUpstreamSessionId();
      applyOrderedHeaders(output, {
        ...output.headers,
        ...getStaticHeaders(),
        ...getPerRequestHeaders(sessionId),
        "anthropic-beta": getBetaHeader(),
      });
    },
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      if (!activeManager || !runtimeFactory) {
        stopHeartbeat();
        return fetch(input, init);
      }

      if (activeManager.getAccountCount() === 0) {
        stopHeartbeat();
        throw new Error(
          "No Anthropic accounts configured. Run `opencode auth login` to add an account.",
        );
      }

      ensureHeartbeat(activeManager.getActiveAccount()?.accessToken);
      ensurePoolInfrastructure();

      return executeWithAccountRotation(
        activeManager,
        runtimeFactory,
        client,
        input,
        init,
        {
          poolManager: poolManager!,
          cascadeStateManager: cascadeStateManager!,
          poolChainConfig,
        },
      );
    },
  });

  const startupDrift = detectDrift(template);
  if (startupDrift.drifted) {
    client.app.log({
      body: {
        service: ANTHROPIC_OAUTH_ADAPTER.serviceLogName,
        level: "warn",
        message: startupDrift.message,
        extra: {
          cachedVersion: startupDrift.cachedVersion,
          installedVersion: startupDrift.installedVersion,
        },
      },
    }).catch(() => {});
  }

  const compat = checkCCCompat();
  if (compat.status !== "ok" && compat.status !== "unknown") {
    client.app.log({
      body: {
        service: ANTHROPIC_OAUTH_ADAPTER.serviceLogName,
        level: "warn",
        message: compat.message,
        extra: {
          installedVersion: compat.installedVersion,
          range: compat.range,
        },
      },
    }).catch(() => {});
  }

  void refreshLiveFingerprintAsync({ silent: true })
    .then((refreshedTemplate) => {
      const refreshedDrift = detectDrift(refreshedTemplate ?? template);
      if (!refreshedDrift.drifted) {
        return;
      }

      return client.app.log({
        body: {
          service: ANTHROPIC_OAUTH_ADAPTER.serviceLogName,
          level: "warn",
          message: refreshedDrift.message,
          extra: {
            cachedVersion: refreshedDrift.cachedVersion,
            installedVersion: refreshedDrift.installedVersion,
          },
        },
      }).catch(() => {});
    })
    .catch((error) => {
      client.app.log({
        body: {
          service: ANTHROPIC_OAUTH_ADAPTER.serviceLogName,
          level: "debug",
          message: "live fingerprint refresh failed",
          extra: {
            error: sanitizeError(error),
          },
        },
      }).catch(() => {});
    });

  const store = new AccountStore();
  await syncBootstrapAuth(client, store)
    .then((synced) => {
      debugLog(client, "Bootstrap auth sync completed", { synced });
    })
    .catch((error) => {
      client.app.log({
        body: {
          service: ANTHROPIC_OAUTH_ADAPTER.serviceLogName,
          level: "debug",
          message: "bootstrap auth sync failed",
          extra: {
            error: sanitizeError(error),
          },
        },
      }).catch(() => {});
    });

  let manager: AccountManager | null = null;
  let runtimeFactory: AccountRuntimeFactory | null = null;
  let refreshQueue: ProactiveRefreshQueue | null = null;
  let poolManager: PoolManager | null = null;
  let cascadeStateManager: CascadeStateManager | null = null;
  let poolChainConfig: PoolChainConfig = { pools: [], chains: [] };

  async function ensureExecutionInfrastructure(): Promise<void> {
    runtimeFactory ??= new AccountRuntimeFactory(store, client, claudeIdentity);
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
    ensureHeartbeat(manager.getActiveAccount()?.accessToken);
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
    "experimental.chat.system.transform": async (
      input: Record<string, unknown>,
      output: { system?: string[] },
    ): Promise<void> => {
      const billingHeader = composeBillingSystemEntry(extractFirstUserText(input), claudeCodeVersion);
      prependMissingSystemEntries(output, [
        billingHeader,
        upstreamAgentIdentity,
        upstreamSystemPrompt,
      ]);
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
        const providerModels = (provider.models ?? {}) as Record<string, unknown>;
        ingestProviderModelsCapabilities(providerModels);
        debugLog(client, "Auth loader received provider metadata", {
          providerId: typeof provider.id === "string" ? provider.id : undefined,
          providerName: typeof provider.name === "string" ? provider.name : undefined,
          modelCount: Object.keys(providerModels).length,
          modelIds: Object.keys(providerModels),
        });

        const auth = await getAuth() as Record<string, unknown>;
        debugLog(client, "Auth loader resolved auth payload", {
          authType: typeof auth.type === "string" ? auth.type : undefined,
          authKeys: Object.keys(auth),
        });

        if (auth.type !== "oauth") {
          await syncBootstrapAuth(client, store)
            .then((synced) => {
              debugLog(client, "Auth loader requested bootstrap auth sync", { synced });
            })
            .catch((error) => {
              client.app.log({
                body: {
                  service: ANTHROPIC_OAUTH_ADAPTER.serviceLogName,
                  level: "debug",
                  message: "auth loader bootstrap sync failed",
                  extra: {
                    error: sanitizeError(error),
                  },
                },
              }).catch(() => {});
            });

          const recoveredFromStore = await initializeManagerFromStore();
          debugLog(client, "Auth loader attempted store recovery", {
            recoveredFromStore,
          });

          if (!recoveredFromStore || !manager || !runtimeFactory) {
            stopHeartbeat();
            return { apiKey: "", fetch };
          }

          const authProfile = await loadCCDerivedAuthProfile();

          return {
            ...createAuthLoaderResult(manager),
            baseURL: authProfile.apiV1BaseUrl,
          };
        }

        for (const model of Object.values(providerModels) as Record<string, unknown>[]) {
          if (model) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
          }
        }

        const credentials = auth as OAuthCredentials;
        await migrateFromAuthJson("anthropic", store);
        await initializeManagerFromAuth(credentials);
        ensureHeartbeat(credentials.access);

        const initializedManager = manager;
        if (!initializedManager) {
          return { apiKey: "", fetch };
        }

        debugLog(client, "Auth loader initialized manager state", {
          accountCount: initializedManager.getAccountCount(),
          activeAccountUuid: initializedManager.getActiveAccount()?.uuid,
        });

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

        const authProfile = await loadCCDerivedAuthProfile();

        return {
          ...createAuthLoaderResult(initializedManager),
          baseURL: authProfile.apiV1BaseUrl,
        };
      },
    },
  };
};
