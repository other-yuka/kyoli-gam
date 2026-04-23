import { createExecutorForProvider } from "opencode-multi-account-core";
import type {
  CascadeStateManager,
  ExecutorAccountManager,
  ExecutorRuntimeFactory,
  PoolChainConfig,
  PoolManager,
} from "opencode-multi-account-core";
import { handleRateLimitResponse as handleRateLimitResponseForProvider } from "../accounts/rate-limit";
import { formatWaitTime, getAccountLabel, showToast, sleep } from "../shared/utils";
import type { ManagedAccount, PluginClient } from "../shared/types";

interface PoolChainQueueEntry {
  accountUuid: string;
  chainIndex?: number;
}

type RateLimitManager = Parameters<typeof handleRateLimitResponseForProvider>[0];

export interface PoolChainAccountManager extends ExecutorAccountManager, RateLimitManager {
  getAccounts(): ManagedAccount[];
  isRateLimited(account: ManagedAccount): boolean;
  getActiveAccount(): ManagedAccount | null;
}

function buildCascadePrompt(input: RequestInfo | URL, init?: RequestInit): string {
  if (typeof init?.body === "string" && init.body.length > 0) {
    return init.body;
  }

  const method = init?.method ?? "GET";
  return `${method}:${String(input)}`;
}

function createQueueAwareManager(
  manager: PoolChainAccountManager,
  queue: PoolChainQueueEntry[],
  cascadeStateManager: CascadeStateManager,
): PoolChainAccountManager {
  return Object.create(manager, {
    selectAccount: { value: async function selectAccount(stickyKey?: string) {
      await manager.refresh();

      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;

        const account = manager
          .getAccounts()
          .find((candidate) => candidate.uuid === next.accountUuid);

        if (!account?.uuid) continue;
        if (!account.enabled || account.isAuthDisabled) continue;
        if (manager.isRateLimited(account)) continue;

        cascadeStateManager.markAttempted(account.uuid);
        if (next.chainIndex !== undefined) {
          cascadeStateManager.markVisitedChainIndex(next.chainIndex);
        }
        return account;
      }

      return manager.selectAccount(stickyKey);
    }},
  });
}

export async function executeWithPoolChainRotation(
  manager: PoolChainAccountManager,
  runtimeFactory: ExecutorRuntimeFactory,
  poolManager: PoolManager,
  cascadeStateManager: CascadeStateManager,
  poolChainConfig: PoolChainConfig,
  client: PluginClient,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const cascadePrompt = buildCascadePrompt(input, init);
  const currentAccountUuid = manager.getActiveAccount()?.uuid;
  cascadeStateManager.startTurn(cascadePrompt, currentAccountUuid);

  const queue: PoolChainQueueEntry[] = [];
  const queuedAccountUuids = new Set<string>();
  const queueAwareManager = createQueueAwareManager(manager, queue, cascadeStateManager);

  const { executeWithAccountRotation } = createExecutorForProvider("Anthropic", {
    handleRateLimitResponse: async (rawManager, rawClient, account, response) => {
      await handleRateLimitResponseForProvider(
        rawManager as Parameters<typeof handleRateLimitResponseForProvider>[0],
        rawClient,
        account,
        response,
      );

      if (!account.uuid) return;

      poolManager.markExhausted(account.uuid);
      cascadeStateManager.markAttempted(account.uuid);

      const cascadeState = cascadeStateManager.ensureCascadeState(cascadePrompt, account.uuid);
      const failoverPlan = await poolManager.buildFailoverPlan(
        account,
        poolChainConfig,
        manager,
        {
          attemptedAccounts: cascadeState.attemptedAccounts,
          visitedChainIndexes: cascadeState.visitedChainIndexes,
        },
      );

      for (const candidate of failoverPlan.candidates) {
        if (queuedAccountUuids.has(candidate.accountUuid)) continue;
        queue.push({
          accountUuid: candidate.accountUuid,
          chainIndex: candidate.chainIndex,
        });
        queuedAccountUuids.add(candidate.accountUuid);
      }
    },
    formatWaitTime,
    sleep,
    showToast,
    getAccountLabel,
  });

  try {
    return await executeWithAccountRotation(
      queueAwareManager,
      runtimeFactory,
      client,
      input,
      init,
    );
  } finally {
    cascadeStateManager.clearCascadeState();
  }
}
