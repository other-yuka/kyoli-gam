import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ClaudeIdentity } from "../src/claude-identity";
import type { TemplateData } from "../src/fingerprint-capture";
import {
  BILLING_SEED,
  MAX_TOOL_RESULT_TEXT_LENGTH,
  TRUNCATION_SUFFIX,
  buildUpstreamRequest,
  computeBuildTag,
  createStreamingReverseMapper,
  orderBodyForOutbound,
  resolveMaxTokens,
  resetUpstreamRequestForTest,
  reverseMapResponse,
  sanitizeMessages,
  scrubFrameworkIdentifiers,
  setUpstreamRequestTestOverridesForTest,
} from "../src/upstream-request";
import {
  ingestProviderModelsCapabilities,
  resetRuntimeModelCapabilitiesForTest,
} from "../src/model-capabilities";

afterEach(() => {
  resetUpstreamRequestForTest();
  resetRuntimeModelCapabilitiesForTest();
});

function createTemplate(overrides?: Partial<TemplateData>): TemplateData {
  return {
    _version: 1,
    _captured: "2026-04-17T12:00:00.000Z",
    _source: "bundled",
    agent_identity: "You are Claude Code, an interactive CLI tool.",
    system_prompt: "Inspect the repository before making assumptions.",
    tools: [
      { name: "Bash", description: "Run shell commands", input_schema: { type: "object" } },
      { name: "Read", description: "Read files", input_schema: { type: "object" } },
    ],
    tool_names: ["Bash", "Read"],
    cc_version: "2.1.80",
    anthropic_beta: "oauth-2025-04-20",
    ...overrides,
  };
}

function createIdentity(overrides?: Partial<ClaudeIdentity>): ClaudeIdentity {
  return {
    deviceId: "device-123",
    accountUuid: "account-456",
    ...overrides,
  };
}

describe("upstream-request", () => {
  test("sanitizeMessages strips orchestration tags in place while preserving surrounding text", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "hello\n<system-reminder>remove me</system-reminder>\nworld",
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "before <env>hidden</env> after",
            },
          ],
        },
      ],
    } satisfies Record<string, unknown>;

    sanitizeMessages(body);

    expect(body.messages[0]?.content).toBe("hello\n\nworld");
    const assistantContent = body.messages[1]?.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    const assistantBlocks = assistantContent as Array<{ text?: string }>;
    expect(assistantBlocks[0]?.text).toBe("before  after");
  });

  test("scrubFrameworkIdentifiers removes prose mentions while preserving path-like occurrences", () => {
    const input = "/Users/foo/.opencode/file.ts mentions opencode and openai in prose";
    const output = scrubFrameworkIdentifiers(input);

    expect(output).toContain("/Users/foo/.opencode/file.ts");
    expect(output).not.toContain(" mentions opencode");
    expect(output).not.toContain("openai");
  });

  test("computeBuildTag matches the dario billing seed behavior", () => {
    const userMessage = "abcdEfgHiJKLMNOPQRSTUvwx";
    const version = "2.1.80";
    const expected = createHash("sha256")
      .update(`${BILLING_SEED}${userMessage[4]}${userMessage[7]}${userMessage[20]}${version}`)
      .digest("hex")
      .slice(0, 3);

    expect(computeBuildTag(userMessage, version)).toBe(expected);
    expect(computeBuildTag("tiny", version)).toHaveLength(3);
  });

  test("buildUpstreamRequest emits Claude Code style body and preserves incoming OpenCode tools", () => {
    setUpstreamRequestTestOverridesForTest({
      now: () => 1_000,
      createSessionId: () => "session-fixed",
    });

    const longToolResult = "x".repeat(50 * 1024);
    const inputBody = {
      model: "claude-sonnet-4-5",
      system: "Local opencode reminder\n<system-reminder>remove this</system-reminder>",
      tools: [{ name: "OriginalTool", description: "legacy" }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Use /Users/foo/.opencode/file.ts but do not mention opencode in prose",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "private chain of thought" },
            { type: "text", text: "Working on it", cache_control: { type: "ephemeral" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: longToolResult,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        {
          role: "assistant",
          content: "   ",
        },
      ],
    } satisfies Record<string, unknown>;

    const template = createTemplate();
    const result = buildUpstreamRequest(inputBody, createIdentity(), template);
    const systemBlocks = result.system as Array<{ text: string; cache_control?: { type: string } }>;
    const metadata = result.metadata as { user_id: string };
    const userId = JSON.parse(metadata.user_id) as Record<string, string>;
    const messages = result.messages as Array<{ role: string; content: unknown }>;
    const toolResultMessage = messages[2] as { content: Array<{ content: string }> };
    const truncated = toolResultMessage.content[0]?.content ?? "";

    expect(systemBlocks).toHaveLength(3);
    expect(systemBlocks[0]?.text).toContain("x-anthropic-billing-header:");
    expect(systemBlocks[0]?.text).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.80\.[a-f0-9]{3}; cc_entrypoint=cli; cch=00000;$/);
    expect(systemBlocks[1]).toMatchObject({
      text: template.agent_identity,
      cache_control: { type: "ephemeral" },
    });
    expect(systemBlocks[2]?.text).toContain(template.system_prompt);
    expect(systemBlocks[2]?.text).toContain("Local  reminder");
    expect(systemBlocks[2]?.text).not.toContain("Local opencode reminder");
    expect(userId).toEqual({
      device_id: "device-123",
      account_uuid: "account-456",
      session_id: "session-fixed",
    });
    expect(result.max_tokens).toBe(64_000);
    expect("thinking" in result).toBe(false);
    expect("context_management" in result).toBe(false);
    expect("output_config" in result).toBe(false);
    expect(result.tools).toEqual([{ name: "OriginalTool", description: "legacy" }]);
    expect(messages).toHaveLength(3);
    expect(messages[1]?.content).toEqual([{ type: "text", text: "Working on it" }]);
    expect(truncated.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_LENGTH + TRUNCATION_SUFFIX.length);
    expect(truncated.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  test("buildUpstreamRequest removes empty text blocks after sanitization", () => {
    const result = buildUpstreamRequest({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "   " },
            { type: "tool_use", name: "AskUserQuestion", input: { question: "x" } },
          ],
        },
      ],
    }, createIdentity(), createTemplate());

    const messages = result.messages as Array<{ role: string; content: Array<{ type?: string; text?: string; name?: string; input?: unknown }> | string }>;
    const assistantMessage = messages[1] as { content: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };

    expect(assistantMessage.content).toEqual([
      { type: "tool_use", name: "AskUserQuestion", input: { question: "x" } },
    ]);
  });

  test("buildUpstreamRequest preserves trailing tool_result even when sanitization empties its content", () => {
    const result = buildUpstreamRequest({
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
    }, createIdentity(), createTemplate());

    const messages = result.messages as Array<{ role: string; content: Array<Record<string, unknown>> | string }>;

    expect(messages).toHaveLength(3);
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: { question: "x" } },
    ]);
    expect(messages[2]?.role).toBe("user");
    expect(messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: "" },
    ]);
  });

  test("buildUpstreamRequest strips unsupported sampling fields when adaptive thinking is forced", () => {
    const result = buildUpstreamRequest({
      model: "claude-sonnet-4-6",
      temperature: 0.2,
      top_p: 0.7,
      top_k: 50,
      messages: [{ role: "user", content: "hello" }],
    }, createIdentity(), createTemplate());

    expect("temperature" in result).toBe(false);
    expect("top_p" in result).toBe(false);
    expect("top_k" in result).toBe(false);
    expect(result.thinking).toEqual({ type: "adaptive" });
  });

  test("buildUpstreamRequest drops incoming thinking controls and does not force adaptive on Haiku", () => {
    const result = buildUpstreamRequest({
      model: "claude-haiku-4-5",
      temperature: 0.2,
      thinking: { type: "enabled", budget_tokens: 4096, display: "summarized" },
      context_management: { stale: true },
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "hello" }],
    }, createIdentity(), createTemplate());

    expect("temperature" in result).toBe(false);
    expect("thinking" in result).toBe(false);
    expect("context_management" in result).toBe(false);
    expect("output_config" in result).toBe(false);
  });

  test("buildUpstreamRequest replaces incoming thinking controls on adaptive-capable models", () => {
    const result = buildUpstreamRequest({
      model: "claude-opus-4-7",
      thinking: { type: "enabled", budget_tokens: 4096, display: "summarized" },
      context_management: { stale: true },
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "hello" }],
    }, createIdentity(), createTemplate());

    expect(result.thinking).toEqual({ type: "adaptive" });
    expect(result.context_management).toEqual({});
    expect(result.output_config).toEqual({});
  });

test("resolveMaxTokens clamps to the fixed 64k cap", () => {
  expect(resolveMaxTokens(undefined)).toBe(64_000);
  expect(resolveMaxTokens(80_000)).toBe(64_000);
  expect(resolveMaxTokens(200_000)).toBe(64_000);
  expect(resolveMaxTokens(32_000)).toBe(32_000);
});

test("resolveMaxTokens ignores runtime provider max output metadata", () => {
  ingestProviderModelsCapabilities({
    "anthropic/claude-sonnet-4-6": {
      id: "anthropic/claude-sonnet-4-6",
        limit: { output: 12_345 },
        reasoning: false,
      },
  });

  expect(resolveMaxTokens(undefined)).toBe(64_000);
  expect(resolveMaxTokens(20_000)).toBe(20_000);
  expect(resolveMaxTokens(10_000)).toBe(10_000);
});

  test("buildUpstreamRequest prefers runtime thinking capability metadata when available", () => {
    ingestProviderModelsCapabilities({
      "anthropic/claude-sonnet-4-6": {
        id: "anthropic/claude-sonnet-4-6",
        limit: { output: 12_345 },
        reasoning: false,
      },
    });

    const result = buildUpstreamRequest({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    }, createIdentity(), createTemplate());

    expect("thinking" in result).toBe(false);
    expect(result.max_tokens).toBe(64_000);
  });

  test("buildUpstreamRequest filters already-injected upstream system entries before rebuilding blocks", () => {
    const template = createTemplate();
    const firstUserMessage = "hello reviewer";
    const billingHeader = `x-anthropic-billing-header: cc_version=${template.cc_version}.${computeBuildTag(firstUserMessage, template.cc_version!)}; cc_entrypoint=cli; cch=00000;`;

    const result = buildUpstreamRequest({
      model: "claude-sonnet-4-6",
      system: [
        billingHeader,
        template.agent_identity,
        template.system_prompt,
        "Local reminder",
      ],
      messages: [{ role: "user", content: firstUserMessage }],
    }, createIdentity(), template);

    const systemBlocks = result.system as Array<{ text: string }>;

    expect(systemBlocks[0]?.text).toBe(billingHeader);
    expect(systemBlocks[1]?.text).toBe(template.agent_identity);
    expect(systemBlocks[2]?.text).toBe(`${template.system_prompt}\n\nLocal reminder`);
    expect(systemBlocks[2]?.text.includes(billingHeader)).toBe(false);
    expect(systemBlocks[2]?.text.includes(template.agent_identity)).toBe(false);
  });

  test("reverseMapResponse preserves tool names without a request-scoped reverse lookup", () => {
    const response = {
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "pwd" },
        },
      ],
    };

    expect(reverseMapResponse(response)).toEqual(response);
  });

  test("createStreamingReverseMapper preserves names without a request-scoped reverse lookup", async () => {
    const sseBody = [
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"pwd"}}}',
      "",
    ].join("\n");
    const response = new Response(sseBody, {
      headers: { "content-type": "text/event-stream" },
    });

    const remapped = createStreamingReverseMapper(response);
    const text = await remapped.text();

    expect(text).toContain("event: content_block_start");
    expect(text).toContain('"name":"Bash"');
  });

  test("buildUpstreamRequest preserves incoming OpenCode tools when template aliases drift", () => {
    const template = createTemplate({
      tools: [
        { name: "AskUserQuestion", description: "Old Claude tool", input_schema: { type: "object" } },
        { name: "Bash", description: "Claude shell", input_schema: { type: "object" } },
      ],
      tool_names: ["AskUserQuestion", "Bash"],
    });

    const result = buildUpstreamRequest({
      model: "claude-sonnet-4-6",
      tools: [
        { name: "question", description: "OpenCode question tool", input_schema: { type: "object", properties: { questions: { type: "array" } } } },
        { name: "bash", description: "OpenCode bash tool", input_schema: { type: "object", properties: { command: { type: "string" } } } },
      ],
      messages: [{ role: "user", content: "hello" }],
    }, createIdentity(), template);

    expect(result.tools).toEqual([
      { name: "question", description: "OpenCode question tool", input_schema: { type: "object", properties: { questions: { type: "array" } } } },
      { name: "bash", description: "OpenCode bash tool", input_schema: { type: "object", properties: { command: { type: "string" } } } },
    ]);
  });

  test("buildUpstreamRequest keeps representative OpenCode tool groups when template names drift", () => {
    const template = createTemplate({
      tools: [
        { name: "AskUserQuestion", input_schema: { type: "object" } },
        { name: "Bash", input_schema: { type: "object" } },
        { name: "Read", input_schema: { type: "object" } },
        { name: "TaskCreate", input_schema: { type: "object" } },
      ],
      tool_names: ["AskUserQuestion", "Bash", "Read", "TaskCreate"],
    });

    const incomingTools = [
      { name: "question", input_schema: { type: "object", properties: { questions: { type: "array" } } } },
      { name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } },
      { name: "read", input_schema: { type: "object", properties: { filePath: { type: "string" } } } },
      { name: "task", input_schema: { type: "object", properties: { prompt: { type: "string" } } } },
      { name: "background_output", input_schema: { type: "object", properties: { task_id: { type: "string" } } } },
    ];

    const result = buildUpstreamRequest({
      model: "claude-sonnet-4-6",
      tools: incomingTools,
      messages: [{ role: "user", content: "hello" }],
    }, createIdentity(), template);

    expect(result.tools).toEqual(incomingTools);
  });

  test("buildUpstreamRequest preserves tool_use names for the later request-scoped flow", () => {
    const result = buildUpstreamRequest({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", name: "AskUserQuestion", input: { questions: [] } },
          ],
        },
      ],
      tools: [{ name: "question", input_schema: { type: "object" } }],
    }, createIdentity(), createTemplate());

    const messages = result.messages as Array<{ role: string; content: Array<{ type?: string; name?: string }> | string }>;
    const assistantMessage = messages.find((message) => message.role === "assistant") as { content: Array<{ type?: string; name?: string }> } | undefined;

    expect(Array.isArray(assistantMessage?.content)).toBe(true);
    expect(assistantMessage?.content[0]?.name).toBe("AskUserQuestion");
  });

  test("reverseMapResponse preserves stale AskUserQuestion without explicit reverse lookup", () => {
    const response = {
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "AskUserQuestion",
          input: { questions: [] },
        },
      ],
    };

    expect(reverseMapResponse(response)).toEqual(response);
  });

  test("orderBodyForOutbound reorders body fields per the provided order", () => {
    const body = { stream: true, model: "opus", messages: [] as unknown[] };
    const result = orderBodyForOutbound(body, ["model", "messages", "stream"]);

    expect(Object.keys(result)).toEqual(["model", "messages", "stream"]);
    expect(result.model).toBe("opus");
    expect(result.stream).toBe(true);
    expect(result.messages).toEqual([]);
  });

  test("orderBodyForOutbound appends unknown keys at the tail in original insertion order", () => {
    const body = { extra: 1, model: "opus" };
    const result = orderBodyForOutbound(body, ["model"]);

    expect(Object.keys(result)).toEqual(["model", "extra"]);
  });

  test("orderBodyForOutbound returns reference-equal body when no order is available", () => {
    const body = { a: 1, b: 2 };

    expect(orderBodyForOutbound(body)).toBe(body);
    expect(orderBodyForOutbound(body, [])).toBe(body);
    expect(orderBodyForOutbound(body, undefined)).toBe(body);
  });

  test("orderBodyForOutbound ignores duplicate ordered keys after first application", () => {
    const body = { stream: true, model: "opus", messages: [] as unknown[] };
    const result = orderBodyForOutbound(body, ["model", "model", "messages", "stream"]);

    expect(Object.keys(result)).toEqual(["model", "messages", "stream"]);
  });

  test("buildUpstreamRequest preserves incoming tools when template tools lack input_schema", () => {
    setUpstreamRequestTestOverridesForTest({
      now: () => 1_000,
      createSessionId: () => "session-schema-guard",
    });

    const incomingTools = [
      { name: "tool_abc", description: "Tool A", input_schema: { type: "object", properties: { x: { type: "string" } } } },
      { name: "tool_def", description: "Tool B", input_schema: { type: "object" } },
    ];

    const templateWithoutSchemas = createTemplate({
      tools: [{ name: "Bash" }, { name: "Read" }],
    });

    const result = buildUpstreamRequest(
      { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], tools: incomingTools },
      createIdentity(),
      templateWithoutSchemas,
    );

    const resultTools = result.tools as Array<{ name: string; input_schema?: unknown }>;
    expect(resultTools).toHaveLength(2);
    expect(resultTools[0]?.name).toBe("tool_abc");
    expect(resultTools[0]?.input_schema).toEqual({ type: "object", properties: { x: { type: "string" } } });
    expect(resultTools[1]?.name).toBe("tool_def");
    expect(resultTools[1]?.input_schema).toEqual({ type: "object" });
  });

  test("buildUpstreamRequest uses template tools as-is when incoming tools are absent", () => {
    setUpstreamRequestTestOverridesForTest({
      now: () => 1_000,
      createSessionId: () => "session-schema-complete",
    });

    const templateWithSchemas = createTemplate({
      tools: [
        { name: "Bash", input_schema: { type: "object" } },
        { name: "Read", input_schema: { type: "object" } },
      ],
    });

    const result = buildUpstreamRequest(
      {
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hi" }],
      },
      createIdentity(),
      templateWithSchemas,
    );

    const resultTools = result.tools as Array<{ name: string; input_schema?: unknown }>;
    expect(resultTools).toHaveLength(2);
    expect(resultTools[0]?.name).toBe("Bash");
    expect(resultTools[0]?.input_schema).toEqual({ type: "object" });
    expect(resultTools[1]?.name).toBe("Read");
    expect(resultTools[1]?.input_schema).toEqual({ type: "object" });
  });

  test("buildUpstreamRequest applies body_field_order from template at return boundary", () => {
    setUpstreamRequestTestOverridesForTest({
      now: () => 1_000,
      createSessionId: () => "session-order-test",
    });

    const template = createTemplate({
      body_field_order: [
        "model", "system", "messages", "tools", "metadata",
        "thinking", "context_management", "output_config", "max_tokens", "stream",
      ],
    });

    const inputBody = {
      model: "claude-sonnet-4-5",
      stream: true,
      system: "test system",
      messages: [{ role: "user", content: "hello" }],
    };

    const result = buildUpstreamRequest(inputBody, createIdentity(), template);
    const keys = Object.keys(result);

    expect(keys[0]).toBe("model");
    expect(keys[keys.length - 1]).toBe("stream");
  });
});
