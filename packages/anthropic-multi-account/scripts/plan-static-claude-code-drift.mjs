import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CLAUDE_CODE_VERSION_PATTERN } from "./claude-code-version-utils.mjs";

function categoriesFromReport(report) {
  return (Array.isArray(report?.items) ? report.items : [])
    .map((item) => item?.category)
    .filter((category) => typeof category === "string");
}

export function planStaticClaudeCodeDrift(report) {
  const categories = categoriesFromReport(report);
  const targetVersion = typeof report?.ccVersion === "string" && CLAUDE_CODE_VERSION_PATTERN.test(report.ccVersion)
    ? report.ccVersion
    : null;

  if (report?.drift === false && categories.length === 0) {
    return {
      action: "none",
      targetVersion,
      shouldDispatchLive: false,
      shouldOpenIssue: false,
      reason: "static report is clean",
    };
  }

  if (report?.drift !== true || categories.length === 0) {
    return {
      action: "alert",
      targetVersion,
      shouldDispatchLive: false,
      shouldOpenIssue: true,
      reason: "manual static drift review required for an inconsistent report",
    };
  }

  if (categories.length === 1 && categories[0] === "compat.range" && targetVersion) {
    return {
      action: "validate-live",
      targetVersion,
      shouldDispatchLive: true,
      shouldOpenIssue: false,
      reason: "compat.range requires exact-version live classification",
    };
  }

  return {
    action: "alert",
    targetVersion,
    shouldDispatchLive: false,
    shouldOpenIssue: true,
    reason: `manual static drift review required for categories: ${categories.join(", ") || "unknown"}`,
  };
}

function writeGithubOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) return;

  const outputs = {
    action: result.action,
    target_version: result.targetVersion ?? "",
    should_dispatch_live: result.shouldDispatchLive,
    should_open_issue: result.shouldOpenIssue,
  };

  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reportPath = process.argv[2] ?? "drift-report.json";
  const resultPath = process.argv[3] ?? "drift-plan.json";
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const result = planStaticClaudeCodeDrift(report);
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  writeGithubOutputs(result);
}
