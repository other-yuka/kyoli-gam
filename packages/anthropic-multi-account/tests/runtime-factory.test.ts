import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import * as anthropicOAuth from "../src/anthropic-oauth";
import { AccountRuntimeFactory } from "../src/runtime-factory";
import { AccountStore } from "../src/account-store";
import { TOKEN_EXPIRY_BUFFER_MS } from "../src/constants";
import { resetExcludedBetas } from "../src/betas";
import { clearRefreshMutex } from "../src/token";
import { createMockClient, setupTestEnv } from "./helpers";


function toHeaders(headers: HeadersInit | undefined): Headers {
  return new Headers(headers);
}

describe("runtime-factory", () => {
  let originalFetch: typeof globalThis.fetch;
  let cleanup: () => Promise<void>;
  let store: AccountStore;
  let client: ReturnType<typeof createMockClient>;

  async function seedAccount(overrides: Record<string, unknown> = {}) {
    const uuid = (overrides.uuid as string) ?? "acct-1";
    await store.addAccount({
      uuid,
      refreshToken: "refresh-1",
      accessToken: "access-1",
      expiresAt: Date.now() + TOKEN_EXPIRY_BUFFER_MS + 600_000,
      addedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
      planTier: "",
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
      ...overrides,
    });
    return uuid;
  }

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    const env = await setupTestEnv();
    cleanup = env.cleanup;
    store = new AccountStore();
    client = createMockClient();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    clearRefreshMutex();
    resetExcludedBetas();
    await cleanup();
  });

  test("applies request transforms and auth header", async () => {
    const uuid = await seedAccount();
    const factory = new AccountRuntimeFactory(store, client);
    const runtime = await factory.getRuntime(uuid);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runtime.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        tools: [{ name: "calc" }],
        messages: [{ content: [{ type: "tool_use", name: "calc" }] }],
      }),
    });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const transformedUrl = input instanceof URL ? input.toString() : String(input);
    const headers = toHeaders(init?.headers);
    const body = JSON.parse(String(init?.body)) as {
      system: Array<{ text?: string; cache_control?: { type?: string; ttl?: string } }>;
      tools: Array<{ name?: string }>;
      thinking?: { type?: string };
      context_management?: Record<string, unknown>;
      output_config?: { effort?: string };
      max_tokens?: number;
    };

    expect(transformedUrl).toContain("/v1/messages?beta=true");
    expect(headers.get("authorization")).toBe("Bearer access-1");
    expect(headers.get("anthropic-beta")).toBeTruthy();
    expect(headers.get("anthropic-beta")).toContain("effort-2025-11-24");
    expect(body.system).toHaveLength(3);
    expect(body.system[0]?.text).toContain("x-anthropic-billing-header:");
    expect(body.system[0]?.text).toContain("cc_entrypoint=sdk-cli");
    expect(body.system[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system[1]?.cache_control).not.toHaveProperty("ttl");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.context_management).toEqual({});
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.max_tokens).toBe(32_000);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]?.name).toMatch(/^tool_[a-f0-9]+$/);
  });

  test("reverse maps masked tool names in non-stream JSON responses", async () => {
    const uuid = await seedAccount();
    const factory = new AccountRuntimeFactory(store, client);
    const runtime = await factory.getRuntime(uuid);

    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const outbound = JSON.parse(String(init?.body)) as { tools: Array<{ name?: string }> };
      const maskedName = outbound.tools[0]?.name ?? "tool_fallback";

      return new Response(JSON.stringify({
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: maskedName,
            input: { q: "docs" },
          },
        ],
      }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const response = await runtime.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        tools: [{ name: "search_docs", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "tool_use", name: "search_docs", input: { q: "docs" } }] },
        ],
      }),
    });

    const parsed = await response.json() as { content: Array<{ name?: string }> };
    expect(parsed.content[0]?.name).toBe("search_docs");
  });

  test("runtime.fetch preserves empty tool_result after upstream request sanitization", async () => {
    const uuid = await seedAccount();
    const factory = new AccountRuntimeFactory(store, client);
    const runtime = await factory.getRuntime(uuid);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runtime.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: { question: "x" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "<system-reminder>hidden</system-reminder>",
              },
            ],
          },
        ],
      }),
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
    };

    expect(body.messages).toHaveLength(3);
    expect(body.messages[1]?.role).toBe("assistant");
    expect(body.messages[1]?.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: { question: "x" } },
    ]);
    expect(body.messages[2]?.role).toBe("user");
    expect(body.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "" },
    ]);
  });

  test("runtime.fetch returns local 400 without upstream call for dangling tool_use", async () => {
    const uuid = await seedAccount();
    const factory = new AccountRuntimeFactory(store, client);
    const runtime = await factory.getRuntime(uuid);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await runtime.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: { question: "x" } },
            ],
          },
        ],
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(response.json()).resolves.toMatchObject({
      error: {
        type: "invalid_request_error",
        message: expect.stringContaining("Dangling tool_use"),
      },
    });
  });

  test("retries without long-context beta when provider rejects it", async () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true";
    try {
      const uuid = await seedAccount();
      const factory = new AccountRuntimeFactory(store, client);
      const runtime = await factory.getRuntime(uuid);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Extra usage is required for long context requests" } }), { status: 400 }))
        .mockResolvedValueOnce(new Response("ok"));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await runtime.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const firstHeaders = toHeaders(fetchMock.mock.calls[0]?.[1]?.headers);
      const secondHeaders = toHeaders(fetchMock.mock.calls[1]?.[1]?.headers);
      expect(firstHeaders.get("anthropic-beta")).toContain("context-1m-2025-08-07");
      expect(secondHeaders.get("anthropic-beta")).not.toContain("context-1m-2025-08-07");
    } finally {
      delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
    }
  });

  test("retry exclusion removes rejected beta from template fallback and incoming header too", async () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true";
    try {
      const uuid = await seedAccount();
      const factory = new AccountRuntimeFactory(store, client);
      const runtime = await factory.getRuntime(uuid);

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "long context beta is not yet available" } }), { status: 400 }))
        .mockResolvedValueOnce(new Response("ok"));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await runtime.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-beta": "context-1m-2025-08-07,custom-beta-2026-01-01",
        },
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const firstHeaders = toHeaders(fetchMock.mock.calls[0]?.[1]?.headers);
      const secondHeaders = toHeaders(fetchMock.mock.calls[1]?.[1]?.headers);

      expect(firstHeaders.get("anthropic-beta")).toContain("context-1m-2025-08-07");
      expect(firstHeaders.get("anthropic-beta")).toContain("custom-beta-2026-01-01");
      expect(secondHeaders.get("anthropic-beta")).not.toContain("context-1m-2025-08-07");
      expect(secondHeaders.get("anthropic-beta")).toContain("custom-beta-2026-01-01");
    } finally {
      delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
    }
  });

  test("retries after generic unexpected-beta rejection by excluding rejected beta", async () => {
    const uuid = await seedAccount();
    const factory = new AccountRuntimeFactory(store, client);
    const runtime = await factory.getRuntime(uuid);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Unexpected value(s): custom-beta-2026-01-01 for the anthropic-beta header" },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response("ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runtime.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-beta": "custom-beta-2026-01-01",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstHeaders = toHeaders(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = toHeaders(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get("anthropic-beta")).toContain("custom-beta-2026-01-01");
    expect(secondHeaders.get("anthropic-beta")).not.toContain("custom-beta-2026-01-01");
    expect(secondHeaders.get("anthropic-beta")).toContain("oauth-2025-04-20");
  });

  test("enriches generic 429 responses with unified rate-limit headers", async () => {
    const uuid = await seedAccount();
    const factory = new AccountRuntimeFactory(store, client);
    const runtime = await factory.getRuntime(uuid);

    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "Error" } }),
      {
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-representative-claim": "workspace",
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-5h-utilization": "0.9",
        },
      },
    )) as unknown as typeof fetch;

    const response = await runtime.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    const parsed = await response.json();

    expect(response.status).toBe(429);
    expect(parsed).toMatchObject({
      error: {
        message: expect.stringContaining("Rate limited (rejected). Limiting window: workspace"),
      },
    });
  });

  test("applies pacing delay before each upstream request", async () => {
    const uuid = await seedAccount();
    const factory = new AccountRuntimeFactory(store, client);
    let currentTime = 1_000;
    const sleepCalls: number[] = [];

    factory.setPacingTestOverrides({
      now: () => currentTime,
      sleep: (ms) => {
        sleepCalls.push(ms);
        currentTime += ms;
        return Promise.resolve();
      },
    });

    const runtime = await factory.getRuntime(uuid);

    globalThis.fetch = vi.fn(async () => {
      currentTime += 100;
      return new Response("ok");
    }) as unknown as typeof fetch;

    await runtime.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    await runtime.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });

    expect(sleepCalls).toEqual([400]);
  });

  test("serializes pacing across concurrent requests", async () => {
    const uuid = await seedAccount();
    const factory = new AccountRuntimeFactory(store, client);
    let currentTime = 1_000;
    const sleepCalls: number[] = [];

    factory.setPacingTestOverrides({
      now: () => currentTime,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        currentTime += ms;
      },
    });

    const runtime = await factory.getRuntime(uuid);

    globalThis.fetch = vi.fn(async () => {
      currentTime += 100;
      return new Response("ok");
    }) as unknown as typeof fetch;

    await Promise.all([
      runtime.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      }),
      runtime.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
      }),
    ]);

    expect(sleepCalls).toEqual([400]);
  });

  test("refreshes expired token through anthropic-oauth", async () => {
    const uuid = await seedAccount({
      accessToken: "expired-access",
      expiresAt: Date.now() - 1_000,
    });

    const refreshSpy = vi.spyOn(anthropicOAuth, "refreshWithOAuth").mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: Date.now() + 3_600_000,
    });

    const factory = new AccountRuntimeFactory(store, client);
    const runtime = await factory.getRuntime(uuid);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await runtime.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith("refresh-1");

    const storage = await store.load();
    const account = storage.accounts.find((candidate) => candidate.uuid === uuid);
    expect(account?.accessToken).toBe("new-access");
    expect(account?.refreshToken).toBe("new-refresh");
    expect(account?.consecutiveAuthFailures).toBe(0);
    expect(account?.isAuthDisabled).toBe(false);

    refreshSpy.mockRestore();
  });

  test("throws with permanent status on permanent refresh failure without removing account", async () => {
    const uuid = await seedAccount({
      accessToken: "expired-access",
      expiresAt: Date.now() - 1_000,
    });

    const refreshSpy = vi
      .spyOn(anthropicOAuth, "refreshWithOAuth")
      .mockRejectedValue(new Error("Token refresh failed: 401"));

    const factory = new AccountRuntimeFactory(store, client);
    const runtime = await factory.getRuntime(uuid);

    expect(
      runtime.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    ).rejects.toThrow("Token refresh failed");

    const storage = await store.load();
    expect(storage.accounts).toHaveLength(1);

    refreshSpy.mockRestore();
  });

  test("keeps account on transient refresh failure", async () => {
    const uuid = await seedAccount({
      accessToken: "expired-access",
      expiresAt: Date.now() - 1_000,
    });

    const refreshSpy = vi
      .spyOn(anthropicOAuth, "refreshWithOAuth")
      .mockRejectedValue(new Error("Token refresh failed: 429"));
    const authSetSpy = vi.spyOn(client.auth, "set").mockResolvedValue();

    const factory = new AccountRuntimeFactory(store, client);
    const runtime = await factory.getRuntime(uuid);

    expect(
      runtime.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    ).rejects.toThrow("Token refresh failed");

    const storage = await store.load();
    expect(storage.accounts).toHaveLength(1);
    expect(storage.accounts[0]?.uuid).toBe(uuid);
    expect(authSetSpy).not.toHaveBeenCalledWith({
      path: { id: "anthropic" },
      body: { type: "oauth", refresh: "", access: "", expires: 0 },
    });

    refreshSpy.mockRestore();
    authSetSpy.mockRestore();
  });

  test("invalidates cached runtime and recreates it", async () => {
    const uuid = await seedAccount();
    const factory = new AccountRuntimeFactory(store, client);
    const first = await factory.getRuntime(uuid);

    factory.invalidate(uuid);
    const second = await factory.getRuntime(uuid);

    expect(first).not.toBe(second);
  });
});
