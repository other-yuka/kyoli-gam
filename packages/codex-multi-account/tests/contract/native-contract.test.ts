import { afterEach, describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { CodexMultiAuthPlugin } from "../../src/index";
import { AccountRuntimeFactory } from "../../src/runtime-factory";
import { AccountStore } from "../../src/account-store";
import {
  ACCOUNTS_FILENAME,
  CODEX_API_ENDPOINT,
  CODEX_USAGE_ENDPOINT,
  OPENAI_CLI_USER_AGENT,
  TOKEN_EXPIRY_BUFFER_MS,
} from "../../src/constants";
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

function sseResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map((event) => (
    `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
  )).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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
      const provider = (plugin as Record<string, unknown>).provider as {
        id: string;
        models(provider: unknown): Promise<Record<string, unknown>>;
      };
      const models = await provider.models({
        models: { "openai/gpt-5.3-codex": { cost: { input: 1, output: 1 } } },
      });

      expect((plugin as Record<string, unknown>).tool).toBeUndefined();
      expect(provider.id).toBe("openai");
      expect(models["openai/gpt-5.3-codex"]).toMatchObject({ cost: { input: 0, output: 0 } });
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

  test("loader hides startup quota failure and replays the request with the next account", async () => {
    const { cleanup } = await setupTestEnv();
    const originalFetch = globalThis.fetch;
    const requestBodies: string[] = [];
    const upstreamAccounts: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === CODEX_USAGE_ENDPOINT) {
        return new Response(JSON.stringify({ plan_type: "plus", rate_limit: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const headers = new Headers(init?.headers);
      const accountId = headers.get("chatgpt-account-id") ?? "";
      upstreamAccounts.push(accountId);
      requestBodies.push(await new Request(input, init).text());
      if (accountId === "account-id-first") {
        return sseResponse([
          { type: "response.created", response: { id: "resp_first", status: "in_progress" } },
          { type: "response.in_progress", response: { id: "resp_first", status: "in_progress" } },
          {
            type: "response.failed",
            response: {
              id: "resp_first",
              status: "failed",
              error: { code: "usage_limit_reached", message: "usage limit reached" },
            },
          },
        ]);
      }
      return sseResponse([
        { type: "response.created", response: { id: "resp_second", status: "in_progress" } },
        { type: "response.output_text.delta", response_id: "resp_second", delta: "ok" },
        { type: "response.completed", response: { id: "resp_second", status: "completed" } },
      ]);
    });

    try {
      const store = new AccountStore();
      await seedAccount(store, {
        uuid: "acct-first",
        accountId: "account-id-first",
        accessToken: buildAccessToken("account-id-first"),
        refreshToken: "refresh-first",
      });
      await seedAccount(store, {
        uuid: "acct-second",
        accountId: "account-id-second",
        accessToken: buildAccessToken("account-id-second"),
        refreshToken: "refresh-second",
      });
      await store.setActiveUuid("acct-first");
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const plugin = await CodexMultiAuthPlugin({ client: createMockClient() } as never);
      const auth = (plugin as Record<string, unknown>).auth as {
        loader: (getAuth: () => Promise<unknown>, provider: unknown) => Promise<{ apiKey: string; fetch: typeof fetch }>;
      };
      const loaded = await auth.loader(
        async () => ({ type: "api", key: "" }),
        { id: "openai", name: "OpenAI", env: {}, models: {} },
      );
      const requestBody = JSON.stringify({ model: "gpt-5.3-codex", input: "Say ok", stream: true });

      const response = await loaded.fetch(new Request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      }));
      const body = await response.text();

      expect(upstreamAccounts).toEqual(["account-id-first", "account-id-second"]);
      expect(requestBodies).toEqual([requestBody, requestBody]);
      expect(body).toContain("resp_second");
      expect(body).not.toContain("resp_first");
      expect(body).not.toContain("usage_limit_reached");
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
