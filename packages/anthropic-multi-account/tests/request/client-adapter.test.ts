import { describe, expect, test } from "vitest";
import {
  normalizeAnthropicClientRequest,
  sanitizeMessages,
  scrubFrameworkIdentifiers,
} from "../../src/request/client-adapter";

describe("client-adapter", () => {
  test("sanitizeMessages strips orchestration-only blocks", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>hidden</system-reminder>" },
            { type: "text", text: "<env>os=darwin</env>" },
            { type: "text", text: "hello" },
            { type: "tool_result", tool_use_id: "toolu_1", content: "" },
          ],
        },
      ],
    } satisfies Record<string, unknown>;

    sanitizeMessages(body);

    expect(body.messages[0]?.content).toEqual([
      { type: "text", text: "hello" },
      { type: "tool_result", tool_use_id: "toolu_1", content: "" },
    ]);
  });

  test("scrubFrameworkIdentifiers removes client names but preserves path-like occurrences", () => {
    const output = scrubFrameworkIdentifiers(
      "OpenCode via Cursor touched /tmp/kyoli/opencode-config.json and mentioned openai gateway",
    );

    expect(output).toContain("/tmp/kyoli/opencode-config.json");
    expect(output.toLowerCase()).not.toContain("opencode via");
    expect(output.toLowerCase()).not.toContain("cursor");
    expect(output.toLowerCase()).not.toContain("openai");
    expect(output.toLowerCase()).not.toContain("gateway");
  });

  test("normalizeAnthropicClientRequest strips OpenCode adapter fields before Claude Code replay", () => {
    const inputBody = {
      model: "claude-haiku-4-5",
      temperature: 0.2,
      top_p: 0.7,
      top_k: 40,
      thinking: { type: "enabled" },
      context_management: { stale: true },
      output_config: { effort: "high" },
      system: [
        "Local opencode system",
        { type: "text", text: "<system-reminder>drop</system-reminder>" },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Use opencode but keep /tmp/kyoli/opencode-state",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: "Visible answer", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    } satisfies Record<string, unknown>;

    const adapted = normalizeAnthropicClientRequest(inputBody);
    const messages = adapted.messages as Array<{ content: Array<Record<string, unknown>> }>;

    expect("temperature" in adapted.body).toBe(false);
    expect("top_p" in adapted.body).toBe(false);
    expect("top_k" in adapted.body).toBe(false);
    expect("thinking" in adapted.body).toBe(false);
    expect("context_management" in adapted.body).toBe(false);
    expect("output_config" in adapted.body).toBe(false);
    expect(adapted.systemTexts).toEqual(["Local  system"]);
    expect(messages[0]?.content).toEqual([
      { type: "text", text: "Use  but keep /tmp/kyoli/opencode-state" },
    ]);
    expect(messages[1]?.content).toEqual([
      { type: "text", text: "Visible answer" },
    ]);
    expect(JSON.stringify(adapted.body)).not.toContain("cache_control");
  });

  test("normalizeAnthropicClientRequest drops empty turns but preserves tool_result turns", () => {
    const adapted = normalizeAnthropicClientRequest({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "<system-reminder>hidden</system-reminder>" }],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: { question: "continue?" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "<env>hidden</env>" },
          ],
        },
      ],
    });

    expect(adapted.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: { question: "continue?" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "" },
        ],
      },
    ]);
  });
});
