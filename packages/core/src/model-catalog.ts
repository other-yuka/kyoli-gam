import type { ModelInfo } from "./index";

export interface CachedModelListOptions {
  fetchLive: () => Promise<readonly ModelInfo[]>;
  fallback: () => readonly ModelInfo[];
  ttlMs: number;
  now?: () => number;
}

export interface CachedModelList {
  listModels(): Promise<ModelInfo[]>;
  reset(): void;
}

export function createCachedModelList(options: CachedModelListOptions): CachedModelList {
  let cache: { expiresAt: number; models: ModelInfo[] } | undefined;
  const now = options.now ?? Date.now;

  return {
    async listModels() {
      if (cache && cache.expiresAt > now()) return cache.models;

      const liveModels = [...await options.fetchLive()];
      if (liveModels.length === 0) return [...options.fallback()];

      cache = {
        expiresAt: now() + options.ttlMs,
        models: liveModels,
      };
      return liveModels;
    },
    reset() {
      cache = undefined;
    },
  };
}
