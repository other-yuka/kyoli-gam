import { afterEach, describe, expect, test, vi } from "vitest";
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
import { createRealisticRequestPayload } from "./fixtures/realistic-request-payload";

const startHeartbeatMock = vi.fn();

const {
  ClaudeMultiAuthPlugin,
} = await import("../src/index");

function toHeaders(headers: HeadersInit | undefined): Headers {
  return new Headers(headers);
}

function getBlockTexts(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (typeof block === "string") return block;
      if (typeof block === "object" && block !== null) {
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("\n");
}

function containsProperty(value: unknown, property: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsProperty(entry, property));
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.entries(value).some(([key, nested]) => (
    key === property || containsProperty(nested, property)
  ));
}

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

  test("exposes oauth-only auth method", async () => {
    const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);

    expect(plugin.auth?.methods).toMatchObject([
      {
        label: "Claude Pro/Max (Multi-Auth)",
        type: "oauth",
      },
    ]);
  });

  test("bridges OpenCode message variant into an internal effort header", async () => {
    const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
    const chatHeaders = plugin["chat.headers"] as (
      input: unknown,
      output: { headers: Record<string, string> },
    ) => Promise<void>;
    const output = { headers: {} as Record<string, string> };

    await chatHeaders({
      provider: { info: { id: "anthropic" } },
      model: { providerID: "anthropic" },
      message: { model: { variant: "max" } },
    }, output);

    expect(output.headers["x-kyoli-opencode-effort"]).toBe("max");
  });

  test("bridges OpenCode resolved chat params into an internal effort header", async () => {
    const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
    const chatParams = plugin["chat.params"] as (
      input: unknown,
      output: { options: Record<string, unknown> },
    ) => Promise<void>;
    const chatHeaders = plugin["chat.headers"] as (
      input: unknown,
      output: { headers: Record<string, string> },
    ) => Promise<void>;
    const input = {
      sessionID: "session-params",
      provider: { info: { id: "anthropic" } },
      model: { providerID: "anthropic" },
      message: { model: { variant: "max" } },
    };
    const output = { headers: {} as Record<string, string> };

    await chatParams(input, { options: { effort: "medium" } });
    await chatHeaders(input, output);

    expect(output.headers["x-kyoli-opencode-effort"]).toBe("medium");
  });

  test("plugin loads in a temporary OpenCode config dir without user config", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
      const auth = plugin.auth!;
      const loaded = await auth.loader!(
        async () => ({ type: "api", key: "" }),
        { id: "anthropic", name: "Anthropic", env: {}, models: {} } as any,
      );

      expect(process.env.OPENCODE_CONFIG_DIR).toBe(dir);
      expect(plugin.tool).toBeUndefined();
      expect(plugin["experimental.chat.system.transform"]).toBeTypeOf("function");
      expect(loaded.apiKey).toBe("");
      expect(loaded.fetch).toBe(fetch);
      await expect(fs.access(join(dir, "anthropic-multi-account-accounts.json"))).rejects.toThrow();
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

  test("native plugin loader fetch preserves OpenCode tools through mocked upstream", async () => {
    const { cleanup } = await setupTestEnv();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      content: [{ type: "text", text: "ok" }],
    }), {
      headers: { "content-type": "application/json" },
    }));

    setClaudeIdentityForTest({ deviceId: "", accountUuid: "account-test" });

    try {
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = await ClaudeMultiAuthPlugin({ client: createMockClient() } as any);
      const auth = plugin.auth!;
      const loaded = await auth.loader!(
        async () => ({
          type: "oauth",
          access: "access-smoke",
          refresh: "refresh-smoke",
          expires: Date.now() + 600_000,
        }),
        { id: "anthropic", name: "Anthropic", env: {}, models: {} } as any,
      );

      const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-beta": "custom-beta-2026-01-01",
          "x-api-key": "should-not-leak",
        },
        body: JSON.stringify(createRealisticRequestPayload({
          model: "claude-haiku-4-5",
        })),
      });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [input, init] = fetchMock.mock.calls[0] ?? [];
      const transformedUrl = input instanceof URL ? input.toString() : String(input);
      const headers = toHeaders(init?.headers);
      const body = JSON.parse(String(init?.body)) as {
        system?: unknown;
        tools?: Array<{ name?: string; input_schema?: unknown }>;
        tool_choice?: { name?: string };
        messages?: Array<{ content?: unknown }>;
      };

      expect(transformedUrl).toContain("/v1/messages?beta=true");
      expect(headers.get("authorization")).toBe("Bearer access-smoke");
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("anthropic-beta")).toContain("custom-beta-2026-01-01");

      const systemText = getBlockTexts(body.system);
      expect(Array.isArray(body.system)).toBe(true);
      expect(body.system).toHaveLength(3);
      expect(systemText).not.toContain("OpenCode");
      expect(systemText).not.toContain("Remove this orchestration note.");

      expect(body.tools).toHaveLength(3);
      const toolNames = (body.tools ?? []).map((tool) => tool.name);
      expect(new Set(toolNames).size).toBe(3);
      expect(toolNames.every((name) => /^tool_[a-f0-9]+$/.test(name ?? ""))).toBe(true);
      expect(toolNames).not.toContain("Bash");
      expect(toolNames).not.toContain("Read");
      expect(body.tools?.every((tool) => tool.input_schema)).toBe(true);
      expect(body.tool_choice?.name).toBe(toolNames[1]);

      const messages = body.messages ?? [];
      const assistantBlocks = messages[1]?.content as Array<{ name?: string; type?: string }> | undefined;
      const toolUse = assistantBlocks?.find((block) => block.type === "tool_use");
      expect(toolUse?.name).toBe(toolNames[0]);
      expect(messages.at(-1)?.content?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
      expect(JSON.stringify(messages)).not.toContain('"type":"thinking"');
      expect(JSON.stringify(messages)).toContain("OpenCode request");
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup();
    }
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

});
