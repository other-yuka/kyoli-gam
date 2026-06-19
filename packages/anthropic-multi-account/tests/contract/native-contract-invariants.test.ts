import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ClaudeIdentity } from "../../src/claude-code/identity";
import type { TemplateData } from "../../src/claude-code/fingerprint/capture";
import {
  buildUpstreamRequest,
  resetUpstreamRequestForTest,
  setUpstreamRequestTestOverridesForTest,
} from "../../src/request/upstream-request";
import { createRealisticRequestPayload } from "../fixtures/realistic-request-payload";

/**
 * Native-plugin request contract invariants.
 *
 * Keep exact-shape regression tests elsewhere, and separately assert the structural rules that must survive Claude Code template
 * drift. These are no-live contract tests. They do not prove Anthropic accepts a
 * request today; they prove kyoli's native plugin keeps producing a valid, stable
 * Claude Code-shaped request before the live/doctor layers get involved.
 */

type JsonRecord = Record<string, unknown>;

function createTemplate(overrides?: Partial<TemplateData>): TemplateData {
  return {
    _version: 1,
    _captured: "2026-04-17T12:00:00.000Z",
    _source: "bundled",
    agent_identity: "You are Claude Code, an interactive CLI tool.",
    system_prompt: "Inspect the repository before making assumptions.",
    tools: [
      {
        name: "Bash",
        description: "Run shell commands",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
      {
        name: "Read",
        description: "Read files",
        input_schema: { type: "object", properties: { file_path: { type: "string" } } },
      },
    ],
    tool_names: ["Bash", "Read"],
    cc_version: "2.1.999",
    anthropic_beta: "oauth-2025-04-20",
    ...overrides,
  };
}

function createIdentity(overrides?: Partial<ClaudeIdentity>): ClaudeIdentity {
  return {
    deviceId: "device-contract",
    accountUuid: "account-contract",
    ...overrides,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  expect(typeof value, label).toBe("string");
  expect((value as string).length, label).toBeGreaterThan(0);
}

function assertPlainObject(value: unknown, label: string): asserts value is JsonRecord {
  expect(isRecord(value), label).toBe(true);
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  expect(typeof value, label).toBe("number");
  expect(Number.isInteger(value), label).toBe(true);
  expect(value as number, label).toBeGreaterThan(0);
}

function collectUndefinedLeaves(value: unknown, path = "$"): string[] {
  if (value === undefined) {
    return [path];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectUndefinedLeaves(item, `${path}[${index}]`));
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, nested]) => collectUndefinedLeaves(nested, `${path}.${key}`));
}

function assertNoUndefinedLeaves(body: JsonRecord, context: string): void {
  expect(collectUndefinedLeaves(body), `${context}: no undefined leaves`).toEqual([]);
}

function assertSystemInvariants(body: JsonRecord, context: string): void {
  expect(Array.isArray(body.system), `${context}: system is array`).toBe(true);
  const system = body.system as Array<JsonRecord>;

  expect(system, `${context}: system has Claude Code 3-block shape`).toHaveLength(3);
  system.forEach((block, index) => {
    assertPlainObject(block, `${context}: system[${index}] is object`);
    expect(block.type, `${context}: system[${index}].type`).toBe("text");
    assertNonEmptyString(block.text, `${context}: system[${index}].text`);
  });
  expect(String(system[0]?.text), `${context}: billing slot`).toMatch(
    /^x-anthropic-billing-header: cc_version=.+; cc_entrypoint=sdk-cli;(?: cch=00000;)?$/,
  );
}

function assertMetadataInvariants(body: JsonRecord, context: string): void {
  assertPlainObject(body.metadata, `${context}: metadata is object`);
  const metadata = body.metadata as JsonRecord;

  assertNonEmptyString(metadata.user_id, `${context}: metadata.user_id`);
  const parsed = JSON.parse(metadata.user_id) as JsonRecord;
  assertNonEmptyString(parsed.device_id, `${context}: metadata.user_id.device_id`);
  assertNonEmptyString(parsed.account_uuid, `${context}: metadata.user_id.account_uuid`);
  assertNonEmptyString(parsed.session_id, `${context}: metadata.user_id.session_id`);
}

function assertNoEmptyTextBlocks(value: unknown, context: string): void {
  const failures: string[] = [];

  function walk(nested: unknown, path: string): void {
    if (Array.isArray(nested)) {
      nested.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }

    if (!isRecord(nested)) {
      return;
    }

    if (nested.type === "text") {
      if (typeof nested.text !== "string" || nested.text.length === 0) {
        failures.push(path);
      }
    }

    for (const [key, child] of Object.entries(nested)) {
      walk(child, `${path}.${key}`);
    }
  }

  walk(value, "$");
  expect(failures, `${context}: no empty text blocks`).toEqual([]);
}

function assertNoEmptyContentArrays(value: unknown, context: string): void {
  const failures: string[] = [];

  function walk(nested: unknown, path: string): void {
    if (Array.isArray(nested)) {
      nested.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }

    if (!isRecord(nested)) {
      return;
    }

    if (Array.isArray(nested.content) && nested.content.length === 0) {
      failures.push(`${path}.content`);
    }

    for (const [key, child] of Object.entries(nested)) {
      walk(child, `${path}.${key}`);
    }
  }

  walk(value, "$");
  expect(failures, `${context}: no empty content arrays`).toEqual([]);
}

function assertBaseRequestInvariants(body: JsonRecord, context: string): void {
  assertNonEmptyString(body.model, `${context}: model`);
  expect(Array.isArray(body.messages), `${context}: messages is array`).toBe(true);
  assertPositiveInteger(body.max_tokens, `${context}: max_tokens`);
  assertSystemInvariants(body, context);
  assertMetadataInvariants(body, context);
  assertNoEmptyTextBlocks(body, context);
  assertNoEmptyContentArrays(body, context);
  assertNoUndefinedLeaves(body, context);
}

beforeEach(() => {
  setUpstreamRequestTestOverridesForTest({
    now: () => 1_000,
    createSessionId: () => "session-contract",
  });
});

afterEach(() => {
  resetUpstreamRequestForTest();
});

describe("native-plugin request contract invariants", () => {
  test("sonnet requests keep adaptive Claude Code body invariants", () => {
    const body = buildUpstreamRequest({
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }, createIdentity(), createTemplate());

    assertBaseRequestInvariants(body, "sonnet");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.context_management).toEqual({});
    expect(body.output_config).toEqual({ effort: "high" });
  });

  test("haiku requests keep base invariants without adaptive thinking fields", () => {
    const body = buildUpstreamRequest({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      thinking: { type: "enabled", budget_tokens: 4096 },
      output_config: { effort: "high" },
      context_management: { stale: true },
    }, createIdentity(), createTemplate());

    assertBaseRequestInvariants(body, "haiku");
    expect("thinking" in body).toBe(false);
    expect("context_management" in body).toBe(false);
    expect("output_config" in body).toBe(false);
  });

  test("realistic OpenCode payload keeps native tool policy and message invariants", () => {
    const body = buildUpstreamRequest(
      createRealisticRequestPayload({ model: "claude-sonnet-4-6" }),
      createIdentity(),
      createTemplate({
        tools: [
          { name: "Bash", input_schema: { type: "object" } },
          { name: "Read", input_schema: { type: "object" } },
          { name: "Edit", input_schema: { type: "object" } },
        ],
        tool_names: ["Bash", "Read", "Edit"],
      }),
    );

    assertBaseRequestInvariants(body, "realistic-opencode");

    const tools = body.tools as Array<{ name?: string; input_schema?: unknown }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_docs",
      "run_command",
      "project_database_lookup",
    ]);
    expect(tools.every((tool) => isRecord(tool.input_schema))).toBe(true);
    const messages = body.messages as Array<{ content?: Array<{ cache_control?: { type: string } }> }>;
    expect(messages.at(-1)?.content?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(body.messages)).not.toContain('"type":"thinking"');
    expect(JSON.stringify(body.system)).not.toContain("Remove this orchestration note.");
  });

  test("template tools are only used when OpenCode sends no tools and schemas are usable", () => {
    const body = buildUpstreamRequest({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
    }, createIdentity(), createTemplate());

    assertBaseRequestInvariants(body, "template-tools");
    expect(body.tools).toEqual([
      {
        name: "Bash",
        description: "Run shell commands",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
      {
        name: "Read",
        description: "Read files",
        input_schema: { type: "object", properties: { file_path: { type: "string" } } },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  test("sanitized system-reminder-only content does not create invalid text blocks", () => {
    const body = buildUpstreamRequest({
      model: "claude-sonnet-4-6",
      system: "<system-reminder>drop this local note</system-reminder>",
      messages: [
        { role: "user", content: [{ type: "text", text: "<env>hidden</env>" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "<thinking>hidden</thinking>" },
            { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: { question: "continue?" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "<system-reminder>hidden</system-reminder>" },
          ],
        },
      ],
    }, createIdentity(), createTemplate());

    assertBaseRequestInvariants(body, "sanitized-empty-content");
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "AskUserQuestion", input: { question: "continue?" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  test("JSON serialization round-trip preserves required wire fields", () => {
    const body = buildUpstreamRequest({
      model: "claude-opus-4-7",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: "follow-up" },
      ],
    }, createIdentity(), createTemplate());

    const roundTripped = JSON.parse(JSON.stringify(body)) as JsonRecord;

    assertBaseRequestInvariants(roundTripped, "json-roundtrip");
    expect(roundTripped.thinking).toEqual({ type: "adaptive" });
  });
});
