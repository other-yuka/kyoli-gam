import type { Plugin } from "@opencode-ai/plugin";
import { composeClaudeCodeBillingSystemEntry } from "../../providers/claude-code/src/opencode-shared";
import {
  CascadeStateManager,
  createOpenCodeNativeAuthMethods,
  createOpenCodeNativeAuthLoader,
  createOpenCodeNativePluginLifecycle,
  loadPoolChainConfig,
  migrateFromAuthJson,
  PoolManager,
  type PoolChainConfig,
} from "opencode-multi-account-core";
import { AccountManager } from "./accounts/manager";
import { executeWithAccountRotation } from "./runtime/executor";
import { handleAuthorize } from "./auth-ux/handler";
import { loadConfig } from "./shared/config";
import { ProactiveRefreshQueue } from "./accounts/proactive-refresh";
import { AccountStore } from "./accounts/store";
import { AccountRuntimeFactory } from "./runtime/factory";
import { debugLog, getAccountLabel } from "./shared/utils";
import { ANTHROPIC_OAUTH_ADAPTER } from "./shared/constants";
import { claudeCodeIntegration } from "./claude-code";
import {
  getBetaHeader,
  getPerRequestHeaders,
  getStaticHeaders,
  orderHeadersForOutbound,
} from "./request/headers";
import { getUpstreamSessionId } from "./request/upstream-request";
import { syncBootstrapAuth } from "./oauth/bootstrap";
import { sanitizeError } from "./shared/error-utils";
import { getSessionId, startHeartbeat } from "./session-heartbeat";
import type { ManagedAccount, PluginClient } from "./shared/types";
import { ingestProviderModelsCapabilities, readProviderModels } from "./model/capabilities";

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
  return composeClaudeCodeBillingSystemEntry(firstUserMessage, version);
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

  const requestProfile = claudeCodeIntegration.loadRequestProfile();
  const template = requestProfile.template;
  const claudeIdentity = claudeCodeIntegration.loadIdentity();
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

  const getHeartbeatDeviceId = (account: Pick<ManagedAccount, "deviceId"> | null | undefined): string =>
    account?.deviceId || claudeIdentity.deviceId;

  const ensureHeartbeat = (
    accessToken: string | undefined,
    account?: Pick<ManagedAccount, "deviceId"> | null,
  ): void => {
    const deviceId = getHeartbeatDeviceId(account);
    if (!accessToken || !deviceId) {
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
      deviceId,
      accessToken,
    });
  };

  const startupDrift = claudeCodeIntegration.detectDrift(template);
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

  const compat = claudeCodeIntegration.checkCompat();
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

  void claudeCodeIntegration.refreshLiveFingerprint({ silent: true })
    .then((refreshedTemplate) => {
      const refreshedDrift = claudeCodeIntegration.detectDrift(refreshedTemplate ?? template);
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
  const syncBootstrapAuthForPhase = async (phase: "plugin-init" | "loader-recovery"): Promise<boolean> => {
    try {
      const synced = await syncBootstrapAuth(client, store);
      debugLog(client, "Bootstrap auth sync completed", { phase, synced });
      return synced;
    } catch (error) {
      client.app.log({
        body: {
          service: ANTHROPIC_OAUTH_ADAPTER.serviceLogName,
          level: "debug",
          message: "bootstrap auth sync failed",
          extra: {
            phase,
            error: sanitizeError(error),
          },
        },
      }).catch(() => {});
      return false;
    }
  };

  await syncBootstrapAuthForPhase("plugin-init");

  let poolManager: PoolManager | null = null;
  let cascadeStateManager: CascadeStateManager | null = null;
  let poolChainConfig: PoolChainConfig = { pools: [], chains: [] };

  async function ensurePoolInfrastructure(): Promise<void> {
    poolChainConfig = await loadPoolChainConfig();

    poolManager ??= new PoolManager();
    poolManager.loadPools(poolChainConfig.pools);
    cascadeStateManager ??= new CascadeStateManager();
  }

  const lifecycle = createOpenCodeNativePluginLifecycle({
    store,
    client,
    managerClass: AccountManager,
    createRuntimeFactory: () => new AccountRuntimeFactory(store, client, claudeIdentity),
    createRefreshQueue: (_client, _store, onInvalidate) =>
      new ProactiveRefreshQueue(client, store, (uuid) => {
        onInvalidate(uuid);
        void lifecycle.getManager()?.refresh();
      }),
    executeWithAccountRotation: async (activeManager, activeRuntimeFactory, _client, input, init) => {
      const activeAccount = activeManager.getActiveAccount();
      ensureHeartbeat(activeAccount?.accessToken, activeAccount);
      await ensurePoolInfrastructure();

      return executeWithAccountRotation(
        activeManager,
        activeRuntimeFactory,
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
    migrateFromAuthJson,
    afterManagerInitialized: async (activeManager) => {
      activeManager.setClient(client);
      const activeAccount = activeManager.getActiveAccount();
      ensureHeartbeat(activeAccount?.accessToken, activeAccount);
    },
    afterOAuthLoad: (credentials, activeManager) => {
      const activeAccount = activeManager.getActiveAccount?.();
      ensureHeartbeat(activeAccount?.accessToken ?? credentials.access, activeAccount);
    },
    createFetch: ({ getManager, getRuntimeFactory, defaultFetch }) => async (input, init) => {
      const activeManager = getManager();
      const activeRuntimeFactory = getRuntimeFactory();
      if (!activeManager || !activeRuntimeFactory) {
        stopHeartbeat();
        return fetch(input, init);
      }

      if (activeManager.getAccountCount() === 0) {
        stopHeartbeat();
      }

      return defaultFetch(input, init);
    },
    createLoaderExtras: async () => {
      const authProfile = await claudeCodeIntegration.loadAuthProfile();
      return {
        baseURL: authProfile.apiV1BaseUrl,
        "chat.headers": async (
          input: { provider?: { info?: { id?: string } } },
          output: { headers: Record<string, string> },
        ) => {
          if (input.provider?.info?.id !== ANTHROPIC_OAUTH_ADAPTER.authProviderId) return;

          const sessionId = getUpstreamSessionId();
          applyOrderedHeaders(output, {
            ...output.headers,
            ...getStaticHeaders(),
            ...getPerRequestHeaders(sessionId),
            "anthropic-beta": getBetaHeader(),
          });
        },
      };
    },
    authJsonProviderKey: "anthropic",
    oauthApiKey: "",
    noAccountsMessage: "No Anthropic accounts configured. Run `opencode auth login` to add an account.",
    getAccountLabel,
  });
  const authLoader = createOpenCodeNativeAuthLoader({
    lifecycle,
    debugLog: (message, extra) => debugLog(client, message, extra),
    beforeAuth: (provider) => {
      const providerModels = readProviderModels(provider);
      ingestProviderModelsCapabilities(providerModels);
    },
    beforeLoad: async ({ auth }) => {
      if (auth.type === "oauth") {
        return;
      }

      await syncBootstrapAuthForPhase("loader-recovery");
    },
    afterLoad: ({ auth, manager, runtimeFactory, result }) => {
      if (auth.type !== "oauth") {
        if (!manager?.getAccountCount() || !runtimeFactory) {
          stopHeartbeat();
          return { apiKey: "", fetch };
        }

        return result;
      }

      if (!manager) {
        return { apiKey: "", fetch };
      }

      return result;
    },
  });

  await lifecycle.load({ type: "api" }).catch(() => {});

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

    auth: {
      provider: ANTHROPIC_OAUTH_ADAPTER.authProviderId,
      methods: createOpenCodeNativeAuthMethods({
        oauthLabel: ANTHROPIC_OAUTH_ADAPTER.authMethodLabel,
        authorize: (inputs) => handleAuthorize(lifecycle.getManager(), inputs, client),
      }),

      loader: authLoader,
    },
  };
};
