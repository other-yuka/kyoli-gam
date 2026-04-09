import { describe, expect, test } from "bun:test";
import {
  extractModelIdFromBody,
  buildRequestHeaders,
  createResponseStreamTransform,
  getInjectedSystemPrompt,
  getSystemPrompt,
  transformRequestBody,
  transformRequestUrl,
} from "../src/request-transform";
import {
  CLAUDE_CLI_USER_AGENT,
  TOOL_PREFIX,
} from "../src/constants";
import { resetExcludedBetas } from "../src/betas";
import { createRealisticRequestPayload } from "./fixtures/realistic-request-payload";

const DEFAULT_BETAS = "oauth-2025-04-20,interleaved-thinking-2025-05-14";

function createChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function readTransformedText(response: Response): Promise<string> {
  const transformed = createResponseStreamTransform(response);
  return new Response(transformed.body).text();
}

describe("getSystemPrompt", () => {
  test("returns a non-empty string", () => {
    const prompt = getSystemPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("starts with expected Claude Code CLI preamble", () => {
    const prompt = getSystemPrompt();
    expect(prompt.startsWith("You are an interactive CLI tool")).toBe(true);
  });

  test("returns the same value on repeated calls", () => {
    expect(getSystemPrompt()).toBe(getSystemPrompt());
  });

  test("exposes a slimmer injected identity prompt", () => {
    const prompt = getInjectedSystemPrompt();
    expect(prompt).toContain("Claude Code");
    expect(prompt.length).toBeLessThan(getSystemPrompt().length);
  });
});

describe("buildRequestHeaders", () => {
  test("adds model-specific betas for Claude 4.6 models", () => {
    const headers = buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token-123",
      "claude-sonnet-4-6",
    );

    expect(headers.get("anthropic-beta")).toBe(
      `${DEFAULT_BETAS},effort-2025-11-24`,
    );
  });

  test("sets auth, merged beta, user-agent, removes x-api-key, and preserves init headers", () => {
    const headers = buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      {
        headers: {
          "anthropic-beta": "custom-beta, interleaved-thinking-2025-05-14",
          "x-api-key": "secret-key",
          "x-custom-header": "custom-value",
        },
      },
      "token-123",
    );

    expect(headers.get("authorization")).toBe("Bearer token-123");
    expect(headers.get("anthropic-beta")).toBe(
      `${DEFAULT_BETAS},custom-beta`,
    );
    expect(headers.get("user-agent")).toBe(CLAUDE_CLI_USER_AGENT);
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(headers.get("x-app")).toBe("cli");
    expect(headers.get("x-api-key")).toBe(null);
    expect(headers.get("x-custom-header")).toBe("custom-value");
  });

  test("handles Request input headers", () => {
    const input = new Request("https://api.anthropic.com/v1/messages", {
      headers: {
        "anthropic-beta": "request-beta",
        "x-request-header": "request-value",
        "x-api-key": "request-secret",
      },
    });

    const headers = buildRequestHeaders(
      input,
      { headers: { "x-init-header": "init-value" } },
      "token-456",
    );

    expect(headers.get("anthropic-beta")).toBe(
      `${DEFAULT_BETAS},request-beta`,
    );
    expect(headers.get("x-request-header")).toBe("request-value");
    expect(headers.get("x-init-header")).toBe("init-value");
    expect(headers.get("x-api-key")).toBe(null);
  });

  test("can enable 1m beta through environment variable", () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true";
    try {
      const headers = buildRequestHeaders(
        "https://api.anthropic.com/v1/messages",
        { headers: {} },
        "token-123",
        "claude-sonnet-4-6",
      );

      expect(headers.get("anthropic-beta")).toContain("context-1m-2025-08-07");
    } finally {
      delete process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
      resetExcludedBetas();
    }
  });
});

describe("extractModelIdFromBody", () => {
  test("returns model id when present in JSON body", () => {
    expect(extractModelIdFromBody(JSON.stringify({ model: "claude-sonnet-4-6" }))).toBe("claude-sonnet-4-6");
  });

  test("returns unknown for invalid JSON or missing model", () => {
    expect(extractModelIdFromBody("not-json")).toBe("unknown");
    expect(extractModelIdFromBody(JSON.stringify({ messages: [] }))).toBe("unknown");
  });
});

describe("transformRequestBody", () => {
  test("returns undefined for undefined input", () => {
    expect(transformRequestBody(undefined)).toBeUndefined();
  });

  test("returns original body for non-JSON input", () => {
    const body = "not-json-payload";
    expect(transformRequestBody(body)).toBe(body);
  });

  test("replaces OpenCode/opencode in system text and preserves /opencode paths", () => {
    const body = JSON.stringify({
      system: [
        {
          type: "text",
          text: "OpenCode, opencode, OPENCODE, and /opencode should be preserved.",
        },
      ],
    });

    const transformed = transformRequestBody(body);
    expect(transformed).toBeDefined();

    const parsed = JSON.parse(transformed as string) as {
      system: Array<{ type: string; text: string }>;
    };

    expect(parsed.system[0].text.includes("Claude Code")).toBe(true);
    expect(parsed.system[0].text.includes("Claude, Claude")).toBe(true);
    expect(parsed.system[0].text.includes("/opencode")).toBe(true);
    expect(parsed.system[0].text.includes("OpenCode")).toBe(false);
  });

  test("relocates non-core system text into the first user message", () => {
    const body = JSON.stringify({
      system: [
        { type: "text", text: getSystemPrompt() },
        { type: "text", text: "OpenCode should explain the workspace before acting." },
      ],
      messages: [
        { role: "user", content: "Fix the bug" },
      ],
    });

    const transformed = transformRequestBody(body);
    expect(transformed).toBeDefined();

    const parsed = JSON.parse(transformed as string) as {
      system: Array<{ type: string; text: string }>;
      messages: Array<{ role?: string; content?: string }>;
    };

    expect(parsed.system).toHaveLength(1);
    expect(parsed.system[0]?.text).toBe(getSystemPrompt());
    expect(parsed.messages[0]?.content).toContain("Claude Code should explain the workspace before acting.");
    expect(parsed.messages[0]?.content).toContain("Fix the bug");
  });

  test("removes paragraphs matched by sanitization anchors before relocation", () => {
    const body = JSON.stringify({
      system: [
        {
          type: "text",
          text: [
            "Keep this instruction.",
            "See https://opencode.ai/docs for more details.",
            "OpenCode must remain concise.",
          ].join("\n\n"),
        },
      ],
      messages: [
        { role: "user", content: "Do the task" },
      ],
    });

    const transformed = transformRequestBody(body);
    expect(transformed).toBeDefined();

    const parsed = JSON.parse(transformed as string) as {
      system: Array<{ type: string; text: string }>;
      messages: Array<{ content?: string }>;
    };

    expect(parsed.system).toEqual([]);
    expect(parsed.messages[0]?.content).toContain("Keep this instruction.");
    expect(parsed.messages[0]?.content).toContain("Claude Code must remain concise.");
    expect(parsed.messages[0]?.content).not.toContain("opencode.ai/docs");
  });

  test("preserves sanitized system text when no user message exists", () => {
    const body = JSON.stringify({
      system: [
        { type: "text", text: "OpenCode should summarize findings." },
      ],
      messages: [
        { role: "assistant", content: "Hello" },
      ],
    });

    const transformed = transformRequestBody(body);
    expect(transformed).toBeDefined();

    const parsed = JSON.parse(transformed as string) as {
      system: Array<{ type: string; text: string }>;
      messages: Array<{ role?: string; content?: string }>;
    };

    expect(parsed.system).toHaveLength(1);
    expect(parsed.system[0]?.text).toBe("Claude Code should summarize findings.");
    expect(parsed.messages[0]?.content).toBe("Hello");
  });

  test("handles a realistic payload with prompt relocation and tool prefixing", () => {
    const body = JSON.stringify(createRealisticRequestPayload());

    const transformed = transformRequestBody(body);
    expect(transformed).toBeDefined();

    const parsed = JSON.parse(transformed as string) as {
      system: Array<{ type: string; text: string }>;
      tools: Array<{ name?: string }>;
      messages: Array<{
        role?: string;
        content?: string | Array<{ type: string; name?: string; text?: string }>;
      }>;
    };

    expect(parsed.system).toHaveLength(2);
    expect(parsed.system[0]?.text).toBe(getSystemPrompt());
    expect(parsed.system[1]?.text.startsWith("x-anthropic-billing-header:")).toBe(true);
    expect(parsed.messages[0]?.role).toBe("user");
    expect(typeof parsed.messages[0]?.content).toBe("string");
    expect(parsed.messages[0]?.content).toContain("Claude Code should inspect the repository before proposing changes.");
    expect(parsed.messages[0]?.content).toContain("Keep answers concise and actionable.");
    expect(parsed.messages[0]?.content).not.toContain("opencode.ai/docs");
    expect(parsed.messages[0]?.content).toContain("Please debug the failing request.");
    expect(parsed.tools[0]?.name).toBe(`${TOOL_PREFIX}search_docs`);
    expect(parsed.tools[1]?.name).toBe(`${TOOL_PREFIX}run_command`);
    expect(Array.isArray(parsed.messages[1]?.content)).toBe(true);
    if (Array.isArray(parsed.messages[1]?.content)) {
      expect(parsed.messages[1].content[0]?.name).toBe(`${TOOL_PREFIX}search_docs`);
    }
  });

  test("is stable when transformed twice", () => {
    const body = JSON.stringify(createRealisticRequestPayload());

    const firstPass = transformRequestBody(body);
    const secondPass = transformRequestBody(firstPass);

    expect(secondPass).toBe(firstPass);
  });

  test("adds mcp_ prefix to tool names", () => {
    const body = JSON.stringify({
      tools: [{ name: "search_docs" }, { name: "run_command" }],
    });

    const transformed = transformRequestBody(body);
    expect(transformed).toBeDefined();

    const parsed = JSON.parse(transformed as string) as {
      tools: Array<{ name?: string }>;
    };

    expect(parsed.tools[0].name).toBe(`${TOOL_PREFIX}search_docs`);
    expect(parsed.tools[1].name).toBe(`${TOOL_PREFIX}run_command`);
  });

  test("adds mcp_ prefix to tool_use content block names", () => {
    const body = JSON.stringify({
      messages: [
        {
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", name: "lookup" },
          ],
        },
      ],
    });

    const transformed = transformRequestBody(body);
    expect(transformed).toBeDefined();

    const parsed = JSON.parse(transformed as string) as {
      messages: Array<{ content?: Array<{ type: string; name?: string }> }>;
    };

    expect(parsed.messages[0].content?.[1].name).toBe(`${TOOL_PREFIX}lookup`);
  });

  test("does not double-prefix names that already start with mcp_", () => {
    const body = JSON.stringify({
      tools: [{ name: "mcp_already_tool" }],
      messages: [
        {
          content: [{ type: "tool_use", name: "mcp_already_block" }],
        },
      ],
    });

    const transformed = transformRequestBody(body);
    expect(transformed).toBeDefined();

    const parsed = JSON.parse(transformed as string) as {
      tools: Array<{ name?: string }>;
      messages: Array<{ content?: Array<{ type: string; name?: string }> }>;
    };

    expect(parsed.tools[0].name).toBe("mcp_already_tool");
    expect(parsed.messages[0].content?.[0].name).toBe("mcp_already_block");
    expect(parsed.tools[0].name?.startsWith("mcp_mcp_")).toBe(false);
    expect(parsed.messages[0].content?.[0].name?.startsWith("mcp_mcp_")).toBe(false);
  });

  test("handles empty tools array", () => {
    const body = JSON.stringify({ tools: [] });
    const transformed = transformRequestBody(body);
    expect(transformed).toBeDefined();

    const parsed = JSON.parse(transformed as string) as { tools: unknown[] };
    expect(parsed.tools).toEqual([]);
  });

  test("handles messages without content", () => {
    const body = JSON.stringify({
      messages: [{ role: "user" }, { content: [] }],
    });

    const transformed = transformRequestBody(body);
    expect(transformed).toBeDefined();

    const parsed = JSON.parse(transformed as string) as {
      messages: Array<{ role?: string; content?: unknown[] }>;
    };

    expect(parsed.messages.length).toBe(2);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[0].content).toBeUndefined();
    expect(parsed.messages[1].content).toEqual([]);
  });
});

describe("transformRequestUrl", () => {
  test("adds beta=true to /v1/messages URL", () => {
    const input = new URL("https://api.anthropic.com/v1/messages");
    const result = transformRequestUrl(input);

    expect(result instanceof URL).toBe(true);
    if (result instanceof URL) {
      expect(result.searchParams.get("beta")).toBe("true");
      expect(result.pathname).toBe("/v1/messages");
    }
  });

  test("does not add beta when already present", () => {
    const input = new URL("https://api.anthropic.com/v1/messages?beta=false&x=1");
    const result = transformRequestUrl(input);

    expect(result).toBe(input);
    expect(input.searchParams.get("beta")).toBe("false");
  });

  test("returns unchanged for non-messages URLs", () => {
    const input = "https://api.anthropic.com/v1/complete";
    const result = transformRequestUrl(input);
    expect(result).toBe(input);
  });

  test("handles Request object input", () => {
    const input = new Request("https://api.anthropic.com/v1/messages", {
      headers: { "x-trace-id": "trace-123" },
    });
    const result = transformRequestUrl(input);

    expect(result instanceof Request).toBe(true);
    if (result instanceof Request) {
      expect(result.url.includes("/v1/messages")).toBe(true);
      expect(result.url.includes("beta=true")).toBe(true);
      expect(result.headers.get("x-trace-id")).toBe("trace-123");
    }
  });
});

describe("createResponseStreamTransform", () => {
  test("returns original response when no body", () => {
    const response = new Response(null, { status: 204 });
    const transformed = createResponseStreamTransform(response);
    expect(transformed).toBe(response);
  });

  test("strips mcp_ prefix from tool names in complete lines", async () => {
    const chunks = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_my_tool"}}\n\n',
    ];
    const response = new Response(createChunkedStream(chunks));
    const text = await readTransformedText(response);

    expect(/"name"\s*:\s*"my_tool"/.test(text)).toBe(true);
    expect(text.includes('"name":"mcp_my_tool"')).toBe(false);
  });

  test("strips mcp_ prefix across chunk boundaries", async () => {
    const chunks = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","na',
      'me":"mcp_my_tool"}}\n\n',
    ];
    const response = new Response(createChunkedStream(chunks));
    const text = await readTransformedText(response);

    expect(/"name"\s*:\s*"my_tool"/.test(text)).toBe(true);
    expect(text.includes('"name":"mcp_my_tool"')).toBe(false);
  });

  test("flushes remaining buffer on stream end", async () => {
    const chunks = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_tail_tool"}}',
    ];
    const response = new Response(createChunkedStream(chunks));
    const text = await readTransformedText(response);

    expect(/"name"\s*:\s*"tail_tool"/.test(text)).toBe(true);
    expect(text.includes('"name":"mcp_tail_tool"')).toBe(false);
  });

  test("handles empty chunks", async () => {
    const chunks = ["", 'data: {"name":"mcp_empty_test"}\n', ""];
    const response = new Response(createChunkedStream(chunks));
    const text = await readTransformedText(response);

    expect(/"name"\s*:\s*"empty_test"/.test(text)).toBe(true);
  });

  test("passes through non-tool-name data unchanged", async () => {
    const input = 'event: ping\ndata: {"status":"ok","value":"mcp_keep"}\n\n';
    const response = new Response(createChunkedStream([input]));
    const text = await readTransformedText(response);

    expect(text.includes("event: ping")).toBe(true);
    expect(text.includes('"value":"mcp_keep"')).toBe(true);
    expect(text.includes('"status":"ok"')).toBe(true);
  });

  test("propagates reader error through controller.error", async () => {
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"name":"mcp_tool"}\n'));
      },
      pull() {
        throw new Error("simulated read failure");
      },
    });

    const response = new Response(errorStream, { status: 200 });
    const transformed = createResponseStreamTransform(response);
    const reader = transformed.body!.getReader();

    await reader.read();

    await expect(reader.read()).rejects.toThrow("simulated read failure");
  });
});
