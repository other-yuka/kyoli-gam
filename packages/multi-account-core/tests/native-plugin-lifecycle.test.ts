import { describe, expect, test, vi } from "vitest";
import { createOpenCodeNativePluginLifecycle } from "../src/native-plugin-lifecycle";
import type { OAuthCredentials, PluginClient } from "../src/types";

type Stored = { accounts: Array<{ uuid?: string; isAuthDisabled?: boolean }> };

class FakeStore {
  storage: Stored = { accounts: [] };
  async load(): Promise<Stored> {
    return this.storage;
  }
}

class FakeManager {
  runtimeFactory: unknown;
  constructor(private readonly store: FakeStore) {}

  static async create(store: FakeStore, auth: OAuthCredentials): Promise<FakeManager> {
    if (auth.refresh && store.storage.accounts.length === 0) {
      store.storage.accounts.push({ uuid: "from-auth" });
    }
    return new FakeManager(store);
  }

  getAccountCount(): number {
    return this.store.storage.accounts.length;
  }

  getAccounts(): Array<{ uuid?: string; isAuthDisabled?: boolean }> {
    return this.store.storage.accounts;
  }

  getActiveAccount(): { uuid?: string } | null {
    return this.store.storage.accounts[0] ?? null;
  }

  setRuntimeFactory(factory: unknown): void {
    this.runtimeFactory = factory;
  }

  async validateNonActiveTokens(): Promise<void> {}
}

function createClient(): PluginClient & { toasts: string[] } {
  const toasts: string[] = [];
  return {
    toasts,
    auth: { set: async () => {} },
    tui: {
      showToast: async ({ body }) => {
        toasts.push(body.message);
      },
    },
    app: { log: async () => {} },
  };
}

function createLifecycle(store: FakeStore, client = createClient()) {
  const fetchMock = vi.fn(async () => new Response("ok"));
  const invalidateMock = vi.fn();
  const refreshStartMock = vi.fn();
  const refreshStopMock = vi.fn();
  const migrateMock = vi.fn(async () => false);

  const lifecycle = createOpenCodeNativePluginLifecycle({
    store,
    client,
    managerClass: FakeManager,
    createRuntimeFactory: () => ({
      getRuntime: async () => ({ fetch: fetchMock }),
      invalidate: invalidateMock,
    }),
    createRefreshQueue: () => ({
      start: refreshStartMock,
      stop: refreshStopMock,
    }),
    executeWithAccountRotation: async (_manager, runtimeFactory, _client, input, init) => {
      const runtime = await runtimeFactory.getRuntime("from-store");
      return runtime.fetch(input, init);
    },
    migrateFromAuthJson: migrateMock,
    authJsonProviderKey: "openai",
    oauthApiKey: "OAUTH",
    noAccountsMessage: "No accounts",
    getAccountLabel: (account) => account.uuid ?? "unknown",
  });

  return {
    client,
    fetchMock,
    invalidateMock,
    lifecycle,
    migrateMock,
    refreshStartMock,
    refreshStopMock,
  };
}

describe("createOpenCodeNativePluginLifecycle", () => {
  test("returns passthrough for non-oauth auth when no stored accounts exist", async () => {
    const store = new FakeStore();
    const { lifecycle, migrateMock } = createLifecycle(store);

    const result = await lifecycle.load({ type: "api" });

    expect(result.apiKey).toBe("");
    expect(result.fetch).toBe(fetch);
    expect(migrateMock).toHaveBeenCalledWith("openai", store);
    expect(lifecycle.getManager()).toBeNull();
  });

  test("recovers stored accounts for non-oauth auth payloads", async () => {
    const store = new FakeStore();
    store.storage.accounts.push({ uuid: "from-store" });
    const { fetchMock, lifecycle, refreshStartMock } = createLifecycle(store);

    const result = await lifecycle.load({ type: "api" });
    const response = await result.fetch("https://example.test");

    expect(result.apiKey).toBe("OAUTH");
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lifecycle.getManager()?.getAccountCount()).toBe(1);
    expect(refreshStartMock).toHaveBeenCalledTimes(1);
  });

  test("initializes from oauth auth and zeroes provider model costs", async () => {
    const store = new FakeStore();
    const client = createClient();
    const { lifecycle } = createLifecycle(store, client);
    const provider = {
      models: {
        "openai/gpt-5.3-codex": { cost: { input: 1, output: 1 } },
      },
    };

    const result = await lifecycle.load({
      type: "oauth",
      refresh: "refresh",
      access: "access",
      expires: Date.now() + 60_000,
    }, provider);

    expect(result.apiKey).toBe("OAUTH");
    expect(lifecycle.getManager()?.getAccountCount()).toBe(1);
    expect(provider.models["openai/gpt-5.3-codex"].cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    });
    expect(client.toasts.some((message) => message.includes("1 account(s) loaded"))).toBe(true);
  });

  test("throws provider-specific no-account message from wrapped fetch", async () => {
    const store = new FakeStore();
    const { lifecycle } = createLifecycle(store);

    const result = await lifecycle.load({
      type: "oauth",
      refresh: "refresh",
      access: "access",
      expires: Date.now() + 60_000,
    });
    store.storage.accounts = [];

    await expect(result.fetch("https://example.test")).rejects.toThrow("No accounts");
  });
});
