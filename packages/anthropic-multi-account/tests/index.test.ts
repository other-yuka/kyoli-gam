import { describe, test, expect } from "bun:test";
import { ClaudeMultiAuthPlugin } from "../src/index";
import { getSystemPrompt } from "../src/request-transform";
import { createMockClient } from "./helpers";

describe("index", () => {
  test("injects system prompt exactly once", async () => {
    const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
    const transform = plugin["experimental.chat.system.transform"] as (
      input: unknown,
      output: { system?: string[] },
    ) => void;

    const output: { system?: string[] } = { system: ["existing"] };
    transform({}, output);
    transform({}, output);

    const systemPrompt = getSystemPrompt();
    expect(output.system).toContain(systemPrompt);
    expect(output.system?.filter((entry) => entry === systemPrompt)).toHaveLength(1);
  });

  test("does not inject billing header text into system prompts", async () => {
    const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
    const transform = plugin["experimental.chat.system.transform"] as (
      input: unknown,
      output: { system?: string[] },
    ) => void;

    const output: { system?: string[] } = { system: ["existing"] };
    transform(
      {
        messages: [{ role: "user", content: "hello from user" }],
      },
      output,
    );

    expect(output.system?.some((entry) => entry.startsWith("x-anthropic-billing-header:"))).toBe(false);
    expect(output.system?.some((entry) => entry.includes("cc_version="))).toBe(false);
  });

  test("auth loader keeps api-key fallback path", async () => {
    const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
    const auth = plugin.auth!;
    const loaded = await auth.loader!(
      async () => ({ type: "api", key: "" }),
      { id: "anthropic", name: "Anthropic", env: {}, models: {} } as any,
    );

    expect(loaded.apiKey).toBe("");
    expect(loaded.fetch).toBe(fetch);
  });
});
