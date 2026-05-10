import {
  createOpenCodeNativeAuthMethods,
  createOpenCodeNativeAuthLoader,
  createOpenCodeNativePluginLifecycle,
  migrateFromAuthJson,
} from "opencode-multi-account-core";
import { AccountManager } from "./account-manager";
import { executeWithAccountRotation } from "./executor";
import { handleAuthorize } from "./auth-handler";
import { loadConfig } from "./config";
import { ProactiveRefreshQueue } from "./proactive-refresh";
import { AccountStore } from "./account-store";
import { AccountRuntimeFactory } from "./runtime-factory";
import { debugLog, getAccountLabel } from "./utils";
import { OPENAI_OAUTH_ADAPTER } from "./constants";
import type { PluginClient } from "./types";

export const CodexMultiAuthPlugin = async (ctx: unknown) => {
  const { client } = ctx as unknown as { client: PluginClient } & Record<string, unknown>;

  await loadConfig();

  const store = new AccountStore();
  const lifecycle = createOpenCodeNativePluginLifecycle({
    store,
    client,
    managerClass: AccountManager,
    createRuntimeFactory: (accountStore, pluginClient) => new AccountRuntimeFactory(accountStore, pluginClient),
    createRefreshQueue: (pluginClient, accountStore, onInvalidate) =>
      new ProactiveRefreshQueue(pluginClient, accountStore, onInvalidate),
    executeWithAccountRotation,
    migrateFromAuthJson,
    authJsonProviderKey: "openai",
    oauthApiKey: "CODEX_OAUTH",
    noAccountsMessage: "No Codex accounts configured. Run `opencode auth login` to add an account.",
    getAccountLabel,
  });
  const authLoader = createOpenCodeNativeAuthLoader({
    lifecycle,
    debugLog: (message, extra) => debugLog(client, message, extra),
  });

  return {
    auth: {
      provider: OPENAI_OAUTH_ADAPTER.authProviderId,
      methods: createOpenCodeNativeAuthMethods({
        oauthLabel: OPENAI_OAUTH_ADAPTER.authMethodLabel,
        authorize: (inputs) => handleAuthorize(lifecycle.getManager(), inputs, client),
      }),

      loader: authLoader,
    },
  };
};
