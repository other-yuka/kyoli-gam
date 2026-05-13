import { describe, expect, it } from "vitest";
import type {
  GatewayRequestContext,
  GatewayRoute,
  GatewayWebSocketContext,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
} from "@kyoli-gam/core";
import { MemoryAccountStore } from "@kyoli-gam/core";
import { createGateway } from "../src";

describe("gateway routing", () => {
  it("routes Anthropic-prefixed Claude messages to the Claude Code adapter", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const claude = fakeProvider({
      id: "claude-code",
      routes: ["/v1/messages"],
      models: [
        {
          id: "anthropic/test-claude",
          provider: "claude-code",
          upstreamId: "test-claude",
          aliases: ["claude-code/test-claude"],
          capabilities: ["messages"],
        },
      ],
      handle: async (context) => {
        seenContext = context;
        return Response.json({ provider: "claude-code" });
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [claude],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kyoli-session-id": "thread-1",
        },
        body: JSON.stringify({
          model: "anthropic/test-claude",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "claude-code" });
    expect(seenContext?.route).toBe("/v1/messages");
    expect(seenContext?.model).toBe("anthropic/test-claude");
    expect(seenContext?.sessionKey).toBe("header:thread-1");
    expect(seenContext?.body).toEqual({
      model: "anthropic/test-claude",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("routes native Codex backend requests to the Codex adapter", async () => {
    let seenRoute: GatewayRoute | undefined;
    const codex = fakeProvider({
      id: "codex",
      routes: ["/backend-api/codex/responses"],
      models: [],
      handle: async (context) => {
        seenRoute = context.route;
        return Response.json({ provider: "codex" });
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.3-codex", input: "hello" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "codex" });
    expect(seenRoute).toBe("/backend-api/codex/responses");
  });

  it("uses Codex session headers as sticky routing keys", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const codex = fakeProvider({
      id: "codex",
      routes: ["/backend-api/codex/responses"],
      models: [],
      handle: async (context) => {
        seenContext = context;
        return Response.json({ provider: "codex" });
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/backend-api/codex/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-session-id": "codex-thread-1",
        },
        body: JSON.stringify({ model: "gpt-5.3-codex", input: "hello" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(seenContext?.sessionKey).toBe("header:codex-thread-1");
  });

  it("uses generic client session headers as sticky routing keys", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const claude = fakeProvider({
      id: "claude-code",
      routes: ["/v1/messages"],
      models: [
        {
          id: "anthropic/test-claude",
          provider: "claude-code",
          upstreamId: "test-claude",
          capabilities: ["messages"],
        },
      ],
      handle: async (context) => {
        seenContext = context;
        return Response.json({ provider: "claude-code" });
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [claude],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-client-session-id": "claude-client-thread-1",
        },
        body: JSON.stringify({ model: "anthropic/test-claude", messages: [] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(seenContext?.sessionKey).toBe("header:claude-client-thread-1");
  });

  it("routes native Codex compact requests to the Codex adapter", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const codex = fakeProvider({
      id: "codex",
      routes: ["/backend-api/codex/responses/compact"],
      models: [],
      handle: async (context) => {
        seenContext = context;
        return Response.json({ provider: "codex" });
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/backend-api/codex/responses/compact", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          session_id: "codex-thread-compact",
        },
        body: JSON.stringify({ model: "gpt-5.3-codex", input: "hello" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(seenContext?.route).toBe("/backend-api/codex/responses/compact");
    expect(seenContext?.sessionKey).toBe("header:codex-thread-compact");
  });

  it("uses prompt cache aliases as sticky routing keys when no session is present", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const codex = fakeProvider({
      id: "codex",
      routes: ["/v1/responses"],
      models: [
        {
          id: "openai/gpt-5.3-codex",
          provider: "codex",
          upstreamId: "gpt-5.3-codex",
          aliases: ["codex/gpt-5.3-codex"],
          capabilities: ["responses"],
        },
      ],
      handle: async (context) => {
        seenContext = context;
        return Response.json({ provider: "codex" });
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.3-codex",
          input: "hello",
          promptCacheKey: "thread_123",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(seenContext?.sessionKey).toBe("prompt_cache:thread_123");
  });

  it("uses the first Claude user message as a sticky key when no session is present", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const claude = fakeProvider({
      id: "claude-code",
      routes: ["/v1/messages"],
      models: [
        {
          id: "anthropic/claude-sonnet-4-5",
          provider: "claude-code",
          upstreamId: "claude-sonnet-4-5",
          aliases: ["claude-code/claude-sonnet-4-5"],
          capabilities: ["messages"],
        },
      ],
      handle: async (context) => {
        seenContext = context;
        return Response.json({ provider: "claude-code" });
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [claude],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "keep this conversation sticky" }],
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(seenContext?.sessionKey).toMatch(/^prompt_cache:claude_first_user:[0-9a-f]{16}$/);
  });

  it("routes native Codex file finalize requests to the Codex adapter", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const codex = fakeProvider({
      id: "codex",
      routes: ["/backend-api/files", "/backend-api/files/uploaded"],
      models: [],
      handle: async (context) => {
        seenContext = context;
        return Response.json({ provider: "codex" });
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/backend-api/files/file_123/uploaded", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "codex" });
    expect(seenContext?.route).toBe("/backend-api/files/uploaded");
    expect(seenContext?.sessionKey).toBe("fallback:anonymous:unknown-model");
  });

  it("routes OpenAI-style Responses requests by unprefixed Codex model alias", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const codex = fakeProvider({
      id: "codex",
      routes: ["/v1/responses"],
      models: [
        {
          id: "openai/gpt-5.3-codex",
          provider: "codex",
          upstreamId: "gpt-5.3-codex",
          capabilities: ["responses"],
          aliases: ["gpt-5.3-codex"],
        },
      ],
      handle: async (context) => {
        seenContext = context;
        return Response.json({ provider: "codex" });
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.3-codex", input: "hello" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "codex" });
    expect(seenContext?.route).toBe("/v1/responses");
    expect(seenContext?.model).toBe("gpt-5.3-codex");
  });

  it("rejects models that do not resolve to an OAuth provider", async () => {
    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        type: "provider_not_resolved",
        message:
          "Provide a familiar provider model such as openai/gpt-5.3-codex or anthropic/claude-sonnet-4-5.",
      },
    });
  });

  it("rejects provider routes that the selected adapter does not support", async () => {
    const codex = fakeProvider({
      id: "codex",
      routes: ["/v1/responses"],
      models: [
        {
          id: "openai/test-codex",
          provider: "codex",
          upstreamId: "test-codex",
          aliases: ["codex/test-codex"],
          capabilities: ["responses"],
        },
      ],
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/test-codex",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        type: "route_not_supported",
        message: "codex does not support /v1/messages.",
      },
    });
  });

  it("includes adapter models in /v1/models", async () => {
    const codex = fakeProvider({
      id: "codex",
      routes: ["/v1/responses"],
      models: [
        {
          id: "openai/test-codex",
          provider: "codex",
          upstreamId: "test-codex",
          displayName: "Test Codex",
          capabilities: ["responses"],
          aliases: ["test-codex", "codex/test-codex"],
        },
      ],
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/v1/models"),
    );
    const payload = (await response.json()) as {
      data: Array<{ id: string; owned_by: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.data.some((model) => model.id === "openai/test-codex")).toBe(true);
  });

  it("serves native Codex CLI model catalog shape", async () => {
    const codex = fakeProvider({
      id: "codex",
      routes: ["/backend-api/codex/responses"],
      models: [
        {
          id: "openai/test-codex",
          provider: "codex",
          upstreamId: "test-codex",
          displayName: "Test Codex",
          capabilities: ["responses", "tools", "reasoning", "codex"],
          aliases: ["test-codex"],
        },
      ],
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/backend-api/codex/models"),
    );
    const payload = (await response.json()) as {
      models: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(payload.models.find((model) => model.slug === "test-codex")).toMatchObject({
      slug: "test-codex",
      display_name: "Test Codex",
      supported_in_api: true,
      supports_parallel_tool_calls: true,
      supports_reasoning_summaries: true,
      prefer_websockets: true,
      visibility: "list",
    });
  });

  it("routes native Codex WebSocket upgrades to the Codex adapter", async () => {
    let seenContext: GatewayWebSocketContext | undefined;
    const codex = fakeProvider({
      id: "codex",
      routes: ["/backend-api/codex/responses"],
      models: [],
      handleWebSocket: async (context) => {
        seenContext = context;
        await context.websocket.accept();
        await context.websocket.close();
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex],
    });

    const websocket = fakeWebSocket();
    await gateway.handleWebSocket(
      new Request("http://127.0.0.1:2021/backend-api/codex/responses", {
        headers: { "x-codex-session-id": "codex-ws-thread" },
      }),
      websocket,
    );

    expect(websocket.accepted).toBe(true);
    expect(seenContext?.route).toBe("/backend-api/codex/responses");
    expect(seenContext?.sessionKey).toBe("header:codex-ws-thread");
  });

  it("rejects provider requests when local concurrency is saturated", async () => {
    let releaseFirstRequest: (() => void) | undefined;
    const firstRequestStarted = deferred<void>();
    const codex = fakeProvider({
      id: "codex",
      routes: ["/v1/responses"],
      models: [],
      handle: async () => {
        firstRequestStarted.resolve();
        await new Promise<void>((resolve) => {
          releaseFirstRequest = resolve;
        });
        return Response.json({ ok: true });
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex],
      maxConcurrentRequests: 1,
    });

    const first = gateway.fetch(
      new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.3-codex", input: "hold" }),
      }),
    );
    await firstRequestStarted.promise;

    const second = await gateway.fetch(
      new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/gpt-5.3-codex", input: "reject" }),
      }),
    );

    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("1");
    await expect(second.json()).resolves.toMatchObject({
      error: {
        type: "local_overload",
        retryable: true,
      },
    });

    releaseFirstRequest?.();
    await expect(first).resolves.toMatchObject({ status: 200 });
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeProvider(input: {
  id: ProviderId;
  routes: GatewayRoute[];
  models: ModelInfo[];
  handle?: (context: GatewayRequestContext) => Promise<Response>;
  handleWebSocket?: (context: GatewayWebSocketContext) => Promise<void>;
}): ProviderAdapter {
  return {
    id: input.id,
    displayName: input.id,
    routes: input.routes,
    listModels: async () => input.models,
    handleRequest:
      input.handle ??
      (async () => Response.json({ provider: input.id })),
    handleWebSocket: input.handleWebSocket,
  };
}

function fakeWebSocket() {
  return {
    accepted: false,
    async accept() {
      this.accepted = true;
    },
    async receive() {
      return { type: "close" as const };
    },
    async sendText() {
      return undefined;
    },
    async sendBinary() {
      return undefined;
    },
    async close() {
      return undefined;
    },
  };
}
