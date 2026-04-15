import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import * as piAiAdapter from "../src/pi-ai-adapter";
import { AccountRuntimeFactory } from "../src/runtime-factory";
import { AccountStore } from "../src/account-store";
import { TOKEN_EXPIRY_BUFFER_MS } from "../src/constants";
import { resetExcludedBetas } from "../src/betas";
import { clearRefreshMutex } from "../src/token";
import { createMockClient, setupTestEnv } from "./helpers";

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
    const headers = init?.headers as Headers;
    const body = JSON.parse(String(init?.body)) as {
      tools: Array<{ name?: string }>;
      messages: Array<{ content: Array<{ name?: string }> }>;
    };

    expect(transformedUrl).toContain("/v1/messages?beta=true");
    expect(headers.get("authorization")).toBe("Bearer access-1");
    expect(headers.get("anthropic-beta")).toBeTruthy();
    expect(headers.get("anthropic-beta")).toContain("effort-2025-11-24");
    expect(body.tools[0]?.name?.startsWith("tool_")).toBe(true);
    expect(body.messages[0]?.content[0]?.name).toBe(body.tools[0]?.name);
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

      const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
      const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
      expect(firstHeaders.get("anthropic-beta")).toContain("context-1m-2025-08-07");
      expect(secondHeaders.get("anthropic-beta")).not.toContain("context-1m-2025-08-07");
    } finally {
      delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
    }
  });

  test("refreshes expired token through pi-ai adapter", async () => {
    const uuid = await seedAccount({
      accessToken: "expired-access",
      expiresAt: Date.now() - 1_000,
    });

    const refreshSpy = vi.spyOn(piAiAdapter, "refreshWithPiAi").mockResolvedValue({
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
      .spyOn(piAiAdapter, "refreshWithPiAi")
      .mockRejectedValue(new Error("Token refresh failed: 401"));

    const factory = new AccountRuntimeFactory(store, client);
    const runtime = await factory.getRuntime(uuid);

    await expect(
      runtime.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    ).rejects.toThrow("Token refresh failed: 401");

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
      .spyOn(piAiAdapter, "refreshWithPiAi")
      .mockRejectedValue(new Error("Token refresh failed: 429"));
    const authSetSpy = vi.spyOn(client.auth, "set").mockResolvedValue();

    const factory = new AccountRuntimeFactory(store, client);
    const runtime = await factory.getRuntime(uuid);

    await expect(
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
