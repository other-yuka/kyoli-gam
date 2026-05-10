import { afterEach, describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { CodexMultiAuthPlugin } from "../../src/index";
import { AccountRuntimeFactory } from "../../src/runtime-factory";
import { AccountStore } from "../../src/account-store";
import { ACCOUNTS_FILENAME, CODEX_API_ENDPOINT, OPENAI_CLI_USER_AGENT, TOKEN_EXPIRY_BUFFER_MS } from "../../src/constants";
import { clearRefreshMutex } from "../../src/token";
import { buildFakeJwt, createMockClient, setupTestEnv } from "../helpers";

/**
 * OpenCode Codex native-plugin contract tests.
 *
 * These mirror the Claude native contract layer: no live OpenAI/ChatGPT calls, no real
 * user config mutation, and assertions focused on the behavior kyoli owns at the native
 * plugin boundary.
 */

function toHeaders(headers: HeadersInit | undefined): Headers {
  return new Headers(headers);
}

function buildAccessToken(accountId = "acct-contract"): string {
  return buildFakeJwt({ chatgpt_account_id: accountId });
}

async function seedAccount(store: AccountStore, overrides: Record<string, unknown> = {}): Promise<void> {
  await store.addAccount({
    uuid: "acct-contract",
    accountId: "account-id-contract",
    email: "codex@example.test",
    planTier: "",
    refreshToken: "refresh-contract",
    accessToken: buildAccessToken("account-id-contract"),
    expiresAt: Date.now() + TOKEN_EXPIRY_BUFFER_MS + 600_000,
    addedAt: Date.now(),
    lastUsed: Date.now(),
    enabled: true,
    consecutiveAuthFailures: 0,
    isAuthDisabled: false,
    ...overrides,
  });
  await store.setActiveUuid((overrides.uuid as string | undefined) ?? "acct-contract");
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRefreshMutex();
});

describe("OpenCode Codex native contract", () => {
  test("plugin loads in a temporary OpenCode config dir without user config", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      const plugin = await CodexMultiAuthPlugin({ client: createMockClient() } as never);
      const auth = (plugin as Record<string, unknown>).auth as {
        loader: (getAuth: () => Promise<unknown>, provider: unknown) => Promise<{ apiKey: string; fetch: typeof fetch }>;
      };
      const loaded = await auth.loader(
        async () => ({ type: "api", key: "" }),
        { id: "openai", name: "OpenAI", env: {}, models: {} },
      );

      expect(process.env.OPENCODE_CONFIG_DIR).toBe(dir);
      expect((plugin as Record<string, unknown>).tool).toBeUndefined();
      expect(loaded.apiKey).toBe("");
      expect(loaded.fetch).toBe(fetch);
      await expect(fs.access(join(dir, ACCOUNTS_FILENAME))).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test("loader recovers stored OAuth accounts and wraps fetch for native OpenCode traffic", async () => {
    const { cleanup } = await setupTestEnv();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      id: "resp_contract",
      output_text: "ok",
    }), {
      headers: { "content-type": "application/json" },
    }));

    try {
      const store = new AccountStore();
      await seedAccount(store);
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const plugin = await CodexMultiAuthPlugin({ client: createMockClient() } as never);
      const auth = (plugin as Record<string, unknown>).auth as {
        loader: (getAuth: () => Promise<unknown>, provider: unknown) => Promise<{ apiKey: string; fetch: typeof fetch }>;
      };
      const loaded = await auth.loader(
        async () => ({ type: "api", key: "" }),
        { id: "openai", name: "OpenAI", env: {}, models: {} },
      );

      expect(loaded.apiKey).toBe("CODEX_OAUTH");
      expect(loaded.fetch).not.toBe(fetch);

      const response = await loaded.fetch("https://api.openai.com/v1/responses?trace=1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer stale",
          "x-api-key": "should-not-leak",
        },
        body: JSON.stringify({
          model: "gpt-5.3-codex",
          input: "Say ok",
          store: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [input, init] = fetchMock.mock.calls[0] ?? [];
      const url = input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input);
      const headers = toHeaders(init?.headers);

      expect(url).toBe(`${CODEX_API_ENDPOINT}?trace=1`);
      expect(headers.get("authorization")).toBe(`Bearer ${buildAccessToken("account-id-contract")}`);
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("originator")).toBe("opencode");
      expect(headers.get("user-agent")).toBe(OPENAI_CLI_USER_AGENT);
      expect(headers.get("chatgpt-account-id")).toBe("account-id-contract");
      expect(String(init?.body)).toContain("gpt-5.3-codex");
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup();
    }
  });

  test("loader recovery does not require writing OpenCode auth.json state", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const store = new AccountStore();
      await seedAccount(store);
      const client = createMockClient();
      const authSetSpy = vi.fn(async () => {});
      client.auth.set = authSetSpy;

      const plugin = await CodexMultiAuthPlugin({ client } as never);
      const auth = (plugin as Record<string, unknown>).auth as {
        loader: (getAuth: () => Promise<unknown>, provider: unknown) => Promise<{ apiKey: string; fetch: typeof fetch }>;
      };
      const loaded = await auth.loader(
        async () => ({ type: "api", key: "" }),
        { id: "openai", name: "OpenAI", env: {}, models: {} },
      );

      expect(loaded.apiKey).toBe("CODEX_OAUTH");
      expect(loaded.fetch).not.toBe(fetch);
      expect(authSetSpy).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  test("runtime fetch preserves request invariants for responses and chat-completions paths", async () => {
    const { cleanup } = await setupTestEnv();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));

    try {
      const store = new AccountStore();
      await seedAccount(store, { accountId: undefined });
      const runtime = await new AccountRuntimeFactory(store, createMockClient()).getRuntime("acct-contract");
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await runtime.fetch("https://api.openai.com/v1/chat/completions?stream=true", {
        method: "POST",
        headers: {
          "x-api-key": "client-key",
          "x-custom": "keep",
        },
        body: JSON.stringify({
          model: "gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });

      const [input, init] = fetchMock.mock.calls[0] ?? [];
      const url = input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input);
      const headers = toHeaders(init?.headers);

      expect(url).toBe(`${CODEX_API_ENDPOINT}?stream=true`);
      expect(headers.get("authorization")).toBe(`Bearer ${buildAccessToken("account-id-contract")}`);
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("x-custom")).toBe("keep");
      expect(headers.get("originator")).toBe("opencode");
      expect(headers.get("user-agent")).toBe(OPENAI_CLI_USER_AGENT);
      expect(headers.get("chatgpt-account-id")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup();
    }
  });
});
