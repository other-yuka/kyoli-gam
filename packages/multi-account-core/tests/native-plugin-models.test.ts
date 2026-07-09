import { describe, expect, test } from "vitest";
import { zeroCostProviderModels } from "../src/native-plugin-models";

describe("zeroCostProviderModels", () => {
  test("returns cloned provider models with zero display cost", async () => {
    const model = { id: "gpt-5.3-codex", cost: { input: 1, output: 2 }, limit: { output: 8192 } };
    const result = await zeroCostProviderModels({ models: { "openai/gpt-5.3-codex": model } });

    expect(result["openai/gpt-5.3-codex"]).toEqual({
      ...model,
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    });
    expect(result["openai/gpt-5.3-codex"]).not.toBe(model);
    expect(model.cost).toEqual({ input: 1, output: 2 });
  });
});
