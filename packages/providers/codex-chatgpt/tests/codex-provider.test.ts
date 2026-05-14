import { describe, expect, it } from "vitest";
import {
  MemoryAccountStore,
  StickyAccountPool,
  type AccountExecutionTraceEvent,
  type GatewayWebSocketMessage,
} from "@kyoli-gam/core";
import { createCodexChatGPTProvider } from "../src";
import { classifyCodexJsonEventFailure, parseCodexRetryAfterSeconds } from "../src/failures";

describe("createCodexChatGPTProvider", () => {
  it("reads structured Codex reset metadata from rate-limit errors", () => {
    const resetEpoch = 4_102_444_800;

    const failure = classifyCodexJsonEventFailure(
      {
        type: "error",
        status: 429,
        error: {
          code: "usage_limit_reached",
          message: "usage limit",
          resets_at: String(resetEpoch),
        },
      },
      "startup",
    );

    expect(failure?.resetAt).toBe(new Date(resetEpoch * 1000).toISOString());
    expect(failure?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("does not treat Codex retry-at message text as reset metadata", () => {
    const failure = classifyCodexJsonEventFailure(
      {
        type: "error",
        status: 429,
        error: {
          code: "usage_limit_reached",
          message: "You've hit your usage limit. Upgrade to Plus, or try again at May 21st, 2026 12:55 PM.",
        },
      },
      "startup",
    );

    expect(failure?.resetAt).toBeUndefined();
    expect(failure?.retryAfterSeconds).toBeUndefined();
  });

  it("keeps short Codex retry-in message text as cooldown only", () => {
    expect(parseCodexRetryAfterSeconds("rate limited, try again in 250ms")).toBe(0.25);
    expect(parseCodexRetryAfterSeconds("rate limited, try again in 2s")).toBe(2);
  });

  it("maps Codex auth failures without status to auth account failures", () => {
    const failure = classifyCodexJsonEventFailure(
      {
        type: "error",
        error: {
          code: "invalid_api_key",
          message: "invalid access token",
        },
      },
      "startup",
    );

    expect(failure).toMatchObject({
      class: "auth",
      httpStatus: 401,
      retryScope: "next_account",
    });
  });

  it("proxies /backend-api/codex/responses with Codex-compatible OAuth headers", async () => {
    let upstreamUrl = "";
    let upstreamBody: unknown;
    let upstreamAuth = "";
    let upstreamOriginator = "";
    let upstreamUserAgent = "";
    let upstreamAccountId = "";

    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
        accountId: "acct_test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        upstreamUrl = String(input);
        upstreamBody = JSON.parse(String(init?.body));
        upstreamAuth = headers.get("authorization") ?? "";
        upstreamOriginator = headers.get("originator") ?? "";
        upstreamUserAgent = headers.get("user-agent") ?? "";
        upstreamAccountId = headers.get("ChatGPT-Account-ID") ?? "";

        return new Response(JSON.stringify({ id: "resp_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          input: "hello",
          store: true,
        }),
      }),
      route: "/backend-api/codex/responses",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        input: "hello",
        store: true,
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "resp_test" });
    expect(upstreamUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(upstreamAuth).toBe("Bearer access-test");
    expect(upstreamOriginator).toBe("codex_cli_rs");
    expect(upstreamUserAgent).toBe("codex_cli_rs/0.0.0");
    expect(upstreamAccountId).toBe("acct_test");
    expect(upstreamBody).toEqual({
      model: "gpt-5.3-codex",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      store: false,
    });
  });

  it("preserves native Codex originator and user-agent headers", async () => {
    let upstreamOriginator = "";
    let upstreamUserAgent = "";

    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        upstreamOriginator = headers.get("originator") ?? "";
        upstreamUserAgent = headers.get("user-agent") ?? "";

        return new Response(JSON.stringify({ id: "resp_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          originator: "codex_vscode",
          "user-agent": "codex_vscode/0.0.0",
        },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          input: "hello",
        }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        input: "hello",
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamOriginator).toBe("codex_vscode");
    expect(upstreamUserAgent).toBe("codex_vscode/0.0.0");
  });

  it("scrubs non-native OpenAI SDK headers on the /v1 Responses bridge", async () => {
    let upstreamHeaders = new Headers();

    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ id: "resp_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "AI SDK/5.0 OpenCode",
          "x-stainless-package-version": "5.0.0",
          "x-openai-client-user-agent": '{"lang":"js"}',
          "ai-sdk-provider": "openai",
          "x-forwarded-for": "127.0.0.1",
          "x-request-id": "req_test",
        },
        body: JSON.stringify({
          model: "openai/gpt-5.3-codex",
          input: "hello",
        }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: {
        model: "openai/gpt-5.3-codex",
        input: "hello",
      },
      model: "openai/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamHeaders.get("originator")).toBe("codex_chatgpt_desktop");
    expect(upstreamHeaders.get("user-agent")).toBe("codex_cli_rs/0.0.0");
    expect(upstreamHeaders.get("x-request-id")).toBe("req_test");
    expect(upstreamHeaders.has("x-stainless-package-version")).toBe(false);
    expect(upstreamHeaders.has("x-openai-client-user-agent")).toBe(false);
    expect(upstreamHeaders.has("ai-sdk-provider")).toBe(false);
    expect(upstreamHeaders.has("x-forwarded-for")).toBe(false);
  });

  it("does not treat a native originator with an SDK user-agent as native Codex", async () => {
    let upstreamHeaders = new Headers();

    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ id: "resp_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          originator: "codex_cli_rs",
          "user-agent": "AI SDK/5.0 OpenCode",
          "x-stainless-package-version": "5.0.0",
        },
        body: JSON.stringify({
          model: "openai/gpt-5.3-codex",
          input: "hello",
        }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: {
        model: "openai/gpt-5.3-codex",
        input: "hello",
      },
      model: "openai/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamHeaders.get("originator")).toBe("codex_chatgpt_desktop");
    expect(upstreamHeaders.get("user-agent")).toBe("codex_cli_rs/0.0.0");
    expect(upstreamHeaders.has("x-stainless-package-version")).toBe(false);
  });

  it("normalizes common Responses compatibility aliases before proxying", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "resp_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          input: "hello",
          enable_thinking: true,
          reasoningEffort: "high",
          reasoningSummary: "auto",
          max_tokens: 128,
          top_p: 0.5,
          truncation: "auto",
          context_management: [{ type: "compaction", compact_threshold: 12000 }],
          user: "client-user",
          service_tier: "fast",
          store: true,
          parallel_tool_calls: false,
          include: ["file_search_call.results"],
          promptCacheKey: "thread_123",
          textVerbosity: "low",
          tool_choice: {
            type: "allowed_tools",
            tools: [{ type: "web_search_preview_2025_03_11" }],
          },
          tools: [{ type: "web_search_preview_2025_03_11" }],
        }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        input: "hello",
        enable_thinking: true,
        reasoningEffort: "high",
        reasoningSummary: "auto",
        max_tokens: 128,
        top_p: 0.5,
        truncation: "auto",
        context_management: [{ type: "compaction", compact_threshold: 12000 }],
        user: "client-user",
        service_tier: "fast",
        store: true,
        parallel_tool_calls: false,
        include: ["file_search_call.results"],
        promptCacheKey: "thread_123",
        textVerbosity: "low",
        tool_choice: {
          type: "allowed_tools",
          tools: [{ type: "web_search_preview_2025_03_11" }],
        },
        tools: [{ type: "web_search_preview_2025_03_11" }],
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.3-codex",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      reasoning: { effort: "high", summary: "auto" },
      service_tier: "priority",
      prompt_cache_key: "thread_123",
      text: { verbosity: "low" },
      stream: true,
      store: false,
      parallel_tool_calls: true,
      include: ["file_search_call.results", "reasoning.encrypted_content"],
      tool_choice: { type: "allowed_tools", tools: [{ type: "web_search" }] },
      tools: [{ type: "web_search" }],
    });
    expect(upstreamBody.enable_thinking).toBeUndefined();
    expect(upstreamBody.reasoningEffort).toBeUndefined();
    expect(upstreamBody.reasoningSummary).toBeUndefined();
    expect(upstreamBody.max_output_tokens).toBeUndefined();
    expect(upstreamBody.max_tokens).toBeUndefined();
    expect(upstreamBody.top_p).toBeUndefined();
    expect(upstreamBody.truncation).toBeUndefined();
    expect(upstreamBody.context_management).toBeUndefined();
    expect(upstreamBody.user).toBeUndefined();
    expect(upstreamBody.promptCacheKey).toBeUndefined();
    expect(upstreamBody.textVerbosity).toBeUndefined();
  });

  it("rewrites fast model aliases to priority service tier", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "resp_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.5-fast",
          input: "hello",
        }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: {
        model: "openai/gpt-5.5-fast",
        input: "hello",
      },
      model: "openai/gpt-5.5-fast",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.5",
      service_tier: "priority",
    });
  });

  it("maps Chat Completions response_format and tool choice like codex-lb", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "resp_test", status: "completed", output_text: "{}" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          reasoning_effort: "high",
          tool_choice: { type: "function", function: { name: "read_file" } },
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "result",
              schema: { type: "object", properties: { ok: { type: "boolean" } } },
              strict: true,
            },
          },
        }),
      }),
      route: "/v1/chat/completions",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "high",
        tool_choice: { type: "function", function: { name: "read_file" } },
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "result",
            schema: { type: "object", properties: { ok: { type: "boolean" } } },
            strict: true,
          },
        },
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.3-codex",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      reasoning: { effort: "high" },
      tool_choice: { type: "function", name: "read_file" },
      text: {
        format: {
          type: "json_schema",
          name: "result",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
          strict: true,
        },
      },
    });
    expect(upstreamBody.reasoning_effort).toBeUndefined();
    expect(upstreamBody.response_format).toBeUndefined();
  });

  it("maps Chat Completions multimodal file and image parts like codex-lb", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "resp_test", status: "completed", output_text: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          messages: [{
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "https://example.com/a.png", detail: "high" } },
              { type: "input_audio", input_audio: { format: "mp3", data: "YWJj" } },
              { type: "file", file: { data: "Zm9v", mime_type: "text/plain" } },
            ],
          }],
        }),
      }),
      route: "/v1/chat/completions",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/a.png", detail: "high" } },
            { type: "input_audio", input_audio: { format: "mp3", data: "YWJj" } },
            { type: "file", file: { data: "Zm9v", mime_type: "text/plain" } },
          ],
        }],
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody.input).toEqual([{
      role: "user",
      content: [
        { type: "input_image", image_url: "https://example.com/a.png", detail: "high" },
        { type: "input_file", file_url: "data:audio/mpeg;base64,YWJj" },
        { type: "input_file", file_url: "data:text/plain;base64,Zm9v" },
      ],
    }]);
  });

  it("maps Chat Completions assistant tool-call history and tool outputs", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "resp_test", status: "completed", output_text: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          messages: [
            { role: "user", content: "weather?" },
            {
              role: "assistant",
              content: "Let me check",
              refusal: "partial refusal",
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: "{\"loc\":\"NYC\"}" },
              }],
            },
            { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "72" }, { type: "text", text: "F" }] },
            { role: "user", content: "thanks" },
          ],
        }),
      }),
      route: "/v1/chat/completions",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: "Let me check",
            refusal: "partial refusal",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "{\"loc\":\"NYC\"}" },
            }],
          },
          { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "72" }, { type: "text", text: "F" }] },
          { role: "user", content: "thanks" },
        ],
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "weather?" }] },
      { role: "assistant", content: [{ type: "output_text", text: "Let me check" }, { type: "output_text", text: "partial refusal" }] },
      { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"loc\":\"NYC\"}" },
      { type: "function_call_output", call_id: "call_1", output: "72F" },
      { role: "user", content: [{ type: "input_text", text: "thanks" }] },
    ]);
  });

  it("rejects Chat file_id file parts before upstream", async () => {
    let called = false;
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async () => {
        called = true;
        return new Response("{}");
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file_123" } }] }],
        }),
      }),
      route: "/v1/chat/completions",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file_123" } }] }],
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it("normalizes v1 Responses messages input like codex-lb", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"status\":\"completed\"}}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          instructions: "primary",
          messages: [
            { role: "developer", content: "secondary" },
            { role: "assistant", content: "Prior answer" },
            { role: "user", content: "Continue" },
          ],
        }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        instructions: "primary",
        messages: [
          { role: "developer", content: "secondary" },
          { role: "assistant", content: "Prior answer" },
          { role: "user", content: "Continue" },
        ],
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.3-codex",
      instructions: "primary\nsecondary",
      input: [
        { role: "assistant", content: [{ type: "output_text", text: "Prior answer" }] },
        { role: "user", content: [{ type: "input_text", text: "Continue" }] },
      ],
    });
    expect(upstreamBody.messages).toBeUndefined();
  });

  it("moves Responses system and developer input items into instructions before Codex upstream", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"status\":\"completed\"}}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          input: [
            { role: "system", content: "Follow the system policy." },
            { role: "developer", content: "Use concise replies." },
            { role: "user", content: [{ type: "input_text", text: "hello" }] },
          ],
          stream: true,
        }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        input: [
          { role: "system", content: "Follow the system policy." },
          { role: "developer", content: "Use concise replies." },
          { role: "user", content: [{ type: "input_text", text: "hello" }] },
        ],
        stream: true,
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.3-codex",
      instructions: "Follow the system policy.\nUse concise replies.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      stream: true,
    });
  });

  it("collects OpenAI-style non-streaming Responses requests from Codex SSE", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(
          [
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}",
            "",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.3-codex\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}",
            "",
          ].join("\n"),
          { status: 200 },
        );
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          input: "hello",
          store: false,
        }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        input: "hello",
        store: false,
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.3-codex",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      store: false,
    });
    expect(await response.json()).toMatchObject({
      id: "resp_test",
      object: "response",
      model: "gpt-5.3-codex",
      status: "completed",
      output_text: "hello",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  });

  it("preserves Responses reasoning and tool output items when collecting Codex SSE", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(
          [
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_reasoning",
                object: "response",
                status: "completed",
                model: "gpt-5.3-codex",
                output: [
                  {
                    id: "rs_1",
                    type: "reasoning",
                    encrypted_content: "enc_reasoning_payload",
                  },
                  {
                    id: "fc_1",
                    type: "function_call",
                    call_id: "call_1",
                    name: "read_file",
                    arguments: "{\"path\":\"README.md\"}",
                  },
                  {
                    id: "msg_1",
                    type: "message",
                    status: "completed",
                    role: "assistant",
                    content: [
                      {
                        type: "output_text",
                        text: "done",
                        annotations: [],
                      },
                    ],
                  },
                ],
                usage: {
                  input_tokens: 10,
                  output_tokens: 4,
                  output_tokens_details: { reasoning_tokens: 2 },
                  total_tokens: 14,
                },
              },
            })}`,
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });

    const body = {
      model: "codex/gpt-5.3-codex",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "inspect README" }],
        },
        {
          type: "function_call_output",
          call_id: "call_prev",
          output: "previous tool result",
        },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object" },
        },
      ],
      tool_choice: "auto",
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      store: false,
    };

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body,
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.3-codex",
      stream: true,
      store: false,
      parallel_tool_calls: true,
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      tools: body.tools,
      tool_choice: "auto",
      input: body.input,
    });
    const payload = await response.json();
    expect(payload).toMatchObject({
      id: "resp_reasoning",
      object: "response",
      model: "gpt-5.3-codex",
      status: "completed",
      output_text: "done",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 14,
      },
    });
    expect(payload.output).toEqual([
      {
        id: "rs_1",
        type: "reasoning",
        encrypted_content: "enc_reasoning_payload",
      },
      {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}",
      },
      {
        id: "msg_1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "done",
            annotations: [],
          },
        ],
      },
    ]);
  });

  it("preserves Responses compatibility fields used by Codex clients", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "resp_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const input = [{
      role: "user",
      content: [
        { type: "input_text", text: "inspect this" },
        { type: "input_file", file_id: "file_123" },
      ],
    }];
    const tools = [{ type: "function", name: "read_file" }];

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          input,
          tools,
          tool_choice: "auto",
          previous_response_id: "resp_prev",
          service_tier: "auto",
          stream: true,
          reasoning: { effort: "high" },
        }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        input,
        tools,
        tool_choice: "auto",
        previous_response_id: "resp_prev",
        service_tier: "auto",
        stream: true,
        reasoning: { effort: "high" },
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.3-codex",
      input,
      tools,
      tool_choice: "auto",
      previous_response_id: "resp_prev",
      service_tier: "auto",
      stream: true,
      reasoning: { effort: "high" },
    });
  });

  it("proxies compact requests with codex-lb-style request cleanup", async () => {
    let upstreamUrl = "";
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (input, init) => {
        upstreamUrl = String(input);
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ type: "response.compact", status: "completed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          input: "hello",
          store: true,
          service_tier: "fast",
          tools: [{ type: "web_search" }],
          tool_choice: "auto",
          parallel_tool_calls: true,
        }),
      }),
      route: "/v1/responses/compact",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        input: "hello",
        store: true,
        service_tier: "fast",
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
        parallel_tool_calls: true,
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamUrl).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.3-codex",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      service_tier: "priority",
    });
    expect(upstreamBody.store).toBeUndefined();
    expect(upstreamBody.tools).toBeUndefined();
    expect(upstreamBody.tool_choice).toBeUndefined();
    expect(upstreamBody.parallel_tool_calls).toBeUndefined();
  });

  it("retries compact 5xx responses once with the same contract", async () => {
    const statuses: number[] = [];
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      compactRetryDelayMs: 0,
      fetch: async (_input, init) => {
        statuses.push(statuses.length === 0 ? 503 : 200);
        const body = JSON.parse(String(init?.body));
        expect(body.store).toBeUndefined();
        return new Response(JSON.stringify({ object: "response.compaction", output: [] }), {
          status: statuses.at(-1),
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/backend-api/codex/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.3-codex", instructions: "hi", input: [], store: true }),
      }),
      route: "/backend-api/codex/responses/compact",
      sessionKey: "session-a",
      body: { model: "gpt-5.3-codex", instructions: "hi", input: [], store: true },
      model: "gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(statuses).toEqual([503, 200]);
  });

  it("proxies transcription multipart requests to the Codex transcribe endpoint", async () => {
    let upstreamUrl = "";
    let upstreamAuth = "";
    let upstreamBody: FormData | undefined;
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });
    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (input, init) => {
        upstreamUrl = String(input);
        upstreamAuth = new Headers(init?.headers).get("authorization") ?? "";
        upstreamBody = init?.body as FormData;
        return new Response(JSON.stringify({ text: "transcribed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const form = new FormData();
    form.set("model", "gpt-4o-transcribe");
    form.set("prompt", "short");
    form.set("file", new File([new Uint8Array([1, 2, 3])], "a.wav", { type: "audio/wav" }));

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/audio/transcriptions", {
        method: "POST",
        body: form,
      }),
      route: "/v1/audio/transcriptions",
      sessionKey: "session-a",
      model: "gpt-4o-transcribe",
    });

    expect(response.status).toBe(200);
    expect(upstreamUrl).toBe("https://chatgpt.com/backend-api/transcribe");
    expect(upstreamAuth).toBe("Bearer access-test");
    expect(upstreamBody?.get("prompt")).toBe("short");
    expect(upstreamBody?.get("file")).toBeInstanceOf(File);
  });

  it("translates image generation requests through Responses image_generation", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });
    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response([
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"resp_img","status":"completed","output":[{"type":"image_generation_call","result":"abc123"}]}}',
          "",
        ].join("\n"), { status: 200 });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-image-1.5", prompt: "a tiny icon" }),
      }),
      route: "/v1/images/generations",
      sessionKey: "session-a",
      body: { model: "gpt-image-1.5", prompt: "a tiny icon" },
      model: "gpt-image-1.5",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.5",
      tool_choice: { type: "image_generation" },
      store: false,
      stream: true,
    });
    expect(upstreamBody.tools).toEqual([
      expect.objectContaining({ type: "image_generation", model: "gpt-image-1.5" }),
    ]);
    expect(await response.json()).toMatchObject({
      data: [{ b64_json: "abc123" }],
    });
  });

  it("creates Codex file upload URLs and pins finalize to the same OAuth account", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });
    const upstreamCalls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store, { strategy: "round-robin" }),
      fileFinalizePollDelayMs: 1,
      fileFinalizeBudgetMs: 25,
      fetch: async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body));
        upstreamCalls.push({
          url,
          auth: new Headers(init?.headers).get("authorization") ?? "",
          body,
        });

        if (url.endsWith("/backend-api/files")) {
          return new Response(JSON.stringify({ file_id: "file_123", upload_url: "https://upload.test" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ status: "uploaded" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const createResponse = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/backend-api/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_name: "prompt.txt", file_size: 12 }),
      }),
      route: "/backend-api/files",
      sessionKey: "session-a",
      body: { file_name: "prompt.txt", file_size: 12 },
    });
    const finalizeResponse = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/backend-api/files/file_123/uploaded", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      route: "/backend-api/files/uploaded",
      sessionKey: "session-b",
      body: {},
    });

    expect(createResponse.status).toBe(200);
    expect(finalizeResponse.status).toBe(200);
    expect(upstreamCalls).toEqual([
      {
        url: "https://chatgpt.com/backend-api/files",
        auth: "Bearer first-access",
        body: { file_name: "prompt.txt", file_size: 12, use_case: "codex" },
      },
      {
        url: "https://chatgpt.com/backend-api/files/file_123/uploaded",
        auth: "Bearer first-access",
        body: {},
      },
    ]);
  });

  it("pins Responses input_file requests to the upload account unless session affinity is stronger", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });
    const upstreamCalls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store, { strategy: "round-robin" }),
      fetch: async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body));
        upstreamCalls.push({
          url,
          auth: new Headers(init?.headers).get("authorization") ?? "",
          body,
        });

        if (url.endsWith("/backend-api/files")) {
          return new Response(JSON.stringify({ file_id: "file_123", upload_url: "https://upload.test" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"status\":\"completed\"}}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/backend-api/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_name: "prompt.txt", file_size: 12 }),
      }),
      route: "/backend-api/files",
      sessionKey: "session-a",
      body: { file_name: "prompt.txt", file_size: 12 },
    });
    await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          input: [{ role: "user", content: [{ type: "input_file", file_id: "file_123" }] }],
        }),
      }),
      route: "/v1/responses",
      sessionKey: "fallback:anonymous:gpt-5.3-codex",
      body: {
        model: "codex/gpt-5.3-codex",
        input: [{ role: "user", content: [{ type: "input_file", file_id: "file_123" }] }],
      },
      model: "codex/gpt-5.3-codex",
    });
    await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          prompt_cache_key: "thread_123",
          input: [{ role: "user", content: [{ type: "input_file", file_id: "file_123" }] }],
        }),
      }),
      route: "/v1/responses",
      sessionKey: "prompt_cache:thread_123",
      body: {
        model: "codex/gpt-5.3-codex",
        prompt_cache_key: "thread_123",
        input: [{ role: "user", content: [{ type: "input_file", file_id: "file_123" }] }],
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(upstreamCalls.map((call) => call.auth)).toEqual([
      "Bearer first-access",
      "Bearer first-access",
      "Bearer second-access",
    ]);
  });

  it("polls Codex file finalize retry responses until uploaded", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });
    let finalizeCalls = 0;

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fileFinalizePollDelayMs: 1,
      fileFinalizeBudgetMs: 25,
      fetch: async () => {
        finalizeCalls += 1;
        return new Response(
          JSON.stringify(finalizeCalls === 1 ? { status: "retry" } : { status: "uploaded" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/backend-api/files/file_123/uploaded", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      route: "/backend-api/files/uploaded",
      sessionKey: "session-a",
      body: {},
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "uploaded" });
    expect(finalizeCalls).toBe(2);
  });

  it("rejects oversized Codex file create requests before upstream", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });
    let upstreamCalled = false;

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async () => {
        upstreamCalled = true;
        return new Response(null, { status: 500 });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/backend-api/files", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_name: "huge.bin", file_size: 513 * 1024 * 1024 }),
      }),
      route: "/backend-api/files",
      sessionKey: "session-a",
      body: { file_name: "huge.bin", file_size: 513 * 1024 * 1024 },
    });

    expect(response.status).toBe(400);
    expect(upstreamCalled).toBe(false);
  });

  it("returns 401 when no OAuth account is available", async () => {
    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(new MemoryAccountStore()),
      fetch: async () => new Response(null, { status: 500 }),
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex/gpt-5.3-codex", input: "hello" }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: { model: "codex/gpt-5.3-codex", input: "hello" },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(401);
  });

  it("refreshes expired OAuth credentials before proxying", async () => {
    let upstreamAuth = "";
    let refreshTokenSeen = "";

    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "expired-access",
        expiresAt: Date.now() - 1000,
        refreshToken: "refresh-old",
        accountId: "acct_old",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      tokenRefresh: async (refreshToken) => {
        refreshTokenSeen = refreshToken;
        return {
          accessToken: "fresh-access",
          refreshToken: "refresh-new",
          expiresAt: Date.now() + 60 * 60 * 1000,
          accountId: "acct_new",
        };
      },
      fetch: async (_input, init) => {
        upstreamAuth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ id: "resp_test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex/gpt-5.3-codex", input: "hello" }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: { model: "codex/gpt-5.3-codex", input: "hello" },
      model: "codex/gpt-5.3-codex",
    });

    const updated = await store.get(account.id);
    expect(response.status).toBe(200);
    expect(refreshTokenSeen).toBe("refresh-old");
    expect(upstreamAuth).toBe("Bearer fresh-access");
    expect(updated?.credentials.accessToken).toBe("fresh-access");
    expect(updated?.credentials.refreshToken).toBe("refresh-new");
    expect(updated?.credentials.accountId).toBe("acct_new");
  });

  it("fails over when an expired account cannot refresh", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "expired-access",
        expiresAt: Date.now() - 1000,
        refreshToken: "refresh-bad",
      },
    });
    const second = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });
    const upstreamAuths: string[] = [];

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      tokenRefresh: async () => {
        throw new Error("refresh exploded");
      },
      fetch: async (_input, init) => {
        upstreamAuths.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response(JSON.stringify({ id: "resp_second" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex/gpt-5.3-codex", input: "hello" }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: { model: "codex/gpt-5.3-codex", input: "hello" },
      model: "codex/gpt-5.3-codex",
    });

    const firstUpdated = await store.get(first.id);
    const secondUpdated = await store.get(second.id);
    expect(response.status).toBe(200);
    expect(upstreamAuths).toEqual(["Bearer second-access"]);
    expect(firstUpdated?.enabled).toBe(false);
    expect(firstUpdated?.reauthRequiredReason).toBe("Codex OAuth token refresh failed");
    expect(secondUpdated?.lastUsedAt).toBeTruthy();
  });

  it("fails over after upstream rate limits an OAuth account", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    const second = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });
    const upstreamAuths: string[] = [];

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        upstreamAuths.push(authorization);

        if (authorization === "Bearer first-access") {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "60",
            },
          });
        }

        return new Response(JSON.stringify({ id: "resp_second" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex/gpt-5.3-codex", input: "hello" }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: { model: "codex/gpt-5.3-codex", input: "hello" },
      model: "codex/gpt-5.3-codex",
    });

    const firstUpdated = await store.get(first.id);
    const secondUpdated = await store.get(second.id);
    expect(response.status).toBe(200);
    expect(upstreamAuths).toEqual(["Bearer first-access", "Bearer second-access"]);
    expect(firstUpdated?.failureCount).toBe(1);
    expect(firstUpdated?.rateLimitResetAt).toBeTruthy();
    expect(secondUpdated?.lastUsedAt).toBeTruthy();
  });

  it("records Codex reset headers when rate limited without retry-after", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        if (authorization === "Bearer first-access") {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "x-codex-primary-reset-after-seconds": "120",
              "x-codex-secondary-reset-after-seconds": "600",
            },
          });
        }

        return new Response(JSON.stringify({ id: "resp_second" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex/gpt-5.3-codex", input: "hello" }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: { model: "codex/gpt-5.3-codex", input: "hello" },
      model: "codex/gpt-5.3-codex",
    });

    const firstUpdated = await store.get(first.id);
    expect(response.status).toBe(200);
    expect(firstUpdated?.rateLimitResetAt).toBeTruthy();
    const resetInMs = new Date(firstUpdated?.rateLimitResetAt ?? "").getTime() - Date.now();
    expect(resetInMs).toBeGreaterThan(60_000);
    expect(resetInMs).toBeLessThanOrEqual(130_000);
  });

  it("backs off Codex 429s even when no reset headers are present", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        if (authorization === "Bearer first-access") {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ id: "resp_second" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex/gpt-5.3-codex", input: "hello" }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: { model: "codex/gpt-5.3-codex", input: "hello" },
      model: "codex/gpt-5.3-codex",
    });

    const firstUpdated = await store.get(first.id);
    expect(response.status).toBe(200);
    expect(firstUpdated?.rateLimitResetAt).toBeTruthy();
    const resetInMs = new Date(firstUpdated?.rateLimitResetAt ?? "").getTime() - Date.now();
    expect(resetInMs).toBeGreaterThan(4 * 60_000);
    expect(resetInMs).toBeLessThanOrEqual(5 * 60_000);
  });

  it("fails over when Codex emits a startup usage-limit response.failed event before output", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });
    const upstreamAuths: string[] = [];

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        upstreamAuths.push(authorization);
        if (authorization === "Bearer first-access") {
          return new Response(chunkedTextStream([
            [
              "event: response.created",
              'data: {"type":"response.created","response":{"id":"resp_first","status":"in_progress"}}',
              "",
            ].join("\n"),
            [
              "event: response.in_progress",
              'data: {"type":"response.in_progress","response":{"id":"resp_first","status":"in_progress"}}',
              "",
            ].join("\n"),
            [
              "event: response.failed",
              'data: {"type":"response.failed","response":{"id":"resp_first","status":"failed","error":{"code":"usage_limit_reached","message":"Youve hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:55 PM."}}}',
              "",
            ].join("\n"),
          ]), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }

        return new Response(
          [
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_second","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex/gpt-5.3-codex", input: "hello" }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: { model: "codex/gpt-5.3-codex", input: "hello" },
      model: "codex/gpt-5.3-codex",
    });

    const firstUpdated = await store.get(first.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "resp_second",
      output_text: "ok",
    });
    expect(upstreamAuths).toEqual(["Bearer first-access", "Bearer second-access"]);
    expect(firstUpdated?.rateLimitResetAt).toBeUndefined();
    expect(firstUpdated?.rateLimitBlockedAt).toBeTruthy();
  });

  it("fails over when Codex emits a startup usage-limit error event", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });
    const upstreamAuths: string[] = [];

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        upstreamAuths.push(authorization);
        if (authorization === "Bearer first-access") {
          return new Response(
            [
              "event: error",
              'data: {"type":"error","status":429,"error":{"type":"invalid_request_error","code":"usage_limit_reached","message":"The usage limit has been reached"}}',
              "",
            ].join("\n"),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          );
        }

        return new Response(
          [
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_second","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex/gpt-5.3-codex", input: "hello" }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: { model: "codex/gpt-5.3-codex", input: "hello" },
      model: "codex/gpt-5.3-codex",
    });

    const firstUpdated = await store.get(first.id);
    expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "resp_second",
        output_text: "ok",
      });
      expect(upstreamAuths).toEqual(["Bearer first-access", "Bearer second-access"]);
      expect(firstUpdated?.rateLimitResetAt).toBeUndefined();
      expect(firstUpdated?.rateLimitBlockedAt).toBeTruthy();
      expect(firstUpdated?.lastFailureClass).toBe("rate_limit");
      expect(firstUpdated?.lastFailureCode).toBe("usage_limit_reached");
    });

  it("retries transient Codex startup failures on the same account before failing over", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    const upstreamAuths: string[] = [];

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        upstreamAuths.push(authorization);
        if (upstreamAuths.length === 1) {
          return new Response(
            [
              "event: error",
              'data: {"type":"error","status":502,"error":{"code":"upstream_disconnected","message":"stream disconnected before completion: websocket closed by server before response.completed"}}',
              "",
            ].join("\n"),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          );
        }

        return new Response(
          [
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_retry_ok","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex/gpt-5.3-codex", input: "hello" }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: { model: "codex/gpt-5.3-codex", input: "hello" },
      model: "codex/gpt-5.3-codex",
    });

    const updated = await store.get(account.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "resp_retry_ok", output_text: "ok" });
    expect(upstreamAuths).toEqual(["Bearer first-access", "Bearer first-access"]);
    expect(updated?.failureCount).toBe(0);
    expect(updated?.lastUsedAt).toBeTruthy();
  });

  it("exposes account execution trace events", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });
    const trace: AccountExecutionTraceEvent[] = [];

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      onTrace: (event) => trace.push(event),
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ id: "resp_test" }), {
          status: authorization === "Bearer first-access" ? 429 : 200,
          headers: {
            "content-type": "application/json",
            "retry-after": "60",
          },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex/gpt-5.3-codex", input: "hello" }),
      }),
      route: "/v1/responses",
      sessionKey: "session-a",
      body: { model: "codex/gpt-5.3-codex", input: "hello" },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(trace.map((event) => event.type)).toEqual([
      "selected",
      "response",
      "retry",
      "selected",
      "response",
    ]);
    expect(trace.filter((event) => event.type === "response")).toMatchObject([
      { status: 429, retryable: true },
      { status: 200, retryable: false },
    ]);
  });

  it("converts non-streaming chat completions through Codex Responses", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });
    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(
          [
            "event: response.output_text.delta",
            'data: {"type":"response.output_text.delta","delta":"hello from responses"}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_test","status":"completed","usage":{"input_tokens":5,"output_tokens":3}}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 64,
          tools: [
            {
              type: "function",
              function: {
                name: "read_file",
                description: "read a file",
                parameters: { type: "object" },
              },
            },
          ],
        }),
      }),
      route: "/v1/chat/completions",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 64,
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "read a file",
              parameters: { type: "object" },
            },
          },
        ],
      },
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.3-codex",
      instructions: "You are a helpful assistant.",
      store: false,
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "read a file",
          parameters: { type: "object" },
        },
      ],
    });
    expect(upstreamBody.max_output_tokens).toBeUndefined();
    expect(await response.json()).toMatchObject({
      id: "resp_test",
      object: "chat.completion",
      model: "codex/gpt-5.3-codex",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello from responses" },
          finish_reason: "stop",
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
    });
  });

  it("moves chat system and developer messages into Responses instructions", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });
    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "resp_test", output_text: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const body = {
      model: "codex/gpt-5.3-codex",
      messages: [
        { role: "system", content: "Follow the house style." },
        { role: "developer", content: [{ type: "text", text: "Prefer short answers." }] },
        { role: "user", content: "hello" },
      ],
    };

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      route: "/v1/chat/completions",
      sessionKey: "session-a",
      body,
      model: "codex/gpt-5.3-codex",
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      instructions: "Follow the house style.\n\nPrefer short answers.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    });
  });

  it("converts streaming chat completions through Codex Responses SSE", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });
    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(
          [
            "event: response.output_text.delta",
            'data: {"type":"response.output_text.delta","delta":"hello"}',
            "",
            "event: response.output_text.delta",
            'data: {"type":"response.output_text.delta","delta":" stream"}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"status":"completed"}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
      route: "/v1/chat/completions",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      model: "codex/gpt-5.3-codex",
    });

    const frames = parseSseData(await response.text());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(upstreamBody).toMatchObject({
      model: "gpt-5.3-codex",
      instructions: "You are a helpful assistant.",
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      stream: true,
    });
    expect(frames.slice(0, -1).map((frame) => JSON.parse(frame))).toMatchObject([
      {
        object: "chat.completion.chunk",
        model: "codex/gpt-5.3-codex",
        choices: [{ delta: { role: "assistant" }, finish_reason: null }],
      },
      {
        object: "chat.completion.chunk",
        model: "codex/gpt-5.3-codex",
        choices: [{ delta: { content: "hello" }, finish_reason: null }],
      },
      {
        object: "chat.completion.chunk",
        model: "codex/gpt-5.3-codex",
        choices: [{ delta: { content: " stream" }, finish_reason: null }],
      },
      {
        object: "chat.completion.chunk",
        model: "codex/gpt-5.3-codex",
        choices: [{ delta: {}, finish_reason: "stop" }],
      },
    ]);
    expect(frames.at(-1)).toBe("[DONE]");
  });

  it("terminates streaming chat completions with an error frame on mid-stream Codex failure", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });
    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async () =>
        new Response(
          [
            "event: response.output_text.delta",
            'data: {"type":"response.output_text.delta","delta":"partial"}',
            "",
            "event: response.failed",
            'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"upstream_disconnected","message":"stream disconnected before completion: websocket closed by server before response.completed"}}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "codex/gpt-5.3-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
      route: "/v1/chat/completions",
      sessionKey: "session-a",
      body: {
        model: "codex/gpt-5.3-codex",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      model: "codex/gpt-5.3-codex",
    });

    const frames = parseSseData(await response.text());
    expect(frames.slice(0, -1).map((frame) => JSON.parse(frame))).toMatchObject([
      {
        choices: [{ delta: { role: "assistant" }, finish_reason: null }],
      },
      {
        choices: [{ delta: { content: "partial" }, finish_reason: null }],
      },
      {
        error: {
          code: "upstream_disconnected",
          message: "stream disconnected before completion: websocket closed by server before response.completed",
        },
      },
    ]);
    expect(frames.at(-1)).toBe("[DONE]");
  });

  it("streams chat tool calls through Codex Responses function-call events", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });
    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async () =>
        new Response(
          [
            "event: response.output_item.added",
            'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"skill_view","arguments":""}}',
            "",
            "event: response.function_call_arguments.delta",
            'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\\"name\\":\\"hermes-agent\\"}"}',
            "",
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"skill_view","arguments":"{\\"name\\":\\"hermes-agent\\"}"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"status":"completed"}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    });

    const body = {
      model: "codex/gpt-5.3-codex",
      messages: [{ role: "user", content: "use skill" }],
      stream: true,
      tools: [{
        type: "function",
        function: {
          name: "skill_view",
          parameters: { type: "object" },
        },
      }],
    };
    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      route: "/v1/chat/completions",
      sessionKey: "session-a",
      body,
      model: "codex/gpt-5.3-codex",
    });

    const chunks = parseSseData(await response.text()).filter((frame) => frame !== "[DONE]").map((frame) => JSON.parse(frame));
    expect(chunks.some((chunk) => chunk.choices[0].delta.content)).toBe(false);
    const toolChunks = chunks.filter((chunk) => chunk.choices[0].delta.tool_calls);
    expect(toolChunks.at(0)).toMatchObject({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "skill_view" },
          }],
        },
        finish_reason: null,
      }],
    });
    expect(toolChunks.map((chunk) => chunk.choices[0].delta.tool_calls[0].function.arguments ?? "").join(""))
      .toBe("{\"name\":\"hermes-agent\"}");
    expect(chunks.at(-1)).toMatchObject({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    });
  });

  it("returns non-stream chat tool calls from Codex Responses output", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });
    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async () =>
        new Response(
          [
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_tool","status":"completed","output":[{"id":"fc_1","type":"function_call","call_id":"call_1","name":"skill_view","arguments":"{\\"name\\":\\"hermes-agent\\"}"}]}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    });

    const body = {
      model: "codex/gpt-5.3-codex",
      messages: [{ role: "user", content: "use skill" }],
      tools: [{
        type: "function",
        function: {
          name: "skill_view",
          parameters: { type: "object" },
        },
      }],
    };
    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      route: "/v1/chat/completions",
      sessionKey: "session-a",
      body,
      model: "codex/gpt-5.3-codex",
    });

    expect(await response.json()).toMatchObject({
      choices: [{
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "skill_view",
              arguments: "{\"name\":\"hermes-agent\"}",
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
    });
  });

  it("handles chat stream_options like codex-lb", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });
    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(
          [
            "event: response.output_text.delta",
            'data: {"type":"response.output_text.delta","delta":"hello"}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}',
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });

    const body = {
      model: "codex/gpt-5.3-codex",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true, include_obfuscation: true },
    };
    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      route: "/v1/chat/completions",
      sessionKey: "session-a",
      body,
      model: "codex/gpt-5.3-codex",
    });

    const chunks = parseSseData(await response.text()).filter((frame) => frame !== "[DONE]").map((frame) => JSON.parse(frame));
    expect(response.status).toBe(200);
    expect(upstreamBody.stream_options).toEqual({ include_obfuscation: true });
    expect(chunks.slice(0, -1).every((chunk) => chunk.usage === null)).toBe(true);
    expect(chunks.at(-1)).toMatchObject({
      object: "chat.completion.chunk",
      choices: [],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });
  });

  it("proxies native Codex WebSocket requests with Responses beta headers", async () => {
    let upstreamUrl = "";
    let upstreamHeaders: Record<string, string> = {};
    let upstreamSocket: FakeUpstreamWebSocket | undefined;
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
        accountId: "acct_test",
      },
    });

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      webSocketFactory: (url, _protocols, init) => {
        upstreamUrl = url;
        upstreamHeaders = init.headers;
        upstreamSocket = new FakeUpstreamWebSocket();
        queueMicrotask(() => upstreamSocket?.emit("open", {}));
        return upstreamSocket;
      },
    });
    const downstream = new FakeGatewayWebSocket([
      { type: "text", data: '{"type":"response.create"}' },
      { type: "close", code: 1000, reason: "done" },
    ]);

    await provider.handleWebSocket?.({
      request: new Request("http://127.0.0.1:2021/backend-api/codex/responses", {
        headers: {
          "sec-websocket-key": "client-key",
          "sec-websocket-version": "13",
          originator: "codex_vscode",
          "user-agent": "codex_vscode/0.0.0",
          "x-codex-turn-state": "turn-test",
        },
      }),
      route: "/backend-api/codex/responses",
      sessionKey: "session-a",
      websocket: downstream,
    });

    expect(upstreamUrl).toBe("wss://chatgpt.com/backend-api/codex/responses");
    expect(downstream.acceptedHeaders.get("x-codex-turn-state")).toBe("turn-test");
    expect(upstreamHeaders.authorization).toBe("Bearer access-test");
    expect(upstreamHeaders["chatgpt-account-id"]).toBe("acct_test");
    expect(upstreamHeaders.originator).toBe("codex_vscode");
    expect(upstreamHeaders["user-agent"]).toBe("codex_vscode/0.0.0");
    expect(upstreamHeaders["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect(upstreamHeaders["sec-websocket-key"]).toBeUndefined();
    expect(upstreamSocket?.sent).toEqual(['{"type":"response.create"}']);
    expect(upstreamSocket?.closed).toEqual({ code: 1000, reason: "done" });
  });

  it("fails over Codex WebSocket startup rate limits and replays the create message", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
        accountId: "acct_first",
      },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
        accountId: "acct_second",
      },
    });
    const upstreamSockets: FakeUpstreamWebSocket[] = [];
    const upstreamHeaders: Array<Record<string, string>> = [];

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      webSocketFactory: (_url, _protocols, init) => {
        const socket = new FakeUpstreamWebSocket();
        if (upstreamSockets.length === 0) {
          socket.onSend = () => {
            queueMicrotask(() => {
              socket.emit("message", {
                data: '{"type":"response.created","response":{"id":"resp_first","status":"in_progress"}}',
              });
              socket.emit("message", {
                data: '{"type":"error","status":429,"error":{"code":"usage_limit_reached","message":"Youve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at May 21st, 2026 12:55 PM."}}',
              });
            });
          };
        }
        upstreamSockets.push(socket);
        upstreamHeaders.push(init.headers);
        queueMicrotask(() => socket.emit("open", {}));
        return socket;
      },
    });
    const downstream = new FakeGatewayWebSocket(
      [{ type: "text", data: '{"type":"response.create"}' }],
      { waitWhenEmpty: true },
    );

    const websocketPromise = provider.handleWebSocket?.({
      request: new Request("http://127.0.0.1:2021/backend-api/codex/responses", {
        headers: {
          "sec-websocket-key": "client-key",
          "sec-websocket-version": "13",
          originator: "codex_vscode",
          "user-agent": "codex_vscode/0.0.0",
        },
      }),
      route: "/backend-api/codex/responses",
      sessionKey: "session-a",
      websocket: downstream,
    });

    await waitFor(() => upstreamSockets.length === 2 && upstreamSockets[1]!.sent.length === 1);
    const firstUpdated = await store.get(first.id);
    expect(upstreamHeaders.map((headers) => headers.authorization)).toEqual([
      "Bearer first-access",
      "Bearer second-access",
    ]);
    expect(upstreamSockets[0]?.sent).toEqual(['{"type":"response.create"}']);
    expect(upstreamSockets[1]?.sent).toEqual(['{"type":"response.create"}']);
    expect(downstream.sentText).toEqual([]);
    expect(firstUpdated?.lastFailureClass).toBe("rate_limit");
    expect(firstUpdated?.lastFailureCode).toBe("usage_limit_reached");
    expect(firstUpdated?.rateLimitResetAt).toBeUndefined();
    expect(firstUpdated?.rateLimitBlockedAt).toBeTruthy();

    downstream.pushMessage({ type: "close", code: 1000, reason: "done" });
    await websocketPromise;
    expect(upstreamSockets[1]?.closed).toEqual({ code: 1000, reason: "done" });
  });

  it("does not replay Codex WebSocket usage limits with previous_response_id to another account", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
        accountId: "acct_first",
      },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
        accountId: "acct_second",
      },
    });
    const upstreamSockets: FakeUpstreamWebSocket[] = [];

    const provider = createCodexChatGPTProvider({
      accounts: new StickyAccountPool(store),
      webSocketFactory: () => {
        const socket = new FakeUpstreamWebSocket();
        socket.onSend = () => {
          queueMicrotask(() => {
            socket.emit("message", {
              data: '{"type":"error","status":429,"error":{"code":"usage_limit_reached","message":"The usage limit has been reached"}}',
            });
          });
        };
        upstreamSockets.push(socket);
        queueMicrotask(() => socket.emit("open", {}));
        return socket;
      },
    });
    const downstream = new FakeGatewayWebSocket(
      [{ type: "text", data: '{"type":"response.create","previous_response_id":"resp_anchor"}' }],
      { waitWhenEmpty: true },
    );

    const websocketPromise = provider.handleWebSocket?.({
      request: new Request("http://127.0.0.1:2021/backend-api/codex/responses", {
        headers: {
          "sec-websocket-key": "client-key",
          "sec-websocket-version": "13",
          originator: "codex_vscode",
          "user-agent": "codex_vscode/0.0.0",
        },
      }),
      route: "/backend-api/codex/responses",
      sessionKey: "session-a",
      websocket: downstream,
    });

    await waitFor(() => downstream.sentText.length === 1);
    const firstUpdated = await store.get(first.id);
    expect(upstreamSockets).toHaveLength(1);
    expect(JSON.parse(downstream.sentText[0] ?? "{}")).toMatchObject({
      type: "error",
      error: { code: "usage_limit_reached" },
    });
    expect(firstUpdated?.lastFailureClass).toBe("rate_limit");

    downstream.pushMessage({ type: "close", code: 1000, reason: "done" });
    await websocketPromise;
  });
});

function parseSseData(value: string): string[] {
  return value
    .split(/\n\n/)
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => frame.replace(/^data:\s*/, ""));
}

function chunkedTextStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk.endsWith("\n\n") ? chunk : `${chunk}\n`));
      }
      controller.close();
    },
  });
}

class FakeGatewayWebSocket {
  acceptedHeaders = new Headers();
  sentText: string[] = [];
  sentBinary: Uint8Array[] = [];
  closed: { code?: number; reason?: string } | undefined;
  private readonly waiters: Array<(message: GatewayWebSocketMessage) => void> = [];

  constructor(
    private readonly messages: GatewayWebSocketMessage[],
    private readonly options: { waitWhenEmpty?: boolean } = {},
  ) {}

  async accept(headers?: HeadersInit): Promise<void> {
    this.acceptedHeaders = new Headers(headers);
  }

  async receive(): Promise<GatewayWebSocketMessage> {
    const message = this.messages.shift();
    if (message) return message;
    if (!this.options.waitWhenEmpty) return { type: "close" };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async sendText(data: string): Promise<void> {
    this.sentText.push(data);
  }

  async sendBinary(data: Uint8Array): Promise<void> {
    this.sentBinary.push(data);
  }

  async close(code?: number, reason?: string): Promise<void> {
    this.closed = { code, reason };
  }

  pushMessage(message: GatewayWebSocketMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    this.messages.push(message);
  }
}

class FakeUpstreamWebSocket {
  readyState = 0;
  binaryType = "";
  sent: Array<string | Uint8Array | ArrayBuffer | Buffer> = [];
  closed: { code?: number; reason?: string } | undefined;
  onSend: ((data: string | Uint8Array | ArrayBuffer | Buffer) => void) | undefined;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  send(data: string | Uint8Array | ArrayBuffer | Buffer): void {
    this.sent.push(data);
    this.onSend?.(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: "open" | "message" | "error" | "close", event: unknown): void {
    if (type === "open") this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
