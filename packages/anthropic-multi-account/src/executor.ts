import { createExecutorForProvider, getClearedOAuthBody } from "opencode-multi-account-core";
import { ANTHROPIC_OAUTH_ADAPTER } from "./constants";
import type {
  CascadeStateManager,
  ExecutorAccountManager,
  ExecutorRuntimeFactory,
  PluginClient,
  PoolChainConfig,
  PoolManager,
  RateLimitAccountManager,
} from "opencode-multi-account-core";
import { handleRateLimitResponse as handleRateLimitResponseForProvider } from "./rate-limit";
import { executeWithPoolChainRotation } from "./pool-chain-executor";
import type { PoolChainAccountManager } from "./pool-chain-executor";
import { formatWaitTime, getAccountLabel, showToast, sleep } from "./utils";

const { executeWithAccountRotation: executeWithCoreAccountRotation } = createExecutorForProvider("Anthropic", {
  handleRateLimitResponse: async (manager, client, account, response) =>
    handleRateLimitResponseForProvider(
      manager as RateLimitAccountManager,
      client,
      account,
      response,
    ),
  formatWaitTime,
  sleep,
  showToast,
  getAccountLabel,
});

interface PoolChainExecutorOptions {
  poolManager: PoolManager;
  cascadeStateManager: CascadeStateManager;
  poolChainConfig: PoolChainConfig;
}

function isAllAccountsTerminalError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("All Anthropic accounts");
}

async function clearAuthIfNoUsableAccount(
  manager: ExecutorAccountManager,
  client: PluginClient,
): Promise<void> {
  await manager.refresh();
  if (manager.hasAnyUsableAccount()) return;

  await client.auth
    .set({
      path: { id: ANTHROPIC_OAUTH_ADAPTER.authProviderId },
      body: getClearedOAuthBody(),
    })
    .catch(() => {});
}

function hasPoolChainEntries(config: PoolChainConfig): boolean {
  return (config.pools?.length ?? 0) > 0 || (config.chains?.length ?? 0) > 0;
}

export async function executeWithAccountRotation(
  manager: ExecutorAccountManager,
  runtimeFactory: ExecutorRuntimeFactory,
  client: PluginClient,
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: PoolChainExecutorOptions,
): Promise<Response> {
  try {
    if (!options || !hasPoolChainEntries(options.poolChainConfig)) {
      return await executeWithCoreAccountRotation(manager, runtimeFactory, client, input, init);
    }

    return await executeWithPoolChainRotation(
      manager as unknown as PoolChainAccountManager,
      runtimeFactory,
      options.poolManager,
      options.cascadeStateManager,
      options.poolChainConfig,
      client,
      input,
      init,
    );
  } catch (error) {
    if (isAllAccountsTerminalError(error)) {
      await clearAuthIfNoUsableAccount(manager, client);
    }
    throw error;
  }
}
