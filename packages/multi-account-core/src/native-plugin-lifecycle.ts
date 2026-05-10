import type { OAuthCredentials, PluginClient } from "./types";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface NativePluginManagedAccount {
  uuid?: string;
  isAuthDisabled?: boolean;
}

export interface NativePluginStoreLike {
  load(): Promise<{ accounts: unknown[] }>;
}

export interface NativePluginManagerLike<TAccount extends NativePluginManagedAccount = NativePluginManagedAccount> {
  getAccountCount(): number;
  getAccounts(): TAccount[];
  getActiveAccount?(): TAccount | null;
  setRuntimeFactory(factory: NativePluginRuntimeFactoryLike): void;
  validateNonActiveTokens?(client: PluginClient): Promise<void>;
}

export interface NativePluginManagerClass<
  TStore extends NativePluginStoreLike,
  TManager extends NativePluginManagerLike,
> {
  create(store: TStore, currentAuth: OAuthCredentials, client?: PluginClient): Promise<TManager>;
}

export interface NativePluginRuntimeFactoryLike {
  getRuntime(uuid: string): Promise<{ fetch: FetchLike }>;
  invalidate(uuid: string): void;
}

export interface NativePluginRefreshQueueLike {
  start(): void;
  stop(): Promise<void> | void;
}

export interface NativePluginLifecycleOptions<
  TStore extends NativePluginStoreLike,
  TManager extends NativePluginManagerLike<TAccount>,
  TAccount extends NativePluginManagedAccount,
> {
  store: TStore;
  client: PluginClient;
  managerClass: NativePluginManagerClass<TStore, TManager>;
  createRuntimeFactory: (store: TStore, client: PluginClient) => NativePluginRuntimeFactoryLike;
  createRefreshQueue?: (
    client: PluginClient,
    store: TStore,
    onInvalidate: (uuid: string) => void,
  ) => NativePluginRefreshQueueLike;
  executeWithAccountRotation: (
    manager: TManager,
    runtimeFactory: NativePluginRuntimeFactoryLike,
    client: PluginClient,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  migrateFromAuthJson?: (providerKey: string, store: TStore) => Promise<boolean>;
  afterManagerInitialized?: (
    manager: TManager,
    runtimeFactory: NativePluginRuntimeFactoryLike,
  ) => Promise<void> | void;
  afterOAuthLoad?: (credentials: OAuthCredentials, manager: TManager) => Promise<void> | void;
  createFetch?: (context: {
    getManager: () => TManager | null;
    getRuntimeFactory: () => NativePluginRuntimeFactoryLike | null;
    defaultFetch: FetchLike;
  }) => FetchLike;
  createLoaderExtras?: (manager: TManager | null) => Promise<Record<string, unknown>> | Record<string, unknown>;
  authJsonProviderKey: string;
  oauthApiKey: string;
  noAccountsMessage: string;
  getAccountLabel: (account: TAccount) => string;
}

export interface NativePluginLoaderResult {
  apiKey: string;
  fetch: FetchLike;
  [key: string]: unknown;
}

export interface NativePluginLifecycle<TManager extends NativePluginManagerLike = NativePluginManagerLike> {
  getManager(): TManager | null;
  getRuntimeFactory(): NativePluginRuntimeFactoryLike | null;
  load(
    auth: Record<string, unknown>,
    provider?: Record<string, unknown>,
  ): Promise<NativePluginLoaderResult>;
}

const EMPTY_OAUTH_CREDENTIALS: OAuthCredentials = {
  type: "oauth",
  refresh: "",
  access: "",
  expires: 0,
};

function zeroProviderModelCosts(provider?: Record<string, unknown>): void {
  const models = provider?.models;
  if (!models || typeof models !== "object") {
    return;
  }

  for (const model of Object.values(models) as Record<string, unknown>[]) {
    if (model) {
      model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
    }
  }
}

export function createOpenCodeNativePluginLifecycle<
  TStore extends NativePluginStoreLike,
  TAccount extends NativePluginManagedAccount,
  TManager extends NativePluginManagerLike<TAccount>,
>(
  options: NativePluginLifecycleOptions<TStore, TManager, TAccount>,
): NativePluginLifecycle<TManager> {
  let manager: TManager | null = null;
  let runtimeFactory: NativePluginRuntimeFactoryLike | null = null;
  let refreshQueue: NativePluginRefreshQueueLike | null = null;

  const defaultFetch: FetchLike = async (input, init) => {
    if (!manager || !runtimeFactory) {
      return fetch(input, init);
    }

    if (manager.getAccountCount() === 0) {
      throw new Error(options.noAccountsMessage);
    }

    return options.executeWithAccountRotation(manager, runtimeFactory, options.client, input, init);
  };

  async function createLoaderResult(): Promise<NativePluginLoaderResult> {
    const fetchHandler = options.createFetch?.({
      getManager: () => manager,
      getRuntimeFactory: () => runtimeFactory,
      defaultFetch,
    }) ?? defaultFetch;
    const extras = await options.createLoaderExtras?.(manager);

    return {
      apiKey: options.oauthApiKey,
      fetch: fetchHandler,
      ...extras,
    };
  }

  async function createPassthroughResult(): Promise<NativePluginLoaderResult> {
    return {
      apiKey: "",
      fetch,
    };
  }

  async function initializeRuntimeFactory(): Promise<void> {
    if (!manager || !runtimeFactory) {
      return;
    }

    manager.setRuntimeFactory(runtimeFactory);
    await options.afterManagerInitialized?.(manager, runtimeFactory);
  }

  async function startRefreshQueueIfNeeded(): Promise<void> {
    if (!options.createRefreshQueue || !manager || !runtimeFactory || manager.getAccountCount() === 0) {
      return;
    }

    if (refreshQueue) {
      return;
    }

    refreshQueue = options.createRefreshQueue(
      options.client,
      options.store,
      (uuid) => runtimeFactory?.invalidate(uuid),
    );
    refreshQueue.start();
  }

  async function initializeManagerFromStore(): Promise<boolean> {
    if (manager) {
      return manager.getAccountCount() > 0;
    }

    const storage = await options.store.load();
    if (storage.accounts.length === 0) {
      return false;
    }

    manager = await options.managerClass.create(options.store, EMPTY_OAUTH_CREDENTIALS, options.client);
    runtimeFactory = options.createRuntimeFactory(options.store, options.client);
    await initializeRuntimeFactory();
    await startRefreshQueueIfNeeded();
    return manager.getAccountCount() > 0;
  }

  async function initializeManagerFromAuth(credentials: OAuthCredentials): Promise<void> {
    manager = await options.managerClass.create(options.store, credentials, options.client);
    runtimeFactory = options.createRuntimeFactory(options.store, options.client);
    await initializeRuntimeFactory();
  }

  async function restartRefreshQueueIfNeeded(): Promise<void> {
    if (refreshQueue) {
      await refreshQueue.stop();
      refreshQueue = null;
    }
    await startRefreshQueueIfNeeded();
  }

  return {
    getManager: () => manager,
    getRuntimeFactory: () => runtimeFactory,

    async load(auth, provider) {
      if (auth.type !== "oauth") {
        await options.migrateFromAuthJson?.(options.authJsonProviderKey, options.store);
        const recoveredFromStore = await initializeManagerFromStore();
        return recoveredFromStore ? createLoaderResult() : createPassthroughResult();
      }

      zeroProviderModelCosts(provider);

      const credentials = auth as OAuthCredentials;
      await options.migrateFromAuthJson?.(options.authJsonProviderKey, options.store);
      await initializeManagerFromAuth(credentials);

      const initializedManager = manager;
      if (!initializedManager) {
        return createPassthroughResult();
      }

      await options.afterOAuthLoad?.(credentials, initializedManager);

      if (initializedManager.getAccountCount() > 0) {
        const activeAccount = initializedManager.getActiveAccount?.();
        const activeLabel = activeAccount ? options.getAccountLabel(activeAccount) : "none";
        options.client.tui.showToast({
          body: {
            message: `Multi-Auth: ${initializedManager.getAccountCount()} account(s) loaded. Active: ${activeLabel}`,
            variant: "info",
          },
        }).catch(() => {});

        await initializedManager.validateNonActiveTokens?.(options.client);

        const disabledCount = initializedManager.getAccounts().filter((account) => account.isAuthDisabled).length;
        if (disabledCount > 0) {
          options.client.tui.showToast({
            body: {
              message: `${disabledCount} account(s) have auth failures.`,
              variant: "warning",
            },
          }).catch(() => {});
        }

        await restartRefreshQueueIfNeeded();
      }

      return createLoaderResult();
    },
  };
}
