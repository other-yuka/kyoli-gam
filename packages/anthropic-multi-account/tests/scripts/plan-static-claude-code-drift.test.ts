import { describe, expect, test } from "vitest";
import {
  planStaticClaudeCodeDrift,
} from "../../scripts/plan-static-claude-code-drift.mjs";

describe("static Claude Code drift plan", () => {
  test("delegates compat-only drift to exact live validation without opening an issue", () => {
    const result = planStaticClaudeCodeDrift({
      drift: true,
      ccVersion: "2.1.162",
      items: [{ category: "compat.range" }],
    });

    expect(result).toMatchObject({
      action: "validate-live",
      targetVersion: "2.1.162",
      shouldDispatchLive: true,
      shouldOpenIssue: false,
    });
  });

  test("keeps OAuth or scanner drift on the alert-only path", () => {
    const result = planStaticClaudeCodeDrift({
      drift: true,
      ccVersion: "2.1.162",
      items: [{ category: "compat.range" }, { category: "oauth.clientId" }],
    });

    expect(result).toMatchObject({
      action: "alert",
      shouldDispatchLive: false,
      shouldOpenIssue: true,
    });
    expect(result.reason).toContain("oauth.clientId");
  });

  test("does nothing for a clean report", () => {
    expect(planStaticClaudeCodeDrift({ drift: false, items: [] })).toMatchObject({
      action: "none",
      shouldDispatchLive: false,
      shouldOpenIssue: false,
    });
  });

  test("fails closed when a drift report has no classified items", () => {
    expect(planStaticClaudeCodeDrift({ drift: true, ccVersion: "2.1.162", items: [] }))
      .toMatchObject({
        action: "alert",
        shouldDispatchLive: false,
        shouldOpenIssue: true,
      });
  });
});
