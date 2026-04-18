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
  resetUpstreamRequestForTest,
  reverseMapResponse,
  sanitizeMessages,
  scrubFrameworkIdentifiers,
  setUpstreamRequestTestOverridesForTest,
} from "../src/upstream-request";

afterEach(() => {
  resetUpstreamRequestForTest();
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

  test("buildUpstreamRequest emits Claude Code style body and truncates oversized tool_result blocks", () => {
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
    expect(result.thinking).toEqual({ type: "adaptive" });
    expect(result.context_management).toEqual({});
    expect(result.output_config).toEqual({});
    expect(result.tools).toEqual(template.tools);
    expect(messages).toHaveLength(3);
    expect(messages[1]?.content).toEqual([{ type: "text", text: "Working on it" }]);
    expect(truncated.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_LENGTH + TRUNCATION_SUFFIX.length);
    expect(truncated.endsWith(TRUNCATION_SUFFIX)).toBe(true);
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

  test("reverseMapResponse preserves current OpenCode tool names under identity mapping", () => {
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

  test("createStreamingReverseMapper rewrites SSE payloads via the same reverse mapping path", async () => {
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

  test("buildUpstreamRequest uses template tools when they have complete input_schema", () => {
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
      { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], tools: [{ name: "old_tool" }] },
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
