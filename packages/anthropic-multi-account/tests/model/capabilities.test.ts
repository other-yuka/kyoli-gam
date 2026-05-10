import { afterEach, describe, expect, test } from "vitest";
import {
  getRuntimeModelCapability,
  ingestProviderModelsCapabilities,
  readProviderModels,
  resetRuntimeModelCapabilitiesForTest,
} from "../../src/model/capabilities";

afterEach(() => {
  resetRuntimeModelCapabilitiesForTest();
});

describe("model capabilities", () => {
  test("reads provider model records only", () => {
    const models = { "anthropic/claude-sonnet-4-6": { reasoning: true } };

    expect(readProviderModels({ models })).toBe(models);
    expect(readProviderModels({ models: [] })).toEqual({});
    expect(readProviderModels({ models: "invalid" })).toEqual({});
    expect(readProviderModels({})).toEqual({});
  });

  test("ignores non-object model metadata safely", () => {
    ingestProviderModelsCapabilities("invalid");

    expect(getRuntimeModelCapability("claude-sonnet-4-6")).toBeUndefined();
  });
});
