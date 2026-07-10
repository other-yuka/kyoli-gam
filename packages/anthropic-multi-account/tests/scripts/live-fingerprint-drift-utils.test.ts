import { describe, expect, test } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(packageRoot, "scripts/live-fingerprint-drift-utils.mjs");

const {
  classifyLiveFingerprintDiff,
  createLabelOnlyFingerprintUpdate,
} = await import(scriptPath);

function template(overrides: Record<string, unknown> = {}) {
  const tools = [
    { name: "Read", description: "Read a file", input_schema: { type: "object" } },
    { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
  ];
  return {
    agent_identity: "Claude Code",
    system_prompt: "system",
    system_prompt_fable: "fable-system",
    tools,
    tool_names: tools.map((tool) => tool.name),
    cc_version: "2.1.205",
    anthropic_beta: "oauth-2025-04-20",
    header_order: ["Authorization", "anthropic-version"],
    header_values: {
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.1.205",
    },
    body_field_order: ["model", "messages", "system"],
    ...overrides,
  };
}

describe("live fingerprint drift utils", () => {
  test("classifies a version and user-agent label change as Class A", () => {
    const actual = template({
      cc_version: "2.1.206",
      header_values: {
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-cli/2.1.206",
      },
    });
    const result = classifyLiveFingerprintDiff(
      template(),
      actual,
      [],
      { targetVersion: "2.1.206" },
    );

    expect(result.classification).toBe("label-only");

    const updated = createLabelOnlyFingerprintUpdate(template(), actual);
    expect(updated).toEqual({
      ...template(),
      cc_version: "2.1.206",
      header_values: {
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-cli/2.1.206",
      },
    });
  });

  test("ignores interactive-only tool count differences", () => {
    const interactiveTool = {
      name: "AskUserQuestion",
      description: "Ask the user",
      input_schema: { type: "object" },
    };
    const expected = template({
      tools: [...template().tools, interactiveTool],
      tool_names: ["Read", "Bash", "AskUserQuestion"],
    });
    const result = classifyLiveFingerprintDiff(
      expected,
      template(),
      [],
      { targetVersion: "2.1.205" },
    );

    expect(result.classification).toBe("clean");
  });

  test("classifies a tool schema change with the same name as Class B", () => {
    const actual = template({
      tools: [
        { name: "Read", description: "Read a file", input_schema: { type: "object", required: ["path"] } },
        { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
      ],
    });

    const result = classifyLiveFingerprintDiff(
      template(),
      actual,
      [],
      { targetVersion: "2.1.205" },
    );

    expect(result.classification).toBe("shape");
    expect(result.summary.toolDefinitionsMatch).toBe(false);
  });

  test.each([
    ["system prompt", { system_prompt: "changed-system" }],
    ["Fable system prompt", { system_prompt_fable: "changed-fable-system" }],
    ["Anthropic beta", { anthropic_beta: "oauth-2025-04-20,new-beta" }],
    ["non-version header value", {
      header_values: {
        "anthropic-version": "2026-01-01",
        "user-agent": "claude-cli/2.1.205",
      },
    }],
    ["header order", { header_order: ["anthropic-version", "Authorization"] }],
    ["body order", { body_field_order: ["messages", "model", "system"] }],
  ])("classifies a %s change as Class B", (_name, overrides) => {
    const result = classifyLiveFingerprintDiff(
      template(),
      template(overrides),
      [],
      { targetVersion: "2.1.205" },
    );

    expect(result.classification).toBe("shape");
  });

  test.each([
    {
      name: "target mismatch",
      expected: template(),
      actual: template(),
      residualHits: [],
      targetVersion: "2.1.206",
    },
    {
      name: "stale capture",
      expected: template(),
      actual: template({
        cc_version: "2.1.204",
        header_values: {
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/2.1.204",
        },
      }),
      residualHits: [],
      targetVersion: "2.1.204",
    },
    {
      name: "identity mismatch",
      expected: template(),
      actual: template({ agent_identity: "Unknown client" }),
      residualHits: [],
      targetVersion: "2.1.205",
    },
    {
      name: "inconsistent bundled version labels",
      expected: template({
        header_values: {
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/2.1.999",
        },
      }),
      actual: template(),
      residualHits: [],
      targetVersion: "2.1.205",
    },
    {
      name: "scrub residue",
      expected: template(),
      actual: template(),
      residualHits: ["/Users/alice"],
      targetVersion: "2.1.205",
    },
  ])("classifies $name as unsafe", ({ expected, actual, residualHits, targetVersion }) => {
    const result = classifyLiveFingerprintDiff(
      expected,
      actual,
      residualHits,
      { targetVersion },
    );

    expect(result.classification).toBe("unsafe");
  });
});
