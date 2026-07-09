import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const reportPath = process.argv[2] ?? "drift-report.json";
const resultPath = process.argv[3] ?? "auto-draft-result.json";

function writeGithubOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const outputs = {
    should_create_pr: result.shouldCreatePr,
    should_open_issue: result.shouldOpenIssue,
    changed_files: JSON.stringify(result.changedFiles ?? []),
    branch_name: result.branchName ?? "",
    commit_message: result.commitMessage ?? "",
    pr_title: result.prTitle ?? "",
    pr_body_path: result.prBodyPath ?? "",
  };

  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function writeResult(result) {
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  writeGithubOutputs(result);
}

function categoriesFromReport(report) {
  const items = Array.isArray(report.items) ? report.items : [];
  return items
    .map((item) => item?.category)
    .filter((category) => typeof category === "string");
}

function classifyDriftReport(report) {
  const categories = categoriesFromReport(report);

  if (!report.drift || categories.length === 0) {
    return {
      shouldCreatePr: false,
      shouldOpenIssue: false,
      changedFiles: [],
      reason: "drift report has no items to fix",
    };
  }

  if (categories.length === 1 && categories[0] === "compat.range") {
    return {
      shouldCreatePr: false,
      shouldOpenIssue: true,
      changedFiles: [],
      reason: "compat.range follows the rebaked fingerprint cc_version; run the live rebake workflow instead",
    };
  }

  return {
    shouldCreatePr: false,
    shouldOpenIssue: true,
    changedFiles: [],
    reason: `manual drift review required for categories: ${categories.join(", ")}`,
  };
}

export {
  classifyDriftReport,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const classified = classifyDriftReport(report);
  writeResult(classified);
}
