import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const reportPath = process.argv[2] ?? "drift-report.json";
const resultPath = process.argv[3] ?? "auto-draft-result.json";
const shouldApply = process.argv.includes("--apply");

function packageRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function sanitizeVersion(version) {
  return String(version ?? "unknown").replace(/[^0-9A-Za-z.-]/g, "-");
}

function branchNameForVersion(version) {
  return `bot/cc-drift-v${sanitizeVersion(version)}`;
}

function changesetPathForVersion(version) {
  return join(".changeset", `claude-code-${sanitizeVersion(version).replace(/\./g, "-")}-drift.md`);
}

function prTitleForVersion(version) {
  return `fix(claude-code): Refresh drift metadata for ${version}`;
}

function commitMessageForVersion(version) {
  return prTitleForVersion(version);
}

function prBodyForVersion(version, report) {
  const checkedAt = report.checkedAt ?? new Date().toISOString();
  return `## Summary\n\nAutomated compat-range refresh for \`@anthropic-ai/claude-code@${version}\`.\n\nThis PR is intentionally limited to the static \`compat.range\` drift class: OAuth URLs/client ID and scanner layout did not drift, so it advances kyoli's max-tested Claude Code range, updates bundled version metadata used by doctor checks, and adds a patch changeset. Template or wire-shape drift must stay human-gated.\n\n## Validation gate\n\nRequired PR checks must pass before native auto-merge can complete. If local doctor/template/wire validation disagrees with this static report, close this PR and handle the drift manually.\n\n## Drift report\n\n- checkedAt: \`${checkedAt}\`\n- ccVersion: \`${version}\`\n- categories: \`${(report.items ?? []).map((item) => item.category).join(", ")}\`\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}

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
    if (!report.ccVersion || report.ccVersion === "unknown") {
      return {
        shouldCreatePr: false,
        shouldOpenIssue: true,
        changedFiles: [],
        reason: "compat.range drift is auto-fixable only when ccVersion is known",
      };
    }

    return {
      shouldCreatePr: true,
      shouldOpenIssue: false,
      changedFiles: [],
      reason: "compat.range-only drift can be auto-drafted behind PR checks",
      branchName: branchNameForVersion(report.ccVersion),
      commitMessage: commitMessageForVersion(report.ccVersion),
      prTitle: prTitleForVersion(report.ccVersion),
    };
  }

  return {
    shouldCreatePr: false,
    shouldOpenIssue: true,
    changedFiles: [],
    reason: `manual drift review required for categories: ${categories.join(", ")}`,
  };
}

function replaceMaxTested(source, nextVersion) {
  const pattern = /(maxTested:\s*")[^"]+(")/;
  if (!pattern.test(source)) {
    throw new Error("Unable to find SUPPORTED_CC_RANGE.maxTested in capture.ts");
  }
  return source.replace(pattern, `$1${nextVersion}$2`);
}

function replaceBundledFingerprintVersion(source, nextVersion) {
  const versionPattern = /("cc_version":\s*")[^"]+(")/;
  const userAgentPattern = /("user-agent":\s*"claude-cli\/)[^ "]+( [^"]*")/;
  if (!versionPattern.test(source)) {
    throw new Error("Unable to find fingerprint cc_version");
  }
  if (!userAgentPattern.test(source)) {
    throw new Error("Unable to find fingerprint user-agent");
  }
  return source
    .replace(versionPattern, `$1${nextVersion}$2`)
    .replace(userAgentPattern, `$1${nextVersion}$2`);
}

function applyCompatRangeFix(report, options = {}) {
  const root = options.packageRootPath ?? packageRoot();
  const repoRoot = join(root, "..", "..");
  const version = report.ccVersion;
  const sourceRelativePath = "packages/providers/claude-code/src/fingerprint-capture.ts";
  const sourcePath = join(repoRoot, sourceRelativePath);
  const providerDataRelativePath = "packages/providers/claude-code/src/fingerprint/data.json";
  const providerDataPath = join(repoRoot, providerDataRelativePath);
  const changesetRelativePath = changesetPathForVersion(version);
  const changesetFullPath = join(repoRoot, changesetRelativePath);
  const prBodyPath = "pr-body.md";

  const source = readFileSync(sourcePath, "utf8");
  const updatedSource = replaceMaxTested(source, version);
  writeFileSync(sourcePath, updatedSource);

  const providerDataSource = readFileSync(providerDataPath, "utf8");
  writeFileSync(providerDataPath, replaceBundledFingerprintVersion(providerDataSource, version));

  mkdirSync(dirname(changesetFullPath), { recursive: true });
  writeFileSync(
    changesetFullPath,
    `---\n"opencode-anthropic-multi-account": patch\n---\n\nRefresh Claude Code static drift compatibility and bundled version metadata for \`@anthropic-ai/claude-code@${version}\`.\n`,
  );

  writeFileSync(join(repoRoot, prBodyPath), prBodyForVersion(version, report));

  return {
    shouldCreatePr: true,
    shouldOpenIssue: false,
    changedFiles: [sourceRelativePath, providerDataRelativePath, changesetRelativePath],
    reason: "compat.range-only drift auto-fix applied",
    branchName: branchNameForVersion(version),
    commitMessage: commitMessageForVersion(version),
    prTitle: prTitleForVersion(version),
    prBodyPath,
  };
}

export {
  applyCompatRangeFix,
  branchNameForVersion,
  changesetPathForVersion,
  classifyDriftReport,
  replaceBundledFingerprintVersion,
  replaceMaxTested,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const classified = classifyDriftReport(report);
  const result = shouldApply && classified.shouldCreatePr
    ? applyCompatRangeFix(report)
    : classified;
  writeResult(result);
}
