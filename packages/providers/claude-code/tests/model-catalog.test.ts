import { afterEach, describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@kyoli-gam/core";
import { ModelRegistry } from "@kyoli-gam/core";
import {
  _resetClaudeCodeModelCatalogForTest,
  buildClaudeCodeModels,
} from "../src/model-catalog";
import {
  aliasesForClaudeCodeModel,
  resolveClaudeCodeModelAlias,
  setCachedClaudeCodeBaseModels,
  toClaudeCodeWireModelId,
} from "../src/model-aliases";

describe("Claude Code dated model catalog aliases", () => {
  afterEach(() => {
    _resetClaudeCodeModelCatalogForTest();
  });

  it("resolves canonical undated aliases to a dated upstream model", async () => {
    const models = buildClaudeCodeModels([
      { id: "claude-sonnet-4-6-20260115", displayName: "Claude Sonnet 4.6" },
    ]);
    const provider: ProviderAdapter = {
      id: "claude-code",
      displayName: "Claude Code OAuth",
      routes: ["/v1/messages"],
      async listModels() {
        return models;
      },
      async handleRequest() {
        return Response.json({ ok: true });
      },
    };
    const registry = new ModelRegistry([provider]);

    for (const modelId of [
      "claude-sonnet-4-6",
      "anthropic/claude-sonnet-4-6",
      "claude-code/claude-sonnet-4-6",
    ]) {
      const resolved = await registry.resolve(modelId);
      expect(resolved?.upstreamId).toBe("claude-sonnet-4-6-20260115");
      expect(toClaudeCodeWireModelId(resolved?.upstreamId ?? "")).toBe(
        "claude-sonnet-4-6-20260115",
      );
      expect(toClaudeCodeWireModelId(modelId)).toBe("claude-sonnet-4-6-20260115");
    }

    const base = models.find((model) => model.upstreamId === "claude-sonnet-4-6-20260115");
    expect(base?.aliases).toEqual(expect.arrayContaining([
      "claude-sonnet-4-6",
      "anthropic/claude-sonnet-4-6",
      "claude-code/claude-sonnet-4-6",
      "sonnet46",
      "anthropic/sonnet46",
    ]));
    const longContext = models.find((model) => model.upstreamId === "claude-sonnet-4-6-20260115[1m]");
    expect(longContext?.aliases).toEqual(expect.arrayContaining([
      "claude-sonnet-4-6[1m]",
      "anthropic/claude-sonnet-4-6[1m]",
      "sonnet1m",
    ]));
    for (const modelId of [
      "claude-sonnet-4-6[1m]",
      "anthropic/claude-sonnet-4-6[1m]",
      "claude-code/claude-sonnet-4-6[1m]",
    ]) {
      const resolved = await registry.resolve(modelId);
      expect(resolved?.upstreamId).toBe("claude-sonnet-4-6-20260115[1m]");
      expect(toClaudeCodeWireModelId(modelId)).toBe("claude-sonnet-4-6-20260115");
    }
    for (const modelId of ["sonnet46", "anthropic/sonnet46", "claude-code/sonnet46"]) {
      const resolved = await registry.resolve(modelId);
      expect(resolved?.upstreamId).toBe("claude-sonnet-4-6-20260115");
      expect(toClaudeCodeWireModelId(modelId)).toBe("claude-sonnet-4-6-20260115");
    }
    expect(models).toHaveLength(2);
  });

  it("keeps a canonical undated catalog entry as the only model row", () => {
    const models = buildClaudeCodeModels([
      { id: "claude-sonnet-4-6-20260115" },
      { id: "claude-sonnet-4-6" },
    ]);

    expect(models.filter((model) => model.upstreamId.startsWith("claude-sonnet-4-6")))
      .toHaveLength(2);
    expect(models.find((model) => model.upstreamId === "claude-sonnet-4-6")?.aliases)
      .not.toContain("claude-sonnet-4-6-20260115");
  });

  it("prefers an exact canonical id when dated and undated ids coexist", () => {
    setCachedClaudeCodeBaseModels([
      "claude-sonnet-4-6",
      "claude-sonnet-4-6-20260115",
    ]);

    expect(resolveClaudeCodeModelAlias("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(toClaudeCodeWireModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(aliasesForClaudeCodeModel("claude-sonnet-4-6-20260115", [
      "claude-sonnet-4-6",
      "claude-sonnet-4-6-20260115",
    ])).not.toContain("claude-sonnet-4-6");
  });

  it("does not synthesize an alias when dated catalog matches are ambiguous", () => {
    const baseIds = [
      "claude-sonnet-4-6-20260115",
      "claude-sonnet-4-6-20260215",
    ];

    expect(aliasesForClaudeCodeModel("claude-sonnet-4-6-20260115", baseIds))
      .not.toContain("claude-sonnet-4-6");
  });

  it("does not add aliases to non-dated model ids", () => {
    const models = buildClaudeCodeModels([{ id: "claude-sonnet-4-6" }]);
    const base = models.find((model) => model.upstreamId === "claude-sonnet-4-6");

    expect(base?.aliases).not.toContain("claude-sonnet-4-6-20260115");
  });

  it("does not synthesize aliases for pre-4.6 dated ids", () => {
    const models = buildClaudeCodeModels([{ id: "claude-opus-4-5-20251101" }]);
    const base = models.find((model) => model.upstreamId === "claude-opus-4-5-20251101");

    expect(base?.aliases).not.toContain("claude-opus-4-5");
    expect(base?.aliases).not.toContain("anthropic/claude-opus-4-5");
  });
});
