import type { ModelInfo, ProviderAdapter, ProviderId } from "@kyoli-gam/core";
import { inferProviderFromModel, stripProviderPrefix } from "@kyoli-gam/core";
import { ModelsDevRegistrySource } from "./models-dev";

export { ModelsDevRegistrySource } from "./models-dev";

export interface ResolvedModel {
  model: ModelInfo;
  provider: ProviderId;
  upstreamId: string;
}

export class ModelRegistry {
  private readonly adapters: Map<ProviderId, ProviderAdapter>;
  private readonly modelsDev?: ModelsDevRegistrySource;

  constructor(
    adapters: ProviderAdapter[],
    options: { modelsDev?: ModelsDevRegistrySource } = {},
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.modelsDev = options.modelsDev;
  }

  async listModels(): Promise<ModelInfo[]> {
    const adapterModels = await Promise.all(
      [...this.adapters.values()].map((adapter) => adapter.listModels()),
    );
    const models = adapterModels.flat();

    if (this.modelsDev) {
      const remoteModels = await this.modelsDev.listModels([...this.adapters.keys()], models);
      models.unshift(...remoteModels);
    }

    return dedupeModels(models).sort((a, b) => a.id.localeCompare(b.id));
  }

  getAdapter(provider: ProviderId): ProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  async resolve(modelId: string): Promise<ResolvedModel | undefined> {
    const providerPrefix = inferProviderFromModel(modelId);
    const models = await this.listModels();

    if (providerPrefix) {
      const upstreamId = stripProviderPrefix(modelId);
      const model = models.find(
        (candidate) =>
          candidate.provider === providerPrefix &&
          (
            candidate.id === modelId ||
            candidate.upstreamId === upstreamId ||
            candidate.aliases?.includes(modelId) ||
            candidate.aliases?.includes(upstreamId)
          ),
      );
      return model
        ? {
            model,
            provider: model.provider,
            upstreamId: model.upstreamId,
          }
        : undefined;
    }

    const matches = models.filter(
      (model) => model.upstreamId === modelId || model.aliases?.includes(modelId),
    );

    if (matches.length !== 1) return undefined;

    const [model] = matches;
    return model
      ? {
          model,
          provider: model.provider,
          upstreamId: model.upstreamId,
        }
      : undefined;
  }

  startAutoRefresh(): void {
    this.modelsDev?.startAutoRefresh();
  }

  stopAutoRefresh(): void {
    this.modelsDev?.stopAutoRefresh();
  }
}

export function toOpenAIModelList(models: ModelInfo[]): { object: "list"; data: unknown[] } {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      owned_by: model.provider,
      kyoli: {
        provider: model.provider,
        upstream_id: model.upstreamId,
        display_name: model.displayName,
        capabilities: model.capabilities,
        aliases: model.aliases ?? [],
      },
    })),
  };
}

function dedupeModels(models: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const model of models) {
    byId.set(model.id, mergeModelInfo(byId.get(model.id), model));
  }
  return [...byId.values()];
}

function mergeModelInfo(existing: ModelInfo | undefined, next: ModelInfo): ModelInfo {
  if (!existing) return next;

  return {
    ...existing,
    ...next,
    aliases: [...new Set([...(existing.aliases ?? []), ...(next.aliases ?? [])])],
    capabilities: [...new Set([...existing.capabilities, ...next.capabilities])],
    metadata: {
      ...(existing.metadata ?? {}),
      ...(next.metadata ?? {}),
    },
  };
}
