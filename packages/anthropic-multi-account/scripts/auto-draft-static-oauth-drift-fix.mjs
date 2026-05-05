import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const reportPath = process.argv[2] ?? "drift-report.json";
const resultPath = process.argv[3] ?? "auto-draft-result.json";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const capturePath = "packages/anthropic-multi-account/src/claude-code/fingerprint/capture.ts";
const packageName = "opencode-anthropic-multi-account";

function sanitizeVersionForPath(version) {
  return version.replace(/[^0-9A-Za-z.-]/g, "-");
}

function writeGithubOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  appendFileSync(process.env.GITHUB_OUTPUT, `should_create_pr=${result.shouldCreatePr}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `changed_files=${JSON.stringify(result.changedFiles)}\n`);
}

function writeResult(result) {
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  writeGithubOutputs(result);
}

function createSkippedResult(reason) {
  return { shouldCreatePr: false, changedFiles: [], reason };
}

function updateCaptureMaxTested(ccVersion) {
  const absoluteCapturePath = join(repoRoot, capturePath);
  const capture = readFileSync(absoluteCapturePath, "utf8");
  const nextCapture = capture.replace(/maxTested: "[^"]+"/, `maxTested: "${ccVersion}"`);

  if (nextCapture === capture) {
    return false;
  }

  writeFileSync(absoluteCapturePath, nextCapture);
  return true;
}

function writeChangeset(ccVersion) {
  const changesetPath = `.changeset/cc-drift-${sanitizeVersionForPath(ccVersion)}.md`;
  const absoluteChangesetPath = join(repoRoot, changesetPath);
  mkdirSync(dirname(absoluteChangesetPath), { recursive: true });
  writeFileSync(
    absoluteChangesetPath,
    `---\n"${packageName}": patch\n---\n\nUpdate the supported Claude Code compatibility range to ${ccVersion}.\n`,
  );
  return changesetPath;
}

function createCompatRangePatch(report) {
  const items = Array.isArray(report.items) ? report.items : [];
  const ccVersion = typeof report.ccVersion === "string" ? report.ccVersion : "";

  if (!ccVersion) {
    return createSkippedResult("missing ccVersion");
  }

  if (items.length !== 1 || items[0]?.category !== "compat.range") {
    return createSkippedResult("drift is not compat.range-only");
  }

  const changedFiles = [];
  if (updateCaptureMaxTested(ccVersion)) {
    changedFiles.push(capturePath);
  }

  changedFiles.push(writeChangeset(ccVersion));

  return {
    shouldCreatePr: changedFiles.length > 0,
    changedFiles,
    reason: changedFiles.length > 0 ? "compat.range patched" : "no file changes",
  };
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const result = createCompatRangePatch(report);
writeResult(result);
