import { describe, expect, test, vi } from "vitest";
import { createOpenCodeNativeAuthLoader } from "../src/native-plugin-loader";
import type { NativePluginLifecycle, NativePluginLoaderResult } from "../src/native-plugin-lifecycle";

function createLifecycle(result: NativePluginLoaderResult): NativePluginLifecycle {
  return {
    getManager: () => null,
    getRuntimeFactory: () => null,
    load: vi.fn(async () => result),
  };
}

describe("createOpenCodeNativeAuthLoader", () => {
  test("runs hooks around lifecycle load", async () => {
    const lifecycle = createLifecycle({ apiKey: "OAUTH", fetch });
    const calls: string[] = [];
    const loader = createOpenCodeNativeAuthLoader({
      lifecycle,
      beforeAuth: () => {
        calls.push("beforeAuth");
      },
      beforeLoad: () => {
        calls.push("beforeLoad");
      },
      afterLoad: ({ result }) => {
        calls.push(`afterLoad:${result.apiKey}`);
      },
    });

    const result = await loader(async () => ({ type: "oauth" }), { models: {} });

    expect(result.apiKey).toBe("OAUTH");
    expect(lifecycle.load).toHaveBeenCalledWith({ type: "oauth" }, { models: {} });
    expect(calls).toEqual([
      "beforeAuth",
      "beforeLoad",
      "afterLoad:OAUTH",
    ]);
  });

  test("allows afterLoad to replace lifecycle result", async () => {
    const replacement = { apiKey: "", fetch };
    const loader = createOpenCodeNativeAuthLoader({
      lifecycle: createLifecycle({ apiKey: "OAUTH", fetch }),
      afterLoad: () => replacement,
    });

    const result = await loader(async () => ({ type: "api" }), {});

    expect(result).toBe(replacement);
  });

  test("emits common debug events when configured", async () => {
    const debugLog = vi.fn();
    const loader = createOpenCodeNativeAuthLoader({
      lifecycle: createLifecycle({ apiKey: "OAUTH", fetch }),
      debugLog,
    });

    await loader(async () => ({ type: "oauth", access: "a" }), {
      id: "openai",
      name: "OpenAI",
      models: {
        "openai/gpt-5.3-codex": {},
      },
    });

    expect(debugLog).toHaveBeenCalledWith("Auth loader received provider metadata", {
      providerId: "openai",
      providerName: "OpenAI",
      modelCount: 1,
      modelIds: ["openai/gpt-5.3-codex"],
    });
    expect(debugLog).toHaveBeenCalledWith("Auth loader resolved auth payload", {
      authType: "oauth",
      authKeys: ["type", "access"],
    });
  });
});
