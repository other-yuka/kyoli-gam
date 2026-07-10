import { describe, expect, test } from "vitest";
import {
  selectSupersededClaudeCodeIssueNumbers,
} from "../../scripts/select-superseded-claude-code-issues.mjs";

describe("select superseded Claude Code issues", () => {
  test("selects matching and older versions but preserves newer and unversioned alerts", () => {
    expect(selectSupersededClaudeCodeIssueNumbers([
      { number: 1, title: "Claude Code automation failed: v2.1.205" },
      { number: 2, title: "Claude Code automation failed: v2.1.206" },
      { number: 3, title: "Claude Code automation failed: v2.1.207" },
      { number: 4, title: "Claude Code release automation failed" },
    ], "2.1.206")).toEqual([1, 2]);
  });

  test("refuses an invalid target version", () => {
    expect(selectSupersededClaudeCodeIssueNumbers([
      { number: 1, title: "Claude Code drift detected: v2.1.205" },
    ], "latest")).toEqual([]);
  });
});
