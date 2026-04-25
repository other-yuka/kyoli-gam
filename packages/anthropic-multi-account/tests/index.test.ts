import { afterEach, describe, expect, test, vi } from "bun:test";
import {
  resetClaudeIdentityForTest,
  setClaudeIdentityForTest,
} from "../src/claude-code/identity";
import { loadTemplate } from "../src/claude-code/fingerprint/capture";
import { getRuntimeModelCapability, resetRuntimeModelCapabilitiesForTest } from "../src/model/capabilities";
import {
  resetHeartbeatForTest,
  setHeartbeatTestOverridesForTest,
} from "../src/session-heartbeat";
import {
  resetUpstreamRequestForTest,
  setUpstreamRequestTestOverridesForTest,
} from "../src/request/upstream-request";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../src/shared/config";
import { createMockClient, setupTestEnv } from "./helpers";

const startHeartbeatMock = vi.fn();

const {
  ClaudeMultiAuthPlugin,
} = await import("../src/index");

afterEach(() => {
  startHeartbeatMock.mockClear();
  resetClaudeIdentityForTest();
  resetHeartbeatForTest();
  resetRuntimeModelCapabilitiesForTest();
  resetUpstreamRequestForTest();
  resetConfigCache();
});

describe("index", () => {
  test("injects upstream template system entries exactly once", async () => {
    const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
    const transform = plugin["experimental.chat.system.transform"] as (
      input: unknown,
      output: { system?: string[] },
    ) => Promise<void>;
    const template = loadTemplate();

    const output: { system?: string[] } = { system: ["existing"] };
    await transform({}, output);
    await transform({}, output);

    expect(output.system).toContain(template.agent_identity);
    expect(output.system?.filter((entry) => entry === template.agent_identity)).toHaveLength(1);
    expect(output.system).toContain(template.system_prompt);
    expect(output.system?.filter((entry) => entry === template.system_prompt)).toHaveLength(1);
    expect(output.system?.[0]).toContain("x-anthropic-billing-header: cc_version=");
  });

  test("auth loader keeps api-key fallback path when store is empty", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
      const auth = plugin.auth!;
      const loaded = await auth.loader!(
        async () => ({ type: "api", key: "" }),
        { id: "anthropic", name: "Anthropic", env: {}, models: {} } as any,
      );

      expect(loaded.apiKey).toBe("");
      expect(loaded.fetch).toBe(fetch);
    } finally {
      await cleanup();
    }
  });

  test("auth loader recovers from store when auth payload is not oauth", async () => {
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
            expiresAt: Date.now() + 60_000,
            addedAt: 1,
            lastUsed: 1,
            enabled: true,
            planTier: "",
            consecutiveAuthFailures: 0,
            isAuthDisabled: false,
          },
        ],
      }), "utf-8");

      const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
      const auth = plugin.auth!;
      const loaded = await auth.loader!(
        async () => ({ type: "api", key: "" }),
        { id: "anthropic", name: "Anthropic", env: {}, models: {} } as any,
      );

      expect(loaded.apiKey).toBe("");
      expect(loaded.baseURL).toBe("https://api.anthropic.com/v1");
      expect(loaded.fetch).not.toBe(fetch);
    } finally {
      await cleanup();
    }
  });

  test("auth loader returns Anthropic v1 baseURL for oauth mode", async () => {
    const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
    const auth = plugin.auth!;
    const loaded = await auth.loader!(
      async () => ({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
      { id: "anthropic", name: "Anthropic", env: {}, models: {} } as any,
    );

    expect(loaded.apiKey).toBe("");
    expect(loaded.baseURL).toBe("https://api.anthropic.com/v1");
  });

  test("auth loader receives provider.models metadata when available", async () => {
    const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
    const auth = plugin.auth!;
    await auth.loader!(
      async () => ({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
      {
        id: "anthropic",
        name: "Anthropic",
        env: {},
        models: {
          "anthropic/claude-sonnet-4-6": {
            id: "anthropic/claude-sonnet-4-6",
            limit: { context: 200_000, output: 64_000 },
            reasoning: true,
            temperature: true,
            toolCall: true,
          },
        },
      } as any,
    );

    expect(getRuntimeModelCapability("claude-sonnet-4-6")).toEqual({
      maxOutputTokens: 64_000,
      supportsThinking: true,
    });
  });

  test("auth loader emits debug logs for auth and provider models when debug is enabled", async () => {
    const { dir, cleanup } = await setupTestEnv();
    const client = createMockClient();

    try {
      await fs.writeFile(join(dir, "claude-multiauth.json"), JSON.stringify({ debug: true }), "utf-8");
      await loadConfig();
      const plugin = await ClaudeMultiAuthPlugin({ client } as any);
      const auth = plugin.auth!;

      await auth.loader!(
        async () => ({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
        {
          id: "anthropic",
          name: "Anthropic",
          env: {},
          models: {
            "anthropic/claude-sonnet-4-6": {
              id: "anthropic/claude-sonnet-4-6",
              limit: { output: 64_000 },
              reasoning: true,
            },
          },
        } as any,
      );

      expect(client.logs.some((entry) => entry.message === "Auth loader received provider metadata")).toBe(true);
      expect(client.logs.some((entry) => entry.message === "Auth loader resolved auth payload")).toBe(true);
      expect(client.logs.some((entry) => entry.message === "Auth loader initialized manager state")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("auth loader starts heartbeat immediately after oauth manager initialization", async () => {
    const { cleanup } = await setupTestEnv();
    let currentTime = 1_000;
    setClaudeIdentityForTest({ deviceId: "device-test", accountUuid: "account-test" });
    setUpstreamRequestTestOverridesForTest({
      now: () => currentTime,
      createSessionId: () => "session-test",
    });
    setHeartbeatTestOverridesForTest({
      onStart: startHeartbeatMock,
    });

    try {
      const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
      const auth = plugin.auth!;

      await auth.loader!(
        async () => ({ type: "oauth", access: "access-now", refresh: "refresh", expires: Date.now() + 60_000 }),
        { id: "anthropic", name: "Anthropic", env: {}, models: {} } as any,
      );

      expect(startHeartbeatMock).toHaveBeenCalledTimes(1);
      expect(startHeartbeatMock).toHaveBeenCalledWith({
        sessionId: "session-test",
        deviceId: expect.stringMatching(/.+/),
        accessToken: expect.stringMatching(/.+/),
      });
    } finally {
      await cleanup();
    }
  });

  test("auth loader restarts heartbeat when upstream session id rotates after idle", async () => {
    const { cleanup } = await setupTestEnv();
    let currentTime = 1_000;
    const sessionIds = ["session-initial", "session-rotated"];

    setClaudeIdentityForTest({ deviceId: "device-test", accountUuid: "account-test" });

    setUpstreamRequestTestOverridesForTest({
      now: () => currentTime,
      createSessionId: () => sessionIds.shift() ?? "session-fallback",
    });
    setHeartbeatTestOverridesForTest({
      onStart: startHeartbeatMock,
    });

    try {
      const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
      const auth = plugin.auth!;
      const getAuth = async (): Promise<{
        type: "oauth";
        access: string;
        refresh: string;
        expires: number;
      }> => ({
        type: "oauth",
        access: "access-now",
        refresh: "refresh",
        expires: currentTime + 60_000,
      });

      await auth.loader!(
        getAuth,
        { id: "anthropic", name: "Anthropic", env: {}, models: {} } as any,
      );

      currentTime += 16 * 60 * 1_000;

      await auth.loader!(
        getAuth,
        { id: "anthropic", name: "Anthropic", env: {}, models: {} } as any,
      );

      expect(startHeartbeatMock).toHaveBeenCalledTimes(2);
      expect(startHeartbeatMock.mock.calls[0]?.[0]).toMatchObject({ sessionId: "session-initial" });
      expect(startHeartbeatMock.mock.calls[1]?.[0]).toMatchObject({ sessionId: "session-rotated" });
    } finally {
      await cleanup();
    }
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
