import type {
  NativePluginLifecycle,
  NativePluginLoaderResult,
  NativePluginManagerLike,
  NativePluginRuntimeFactoryLike,
} from "./native-plugin-lifecycle";

export interface OpenCodeNativeLoaderContext<
  TManager extends NativePluginManagerLike = NativePluginManagerLike,
> {
  auth: Record<string, unknown>;
  provider: Record<string, unknown>;
  lifecycle: NativePluginLifecycle<TManager>;
  manager: TManager | null;
  runtimeFactory: NativePluginRuntimeFactoryLike | null;
  result: NativePluginLoaderResult;
}

export interface OpenCodeNativeAuthLoaderOptions<
  TManager extends NativePluginManagerLike = NativePluginManagerLike,
> {
  lifecycle: NativePluginLifecycle<TManager>;
  debugLog?: (message: string, extra?: Record<string, unknown>) => void;
  beforeAuth?: (provider: Record<string, unknown>) => Promise<void> | void;
  beforeLoad?: (context: {
    auth: Record<string, unknown>;
    provider: Record<string, unknown>;
    lifecycle: NativePluginLifecycle<TManager>;
  }) => Promise<void> | void;
  afterLoad?: (
    context: OpenCodeNativeLoaderContext<TManager>,
  ) => Promise<NativePluginLoaderResult | void> | NativePluginLoaderResult | void;
}

function readProviderModels(provider: Record<string, unknown>): Record<string, unknown> {
  return provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)
    ? provider.models as Record<string, unknown>
    : {};
}

export function createOpenCodeNativeAuthLoader<
  TManager extends NativePluginManagerLike = NativePluginManagerLike,
>(
  options: OpenCodeNativeAuthLoaderOptions<TManager>,
) {
  return async function openCodeNativeAuthLoader(
    getAuth: () => Promise<unknown>,
    provider: Record<string, unknown>,
  ): Promise<NativePluginLoaderResult> {
    const providerModels = readProviderModels(provider);
    options.debugLog?.("Auth loader received provider metadata", {
      providerId: typeof provider.id === "string" ? provider.id : undefined,
      providerName: typeof provider.name === "string" ? provider.name : undefined,
      modelCount: Object.keys(providerModels).length,
      modelIds: Object.keys(providerModels),
    });
    await options.beforeAuth?.(provider);

    const auth = await getAuth() as Record<string, unknown>;
    options.debugLog?.("Auth loader resolved auth payload", {
      authType: typeof auth.type === "string" ? auth.type : undefined,
      authKeys: Object.keys(auth),
    });
    await options.beforeLoad?.({ auth, provider, lifecycle: options.lifecycle });

    const result = await options.lifecycle.load(auth, provider);
    const replacement = await options.afterLoad?.({
      auth,
      provider,
      lifecycle: options.lifecycle,
      manager: options.lifecycle.getManager(),
      runtimeFactory: options.lifecycle.getRuntimeFactory(),
      result,
    });

    if (auth.type !== "oauth") {
      options.debugLog?.("Auth loader attempted store recovery", {
        recoveredFromStore: Boolean(options.lifecycle.getManager()?.getAccountCount()),
      });
    } else {
      const manager = options.lifecycle.getManager();
      if (manager) {
        options.debugLog?.("Auth loader initialized manager state", {
          accountCount: manager.getAccountCount(),
          activeAccountUuid: manager.getActiveAccount?.()?.uuid,
        });
      }
    }

    return replacement ?? result;
  };
}
