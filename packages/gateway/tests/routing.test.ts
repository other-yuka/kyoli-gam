import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  GatewayRequestContext,
  GatewayRoute,
  GatewayWebSocketContext,
  GatewayWebSocketMessage,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
} from "@kyoli-gam/core";
import { MemoryAccountStore } from "@kyoli-gam/core";
import { createGateway, serveGateway } from "../src";

describe("gateway routing", () => {
  it("serves dashboard index routes from bundled assets", async () => {
    const dashboardAssetsDir = await createDashboardFixture();
    const gateway = createGateway({
      dashboardAssetsDir,
      accounts: new MemoryAccountStore(),
      providers: [],
    });

    try {
      for (const path of ["/dashboard", "/dashboard/"]) {
        const response = await gateway.fetch(new Request(`http://127.0.0.1:2021${path}`));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(await response.text()).toContain('<div id="root"></div>');
      }
    } finally {
      await rm(dashboardAssetsDir, { recursive: true, force: true });
    }
  });

  it("serves dashboard assets with content types and cache headers", async () => {
    const dashboardAssetsDir = await createDashboardFixture();
    const gateway = createGateway({
      dashboardAssetsDir,
      accounts: new MemoryAccountStore(),
      providers: [],
    });

    try {
      const response = await gateway.fetch(new Request("http://127.0.0.1:2021/dashboard/assets/app.js"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/javascript");
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(await response.text()).toBe("console.log('dashboard');");
    } finally {
      await rm(dashboardAssetsDir, { recursive: true, force: true });
    }
  });

  it("falls back to the dashboard shell for nested dashboard routes", async () => {
    const dashboardAssetsDir = await createDashboardFixture();
    const gateway = createGateway({
      dashboardAssetsDir,
      accounts: new MemoryAccountStore(),
      providers: [],
    });

    try {
      const response = await gateway.fetch(new Request("http://127.0.0.1:2021/dashboard/accounts/codex"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("Kyoli Dashboard");
    } finally {
      await rm(dashboardAssetsDir, { recursive: true, force: true });
    }
  });

  it("does not route admin or api paths through the dashboard fallback", async () => {
    const dashboardAssetsDir = await createDashboardFixture();
    const gateway = createGateway({
      dashboardAssetsDir,
      accounts: new MemoryAccountStore(),
      providers: [],
    });

    try {
      const admin = await gateway.fetch(new Request("http://127.0.0.1:2021/admin/missing"));
      const api = await gateway.fetch(new Request("http://127.0.0.1:2021/v1/not-dashboard"));

      expect(admin.status).toBe(404);
      expect(await admin.text()).not.toContain("Kyoli Dashboard");
      expect(api.status).toBe(404);
      expect(await api.text()).not.toContain("Kyoli Dashboard");
    } finally {
      await rm(dashboardAssetsDir, { recursive: true, force: true });
    }
  });

  it("blocks dashboard asset path traversal", async () => {
    const dashboardAssetsDir = await createDashboardFixture();
    const gateway = createGateway({
      dashboardAssetsDir,
      accounts: new MemoryAccountStore(),
      providers: [],
    });

    try {
      const response = await gateway.fetch(new Request("http://127.0.0.1:2021/dashboard/assets/..%2Findex.html"));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Kyoli Dashboard");
    } finally {
      await rm(dashboardAssetsDir, { recursive: true, force: true });
    }
  });

  it("treats an existing kyoli gateway on the same port as already running", async () => {
    const existing = createServer((request, response) => {
      if (request.url === "/health") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          service: "kyoli-gam",
          mode: "gateway",
        }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const port = await listen(existing);

    try {
      const server = await serveGateway({
        config: { host: "127.0.0.1", port },
        accounts: new MemoryAccountStore(),
        providers: [],
      });

      expect(server.alreadyRunning).toBe(true);
      expect(server.port).toBe(port);
      server.stop();
    } finally {
      await close(existing);
    }
  });

  it("rejects port conflicts held by another process", async () => {
    const existing = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ service: "not-kyoli" }));
    });
    const port = await listen(existing);

    try {
      await expect(serveGateway({
        config: { host: "127.0.0.1", port },
        accounts: new MemoryAccountStore(),
        providers: [],
      })).rejects.toThrow(`Port ${port} is already in use by another process`);
    } finally {
      await close(existing);
    }
  });

  it("keeps the server alive when a streamed response fails after headers are sent", async () => {
    const encoder = new TextEncoder();
    const codex = fakeProvider({
      id: "codex",
      routes: ["/backend-api/codex/responses"],
      models: [],
      handle: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stream"}}\n\n',
            ));
            setTimeout(() => controller.error(new Error("simulated upstream stream failure")), 20);
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const server = await serveGateway({
      config: { host: "127.0.0.1", port: 0 },
      accounts: new MemoryAccountStore(),
      providers: [codex],
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.3-codex", input: "hello", stream: true }),
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("response.created");
      expect(text).toContain("response.failed");
      expect(text).toContain("data: [DONE]");

      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({
        ok: true,
        service: "kyoli-gam",
        mode: "gateway",
      });
    } finally {
      server.stop(true);
    }
  });

  it("routes Anthropic-prefixed Claude messages to the Claude Code adapter", async () => {
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
        headers: {
          "content-type": "application/json",
          "x-kyoli-session-id": "thread-1",
        },
        body: JSON.stringify({
          model: "anthropic/claude-sonnet-4-5",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "claude-code" });
    expect(seenContext?.route).toBe("/v1/messages");
    expect(seenContext?.model).toBe("anthropic/claude-sonnet-4-5");
    expect(seenContext?.sessionKey).toBe("header:thread-1");
    expect(seenContext?.body).toEqual({
      model: "anthropic/claude-sonnet-4-5",
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

  it("prefers Codex turn-state headers over broader Codex session headers", async () => {
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
          "x-codex-session-id": "codex-terminal-session",
          "x-codex-turn-state": "codex-turn-state",
        },
        body: JSON.stringify({ model: "gpt-5.3-codex", input: "hello" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(seenContext?.sessionKey).toBe("header:codex-turn-state");
  });

  it("uses generic client session headers as sticky routing keys", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const claude = fakeProvider({
      id: "claude-code",
      routes: ["/v1/messages"],
      models: [
        {
          id: "anthropic/claude-sonnet-4-5",
          provider: "claude-code",
          upstreamId: "claude-sonnet-4-5",
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
        body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", messages: [] }),
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
          "Provide a familiar provider model such as openai/gpt-5.3-codex or anthropic/claude-sonnet-5.",
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
          metadata: {
            experimental_supported_tools: ["shell"],
          },
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
      base_instructions: "You are Codex, a coding agent based on GPT-5.",
      supported_in_api: true,
      priority: 0,
      minimal_client_version: null,
      supports_parallel_tool_calls: true,
      supports_reasoning_summaries: true,
      shell_type: "shell_command",
      experimental_supported_tools: ["shell"],
      prefer_websockets: true,
      visibility: "list",
    });
  });

  it("exposes Codex fast service tier metadata for GPT models", async () => {
    const codex = fakeProvider({
      id: "codex",
      routes: ["/backend-api/codex/responses"],
      models: [
        {
          id: "openai/gpt-5.5",
          provider: "codex",
          upstreamId: "gpt-5.5",
          displayName: "GPT-5.5",
          capabilities: ["responses", "tools", "reasoning", "codex"],
          aliases: ["gpt-5.5"],
        },
        {
          id: "openai/gpt-5.3-codex",
          provider: "codex",
          upstreamId: "gpt-5.3-codex",
          displayName: "GPT-5.3 Codex",
          capabilities: ["responses", "tools", "reasoning", "codex"],
          aliases: ["gpt-5.3-codex"],
        },
        {
          id: "openai/gpt-5.4-mini",
          provider: "codex",
          upstreamId: "gpt-5.4-mini",
          displayName: "GPT-5.4 mini",
          capabilities: ["responses", "tools", "reasoning", "codex"],
          aliases: ["gpt-5.4-mini"],
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

    const gpt55 = payload.models.find((model) => model.slug === "gpt-5.5");
    expect(gpt55).toMatchObject({
      additional_speed_tiers: ["fast"],
      service_tiers: [
        {
          id: "priority",
          name: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
    });

    const codexModel = payload.models.find((model) => model.slug === "gpt-5.3-codex");
    expect(codexModel?.service_tiers).toEqual([]);

    const miniModel = payload.models.find((model) => model.slug === "gpt-5.4-mini");
    expect(miniModel?.additional_speed_tiers).toEqual([]);
    expect(miniModel?.service_tiers).toEqual([]);
  });

  it("exposes Claude Code models as Codex-compatible virtual models without WebSocket preference", async () => {
    const claude = fakeProvider({
      id: "claude-code",
      routes: ["/v1/messages"],
      models: [
        {
          id: "anthropic/claude-sonnet-5",
          provider: "claude-code",
          upstreamId: "claude-sonnet-5",
          displayName: "Claude Sonnet 5",
          capabilities: ["messages", "tools", "streaming", "reasoning", "claude-code"],
          aliases: ["claude-code/claude-sonnet-5"],
        },
      ],
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [claude],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/backend-api/codex/models"),
    );
    const payload = (await response.json()) as {
      models: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(payload.models.find((model) => model.slug === "kyoli-claude/claude-sonnet-5")).toMatchObject({
      slug: "kyoli-claude/claude-sonnet-5",
      display_name: "Claude Sonnet 5 (Claude bridge)",
      supports_parallel_tool_calls: true,
      prefer_websockets: false,
      available_in_plans: ["claude-code"],
      visibility: "list",
    });
  });

  it("bridges virtual Claude Codex response requests through the Claude Code adapter", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const claude = fakeProvider({
      id: "claude-code",
      routes: ["/v1/messages"],
      models: [
        {
          id: "anthropic/claude-sonnet-4-5",
          provider: "claude-code",
          upstreamId: "claude-sonnet-4-5",
          displayName: "Claude Sonnet 4.5",
          capabilities: ["messages", "tools", "streaming", "claude-code"],
          aliases: ["claude-code/claude-sonnet-4-5"],
        },
      ],
      handle: async (context) => {
        seenContext = context;
        return new Response(
          [
            "event: message_start",
            'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[]}}',
            "",
            "event: content_block_start",
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
            "",
            "event: content_block_delta",
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
            "",
            "event: content_block_stop",
            'data: {"type":"content_block_stop","index":0}',
            "",
            "event: message_stop",
            'data: {"type":"message_stop"}',
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [claude],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kyoli-claude/claude-sonnet-4-5",
          instructions: "stay brief",
          reasoning: { effort: "low" },
          input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
          tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
        }),
      }),
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(seenContext?.route).toBe("/v1/messages");
    expect(seenContext?.model).toBe("claude-code/claude-sonnet-4-5");
    expect(seenContext?.body).toMatchObject({
      model: "claude-code/claude-sonnet-4-5",
      stream: true,
      output_config: { effort: "low" },
      system: "stay brief",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "shell", input_schema: { type: "object" } }],
    });
    expect(text).toContain("response.created");
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain('"delta":"hello"');
    expect(text).toContain("response.completed");
  });

  it("bridges virtual Claude compact requests through a non-streaming Claude Code request", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const claude = fakeProvider({
      id: "claude-code",
      routes: ["/v1/messages"],
      models: [
        {
          id: "anthropic/claude-sonnet-4-5",
          provider: "claude-code",
          upstreamId: "claude-sonnet-4-5",
          capabilities: ["messages", "streaming", "claude-code"],
        },
      ],
      handle: async (context) => {
        seenContext = context;
        return Response.json({
          id: "msg_compact",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "Summary" }],
        });
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [claude],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/backend-api/codex/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "kyoli-claude/claude-sonnet-4-5",
          input: "long conversation",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(seenContext?.route).toBe("/v1/messages");
    expect(seenContext?.body).toMatchObject({
      model: "claude-code/claude-sonnet-4-5",
      stream: false,
      messages: [{ role: "user", content: "long conversation" }],
    });
    expect(payload).toMatchObject({
      object: "response.compaction",
      type: "response.compact",
      status: "completed",
    });
    expect(JSON.stringify(payload)).toContain("Summary");
  });

  it("bridges virtual Claude Codex WebSocket response.create messages before Codex account selection", async () => {
    let seenContext: GatewayRequestContext | undefined;
    const claude = fakeProvider({
      id: "claude-code",
      routes: ["/v1/messages"],
      models: [
        {
          id: "anthropic/claude-sonnet-4-5",
          provider: "claude-code",
          upstreamId: "claude-sonnet-4-5",
          capabilities: ["messages", "tools", "streaming", "claude-code"],
        },
      ],
      handle: async (context) => {
        seenContext = context;
        return new Response(
          [
            "event: message_start",
            'data: {"type":"message_start","message":{"id":"msg_ws","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[]}}',
            "",
            "event: content_block_start",
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
            "",
            "event: content_block_delta",
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ws hello"}}',
            "",
            "event: content_block_stop",
            'data: {"type":"content_block_stop","index":0}',
            "",
            "event: message_stop",
            'data: {"type":"message_stop"}',
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const codex = fakeProvider({
      id: "codex",
      routes: ["/backend-api/codex/responses"],
      models: [],
      handleWebSocket: async () => {
        throw new Error("Codex adapter should not receive kyoli-claude WebSocket messages");
      },
    });

    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [codex, claude],
    });

    const websocket = fakeWebSocket([
      {
        type: "text",
        data: JSON.stringify({
          type: "response.create",
          response: {
            model: "kyoli-claude/claude-sonnet-4-5",
            instructions: "stay brief",
            input: "hello",
          },
        }),
      },
      { type: "close" },
    ]);
    await gateway.handleWebSocket(
      new Request("http://127.0.0.1:2021/backend-api/codex/responses", {
        headers: { "x-codex-session-id": "claude-ws-thread" },
      }),
      websocket,
    );

    expect(websocket.accepted).toBe(true);
    expect(seenContext?.route).toBe("/v1/messages");
    expect(seenContext?.model).toBe("claude-code/claude-sonnet-4-5");
    expect(seenContext?.sessionKey).toBe("header:claude-ws-thread");
    expect(seenContext?.body).toMatchObject({
      model: "claude-code/claude-sonnet-4-5",
      stream: true,
      system: "stay brief",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(websocket.sentText.join("\n")).toContain("response.output_text.delta");
    expect(websocket.sentText.join("\n")).toContain("ws hello");
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

  it("routes v1 Responses WebSocket upgrades to the Codex adapter", async () => {
    let seenContext: GatewayWebSocketContext | undefined;
    const codex = fakeProvider({
      id: "codex",
      routes: ["/v1/responses"],
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
      new Request("http://127.0.0.1:2021/v1/responses", {
        headers: { "x-codex-session-id": "v1-ws-thread" },
      }),
      websocket,
    );

    expect(websocket.accepted).toBe(true);
    expect(seenContext?.route).toBe("/v1/responses");
    expect(seenContext?.sessionKey).toBe("header:v1-ws-thread");
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

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return address.port;
}

async function createDashboardFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kyoli-dashboard-"));
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(
    join(dir, "index.html"),
    '<!doctype html><title>Kyoli Dashboard</title><div id="root"></div>',
    "utf8",
  );
  await writeFile(join(dir, "assets", "app.js"), "console.log('dashboard');", "utf8");
  return dir;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

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

function fakeWebSocket(messages: GatewayWebSocketMessage[] = []) {
  return {
    accepted: false,
    sentText: [] as string[],
    sentBinary: [] as Uint8Array[],
    async accept() {
      this.accepted = true;
    },
    async receive() {
      return messages.shift() ?? { type: "close" as const };
    },
    async sendText(data: string) {
      this.sentText.push(data);
      return undefined;
    },
    async sendBinary(data: Uint8Array) {
      this.sentBinary.push(data);
      return undefined;
    },
    async close() {
      return undefined;
    },
  };
}
