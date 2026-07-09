import type { ModelInfo, ProviderAdapter, ProviderId } from "./index";

export interface ResolvedModel {
  model: ModelInfo;
  provider: ProviderId;
  upstreamId: string;
}

export class ModelRegistry {
  private readonly adapters: Map<ProviderId, ProviderAdapter>;

  constructor(adapters: ProviderAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  async listModels(): Promise<ModelInfo[]> {
    const adapterModels = await Promise.all(
      [...this.adapters.values()].map((adapter) => adapter.listModels()),
    );
    return dedupeModels(adapterModels.flat()).sort((a, b) => a.id.localeCompare(b.id));
  }

  getAdapter(provider: ProviderId): ProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  async resolve(modelId: string): Promise<ResolvedModel | undefined> {
    const providerPrefix = inferModelProvider(modelId);
    const models = await this.listModels();

    if (providerPrefix) {
      const upstreamId = stripModelProviderPrefix(modelId);
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
}

export function dedupeModels(models: ModelInfo[]): ModelInfo[] {
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

function inferModelProvider(model: string): ProviderId | undefined {
  const [prefix] = model.split("/", 1);
  if (prefix === "openai" || prefix === "codex") return "codex";
  if (prefix === "anthropic" || prefix === "claude-code") return "claude-code";
  return undefined;
}

function stripModelProviderPrefix(model: string): string {
  return inferModelProvider(model) && model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
}
