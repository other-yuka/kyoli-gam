import { describe, test, expect } from "bun:test";
import { ClaudeMultiAuthPlugin } from "../src/index";
import { getSystemPrompt } from "../src/request-transform";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createMockClient, setupTestEnv } from "./helpers";

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

  test("plugin init bootstraps auth from stored account", async () => {
    const { dir, cleanup } = await setupTestEnv();
    try {
      await fs.writeFile(join(dir, "anthropic-multi-account-accounts.json"), JSON.stringify({
        version: 1,
        activeAccountUuid: "account-1",
        accounts: [
          {
            uuid: "account-1",
            refreshToken: "refresh-1",
            accessToken: "access-1",
            expiresAt: 123456,
            addedAt: 1,
            lastUsed: 1,
            enabled: true,
            planTier: "",
            consecutiveAuthFailures: 0,
            isAuthDisabled: false,
          },
        ],
      }), "utf-8");

      const client = createMockClient();
      const authSetCalls: Array<unknown> = [];
      client.auth.set = async (params) => {
        authSetCalls.push(params);
      };

      await ClaudeMultiAuthPlugin({ client } as any);

      expect(authSetCalls).toHaveLength(1);
      expect(authSetCalls[0]).toEqual({
        path: { id: "anthropic" },
        body: {
          type: "oauth",
          refresh: "refresh-1",
          access: "access-1",
          expires: 123456,
        },
      });
    } finally {
      await cleanup();
    }
  });

  test("plugin init eagerly loads stored accounts for status tool", async () => {
    const { dir, cleanup } = await setupTestEnv();
    try {
      await fs.writeFile(join(dir, "anthropic-multi-account-accounts.json"), JSON.stringify({
        version: 1,
        activeAccountUuid: "account-1",
        accounts: [
          {
            uuid: "account-1",
            email: "user@example.com",
            refreshToken: "refresh-1",
            accessToken: "access-1",
            expiresAt: Date.now() + 60_000,
            addedAt: 1,
            lastUsed: 1,
            enabled: true,
            planTier: "max",
            consecutiveAuthFailures: 0,
            isAuthDisabled: false,
          },
        ],
      }), "utf-8");

      const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
      const statusTool = plugin.tool?.claude_multiauth_status;
      expect(statusTool).toBeDefined();
      if (!statusTool) {
        throw new Error("Expected claude_multiauth_status tool to be defined");
      }
      const result = await statusTool.execute({}, {} as never);

      expect(result).toContain("Multi-Auth Status (1 accounts)");
      expect(result).not.toContain("Multi-auth not initialized");
    } finally {
      await cleanup();
    }
  });
});
