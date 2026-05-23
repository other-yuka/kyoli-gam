import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const reportPath = process.argv[2] ?? "drift-report.json";
const resultPath = process.argv[3] ?? "auto-draft-result.json";

function writeGithubOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  appendFileSync(process.env.GITHUB_OUTPUT, `should_create_pr=${result.shouldCreatePr}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, "changed_files=[]\n");
  appendFileSync(process.env.GITHUB_OUTPUT, "branch_name=\n");
  appendFileSync(process.env.GITHUB_OUTPUT, "commit_message=\n");
  appendFileSync(process.env.GITHUB_OUTPUT, "pr_title=\n");
  appendFileSync(process.env.GITHUB_OUTPUT, "pr_body_path=\n");
}

function writeResult(result) {
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  writeGithubOutputs(result);
}

function classifyDriftReport(report) {
  const items = Array.isArray(report.items) ? report.items : [];
  const categories = items
    .map((item) => item?.category)
    .filter((category) => typeof category === "string");

  if (!report.drift || categories.length === 0) {
    return {
      shouldCreatePr: false,
      changedFiles: [],
      reason: "drift report has no items to fix",
    };
  }

  if (categories.length === 1 && categories[0] === "compat.range") {
    return {
      shouldCreatePr: false,
      changedFiles: [],
      reason: "compat.range requires local Claude Code doctor/template validation before patching",
    };
  }

  return {
    shouldCreatePr: false,
    changedFiles: [],
    reason: `manual drift review required for categories: ${categories.join(", ")}`,
  };
}

export { classifyDriftReport };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const result = classifyDriftReport(report);
  writeResult(result);
}
