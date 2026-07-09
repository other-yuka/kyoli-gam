import { describe, expect, test } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(packageRoot, "scripts/live-fingerprint-drift-utils.mjs");

const {
  hasLiveFingerprintDrift,
  summarizeLiveFingerprintDiff,
} = await import(scriptPath);

function template(overrides: Record<string, unknown> = {}) {
  return {
    agent_identity: "Claude Code",
    system_prompt: "system",
    tool_names: ["Read", "Bash"],
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
  test("treats version-only drift as rebake-worthy drift", () => {
    const summary = summarizeLiveFingerprintDiff(
      template(),
      template({ cc_version: "2.1.206" }),
    );

    expect(summary.ccVersionMatches).toBe(false);
    expect(hasLiveFingerprintDrift(summary, [])).toBe(true);
  });

  test("ignores interactive-only tool count differences", () => {
    const summary = summarizeLiveFingerprintDiff(
      template({ tool_names: ["Read", "Bash", "AskUserQuestion"] }),
      template({ tool_names: ["Read", "Bash"] }),
    );

    expect(summary.toolNamesMatch).toBe(true);
    expect(hasLiveFingerprintDrift(summary, [])).toBe(false);
  });
});
