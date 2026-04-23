import { describe, expect, test } from "bun:test";
import {
  buildRequestHeaders,
  createResponseStreamTransform,
  extractModelIdFromBody,
  extractToolNamesFromRequestBody,
  transformRequestBody,
  transformRequestUrl,
} from "../../src/request/transform";
import { getUserAgent } from "../../src/model/config";
import { resetExcludedBetas } from "../../src/request/betas";
import { loadTemplate } from "../../src/claude-code/fingerprint/capture";
import { getStaticHeaders } from "../../src/request/headers";
import { createRealisticRequestPayload } from "../fixtures/realistic-request-payload";
import { setupTestEnv } from "../helpers";

function splitBetas(value: string | null): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

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
  const transformed = createResponseStreamTransform(response, new Map([["search_docs", "tool_masked"]]));
  return new Response(transformed.body).text();
}

describe("buildRequestHeaders", () => {
  test("adds model-specific betas for Claude 4.6 models", () => {
    const headers = new Headers(buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token-123",
      "claude-sonnet-4-6",
    ));

    const betas = splitBetas(headers.get("anthropic-beta"));

    expect(betas).toContain("oauth-2025-04-20");
    expect(betas).toContain("interleaved-thinking-2025-05-14");
    expect(betas).toContain("effort-2025-11-24");
  });

  test("sets auth, merged beta, user-agent, removes x-api-key, and preserves init headers", () => {
    const headers = new Headers(buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      {
        headers: {
          "anthropic-beta": "custom-beta, interleaved-thinking-2025-05-14",
          "x-api-key": "secret-key",
          "x-custom-header": "custom-value",
        },
      },
      "token-123",
    ));

    expect(headers.get("authorization")).toBe("Bearer token-123");
    const betas = splitBetas(headers.get("anthropic-beta"));

    expect(betas).toContain("oauth-2025-04-20");
    expect(betas).toContain("interleaved-thinking-2025-05-14");
    expect(betas).toContain("custom-beta");
    expect(headers.get("user-agent")).toBe(getStaticHeaders()["user-agent"] ?? getUserAgent());
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

    const headers = new Headers(buildRequestHeaders(
      input,
      { headers: { "x-init-header": "init-value" } },
      "token-456",
    ));

    const betas = splitBetas(headers.get("anthropic-beta"));

    expect(betas).toContain("oauth-2025-04-20");
    expect(betas).toContain("interleaved-thinking-2025-05-14");
    expect(betas).toContain("request-beta");
    expect(headers.get("x-request-header")).toBe("request-value");
    expect(headers.get("x-init-header")).toBe("init-value");
    expect(headers.get("x-api-key")).toBe(null);
  });

  test("can enable 1m beta through environment variable", () => {
    process.env.ANTHROPIC_ENABLE_1M_CONTEXT = "true";
    try {
      const headers = new Headers(buildRequestHeaders(
        "https://api.anthropic.com/v1/messages",
        { headers: {} },
        "token-123",
        "claude-sonnet-4-6",
      ));

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

describe("extractToolNamesFromRequestBody", () => {
  test("returns tool names from a valid request body", () => {
    expect(extractToolNamesFromRequestBody(JSON.stringify({
      tools: [{ name: "search_docs" }, { name: "run_command" }, {}],
    }))).toEqual(["search_docs", "run_command"]);
  });

  test("returns an empty array for invalid payloads", () => {
    expect(extractToolNamesFromRequestBody(undefined)).toEqual([]);
    expect(extractToolNamesFromRequestBody("not-json")).toEqual([]);
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

  test("builds the upstream Claude Code request shape", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const template = loadTemplate();
      const body = JSON.stringify(createRealisticRequestPayload());
      const transformed = transformRequestBody(body);

      expect(transformed).toBeDefined();

      const parsed = JSON.parse(transformed as string) as {
        system: Array<{ text?: string }>;
        tools: Array<{ name?: string }>;
        metadata?: { user_id?: string };
        thinking?: Record<string, unknown>;
        context_management?: Record<string, unknown>;
        output_config?: Record<string, unknown>;
      };

      expect(parsed.system).toHaveLength(3);
      expect(parsed.system[0]?.text).toContain("x-anthropic-billing-header:");
      expect(parsed.system[1]?.text).toBe(template.agent_identity);
      const stableSystemPromptLead = template.system_prompt.split("\n\n", 1)[0];
      expect(parsed.system[2]?.text).toContain(stableSystemPromptLead);
      expect(parsed.system[2]?.text).not.toContain("x-anthropic-billing-header: cc_version=1.2.3");
      expect(parsed.tools).toHaveLength(2);
      expect(parsed.tools[0]?.name).toMatch(/^tool_[a-f0-9]+$/);
      expect(parsed.tools[1]?.name).toMatch(/^tool_[a-f0-9]+$/);
      expect(parsed.tools[0]?.name).not.toBe(parsed.tools[1]?.name);
      expect(typeof parsed.metadata?.user_id).toBe("string");
      expect("thinking" in parsed).toBe(false);
      expect("context_management" in parsed).toBe(false);
      expect("output_config" in parsed).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("transformed body tools retain input_schema required by Anthropic API", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const body = JSON.stringify({
        system: "test prompt",
        tools: [
          { name: "my_tool", description: "A tool", input_schema: { type: "object", properties: { q: { type: "string" } } } },
        ],
        messages: [{ role: "user", content: "hello" }],
      });

      const transformed = transformRequestBody(body);
      expect(transformed).toBeDefined();

      const parsed = JSON.parse(transformed as string) as { tools: Array<{ name?: string; input_schema?: unknown }> };

      expect(parsed.tools.length).toBeGreaterThan(0);
      for (const tool of parsed.tools) {
        expect(tool).toHaveProperty("input_schema");
        expect(typeof tool.input_schema).toBe("object");
        expect(tool.input_schema).not.toBeNull();
      }
    } finally {
      await cleanup();
    }
  });

  test("masks non-Claude-Code tools consistently, including current OpenCode built-ins", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const body = JSON.stringify({
        tools: [
          { name: "question", input_schema: { type: "object", properties: { questions: { type: "array" } } } },
          { name: "search_docs", input_schema: { type: "object" } },
        ],
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "tool_use", name: "search_docs" }] },
        ],
      });

      const transformed = transformRequestBody(body);
      const parsed = JSON.parse(transformed as string) as {
        tools: Array<{ name?: string }>;
        messages: Array<{ content?: Array<{ name?: string }> }>;
      };
      expect(parsed.tools[0]?.name).toMatch(/^tool_[a-f0-9]+$/);
      expect(parsed.tools[1]?.name).toMatch(/^tool_[a-f0-9]+$/);
      expect(parsed.tools[0]?.name).not.toBe(parsed.tools[1]?.name);
      expect(parsed.messages[1]?.content?.[0]?.name).toBe(parsed.tools[1]?.name);
    } finally {
      await cleanup();
    }
  });

  test("masks the same tool name identically across different first user prompts", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const bodyA = JSON.stringify({
        tools: [{ name: "search_docs", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "first prompt" }],
      });
      const bodyB = JSON.stringify({
        tools: [{ name: "search_docs", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "second prompt" }],
      });

      const parsedA = JSON.parse(transformRequestBody(bodyA) as string) as { tools: Array<{ name?: string }> };
      const parsedB = JSON.parse(transformRequestBody(bodyB) as string) as { tools: Array<{ name?: string }> };

      expect(parsedA.tools[0]?.name).toBe(parsedB.tools[0]?.name);
    } finally {
      await cleanup();
    }
  });
});

describe("transformRequestUrl", () => {
  test("adds beta=true to Anthropic messages endpoint", () => {
    const transformed = transformRequestUrl("https://api.anthropic.com/v1/messages");
    expect(String(transformed)).toBe("https://api.anthropic.com/v1/messages?beta=true");
  });

  test("preserves unrelated urls", () => {
    const original = "https://api.anthropic.com/v1/complete";
    expect(transformRequestUrl(original)).toBe(original);
  });
});

describe("createResponseStreamTransform", () => {
  test("reverse maps tool_use names in SSE payloads", async () => {
    const response = new Response(createChunkedStream([
      'event: content_block_delta\n',
      'data: {"delta":{"type":"tool_use","name":"tool_masked"}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ]));

    const transformedText = await readTransformedText(response);

    expect(transformedText).toContain('"name":"search_docs"');
    expect(transformedText).not.toContain('"name":"tool_masked"');
  });
});
