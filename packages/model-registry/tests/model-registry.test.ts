import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@kyoli-gam/core";
import { ModelRegistry, ModelsDevRegistrySource, toOpenAIModelList } from "../src";

async function withSuspendedFable<T>(callback: () => Promise<T>): Promise<T> {
  const previous = process.env.KYOLI_SUSPENDED_CLAUDE_CODE_FAMILIES;
  process.env.KYOLI_SUSPENDED_CLAUDE_CODE_FAMILIES = "fable";
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.KYOLI_SUSPENDED_CLAUDE_CODE_FAMILIES;
    } else {
      process.env.KYOLI_SUSPENDED_CLAUDE_CODE_FAMILIES = previous;
    }
  }
}

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

  it("exports OpenAI model-list metadata with kyoli fields", async () => {
    const list = toOpenAIModelList([
      {
        id: "openai/gpt-test",
        provider: "codex",
        upstreamId: "gpt-test",
        displayName: "GPT Test",
        aliases: ["gpt-test", "codex/gpt-test"],
        capabilities: ["responses", "streaming"],
      },
    ]);

    expect(list).toEqual({
      object: "list",
      data: [
        {
          id: "openai/gpt-test",
          object: "model",
          owned_by: "codex",
          kyoli: {
            provider: "codex",
            upstream_id: "gpt-test",
            display_name: "GPT Test",
            capabilities: ["responses", "streaming"],
            aliases: ["gpt-test", "codex/gpt-test"],
          },
        },
      ],
    });
  });

  it("keeps Fable models enabled by default in models.dev", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kyoli-fable-models-dev-"));
    const localPath = join(dir, "api.json");
    await writeFile(localPath, JSON.stringify({
      anthropic: {
        models: {
          "claude-fable-5": {
            id: "claude-fable-5",
            name: "Claude Fable 5",
            reasoning: true,
            tool_call: true,
          },
        },
      },
    }));
    const registry = new ModelRegistry([
      adapter("claude-code", "anthropic/claude-sonnet-5", "claude-sonnet-5", ["claude-code/claude-sonnet-5"]),
    ], {
      modelsDev: new ModelsDevRegistrySource({
        sourceUrl: "https://models.dev",
        cachePath: join(dir, "cache.json"),
        localPath,
        disableFetch: true,
        refreshIntervalMs: 60_000,
        fetchTimeoutMs: 10_000,
      }),
    });

    await expect(registry.resolve("fable")).resolves.toMatchObject({
      provider: "claude-code",
      upstreamId: "claude-fable-5",
      model: expect.objectContaining({ id: "anthropic/claude-fable-5" }),
    });
  });

  it("filters suspended Fable models from models.dev", async () => {
    await withSuspendedFable(async () => {
      const dir = await mkdtemp(join(tmpdir(), "kyoli-fable-models-dev-"));
      const localPath = join(dir, "api.json");
      await writeFile(localPath, JSON.stringify({
        anthropic: {
          models: {
            "claude-fable-5": {
              id: "claude-fable-5",
              name: "Claude Fable 5",
              reasoning: true,
              tool_call: true,
            },
            "claude-sonnet-5": {
              id: "claude-sonnet-5",
              name: "Claude Sonnet 5",
              reasoning: true,
              tool_call: true,
            },
          },
        },
      }));
      const registry = new ModelRegistry([
        adapter("claude-code", "anthropic/claude-sonnet-5", "claude-sonnet-5", ["claude-code/claude-sonnet-5"]),
      ], {
        modelsDev: new ModelsDevRegistrySource({
          sourceUrl: "https://models.dev",
          cachePath: join(dir, "cache.json"),
          localPath,
          disableFetch: true,
          refreshIntervalMs: 60_000,
          fetchTimeoutMs: 10_000,
        }),
      });

      await expect(registry.resolve("fable")).resolves.toBeUndefined();
      await expect(registry.listModels()).resolves.not.toContainEqual(expect.objectContaining({
        id: "anthropic/claude-fable-5",
      }));
      await expect(registry.listModels()).resolves.toContainEqual(expect.objectContaining({
        id: "anthropic/claude-sonnet-5",
        capabilities: expect.arrayContaining(["messages", "reasoning", "tools"]),
      }));
    });
  });

  it("marks OpenAI models.dev Codex-family models as Codex-capable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kyoli-models-dev-"));
    const localPath = join(dir, "api.json");
    await writeFile(localPath, JSON.stringify({
      openai: {
        models: {
          "gpt-5.4-codex": {
            id: "gpt-5.4-codex",
            name: "GPT-5.4 Codex",
            family: "gpt-codex",
            reasoning: true,
            tool_call: true,
          },
        },
      },
    }));
    const registry = new ModelRegistry([adapter("codex", "codex/fallback", "fallback", [])], {
      modelsDev: new ModelsDevRegistrySource({
        sourceUrl: "https://models.dev",
        cachePath: join(dir, "cache.json"),
        localPath,
        disableFetch: true,
        refreshIntervalMs: 60_000,
        fetchTimeoutMs: 10_000,
      }),
    });

    await expect(registry.listModels()).resolves.toContainEqual(expect.objectContaining({
      id: "openai/gpt-5.4-codex",
      provider: "codex",
      upstreamId: "gpt-5.4-codex",
      capabilities: expect.arrayContaining(["chat", "responses", "codex", "reasoning", "tools"]),
    }));
  });
});

function adapter(
  provider: "codex" | "claude-code",
  id: string,
  upstreamId: string,
  aliases: string[],
): ProviderAdapter {
  return {
    id: provider,
    displayName: provider,
    routes: [provider === "codex" ? "/v1/responses" : "/v1/messages"],
    async listModels() {
      return [
        {
          id,
          provider,
          upstreamId,
          aliases,
          capabilities: provider === "codex" ? ["responses"] : ["messages"],
        },
      ];
    },
    async handleRequest() {
      return new Response(null, { status: 501 });
    },
  };
}
