import { describe, expect, it } from "vitest";
import type { ModelInfo, ProviderAdapter, ProviderId } from "../src";
import { createCachedModelList, ModelRegistry } from "../src";

describe("ModelRegistry", () => {
  it("resolves unprefixed aliases only when they are unique", async () => {
    const registry = new ModelRegistry([
      adapter("codex", "openai/gpt-test", "gpt-test", ["shared", "codex/gpt-test"]),
      adapter("claude-code", "anthropic/claude-test", "claude-test", ["shared", "claude-code/claude-test"]),
    ]);

    expect(await registry.resolve("gpt-test")).toMatchObject({
      provider: "codex",
      upstreamId: "gpt-test",
    });
    expect(await registry.resolve("openai/gpt-test")).toMatchObject({
      provider: "codex",
      upstreamId: "gpt-test",
    });
    expect(await registry.resolve("codex/gpt-test")).toMatchObject({
      provider: "codex",
      upstreamId: "gpt-test",
    });
    expect(await registry.resolve("anthropic/claude-test")).toMatchObject({
      provider: "claude-code",
      upstreamId: "claude-test",
    });
    expect(await registry.resolve("shared")).toBeUndefined();
  });

  it("dedupes provider models while preserving aliases and metadata", async () => {
    const registry = new ModelRegistry([
      provider("codex", [
        model("codex", "openai/gpt-test", "gpt-test", ["gpt-test"], { a: true }),
        model("codex", "openai/gpt-test", "gpt-test", ["codex/gpt-test"], { b: true }),
      ]),
    ]);

    await expect(registry.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "openai/gpt-test",
        aliases: ["gpt-test", "codex/gpt-test"],
        metadata: { a: true, b: true },
      }),
    ]);
  });
});

describe("createCachedModelList", () => {
  it("caches non-empty live models and falls back for empty live results", async () => {
    let now = 1_000;
    let calls = 0;
    const live = [model("codex", "openai/live", "live")];
    const fallback = [model("codex", "openai/fallback", "fallback")];
    const catalog = createCachedModelList({
      ttlMs: 100,
      now: () => now,
      fetchLive: async () => {
        calls += 1;
        return calls === 1 ? [] : live;
      },
      fallback: () => fallback,
    });

    await expect(catalog.listModels()).resolves.toEqual(fallback);
    await expect(catalog.listModels()).resolves.toEqual(live);
    await expect(catalog.listModels()).resolves.toEqual(live);
    expect(calls).toBe(2);

    now += 101;
    await expect(catalog.listModels()).resolves.toEqual(live);
    expect(calls).toBe(3);
  });
});

function adapter(providerId: ProviderId, id: string, upstreamId: string, aliases: string[] = []): ProviderAdapter {
  return provider(providerId, [model(providerId, id, upstreamId, aliases)]);
}

function provider(providerId: ProviderId, models: ModelInfo[]): ProviderAdapter {
  return {
    id: providerId,
    displayName: providerId,
    routes: [],
    async listModels() {
      return models;
    },
    async handleRequest() {
      return Response.json({ ok: true });
    },
  };
}

function model(
  providerId: ProviderId,
  id: string,
  upstreamId: string,
  aliases: string[] = [],
  metadata?: Record<string, unknown>,
): ModelInfo {
  return {
    id,
    provider: providerId,
    upstreamId,
    aliases,
    capabilities: ["streaming"],
    metadata,
  };
}
