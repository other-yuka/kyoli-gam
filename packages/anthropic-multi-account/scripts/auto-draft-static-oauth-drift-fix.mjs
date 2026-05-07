import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const reportPath = process.argv[2] ?? "drift-report.json";
const resultPath = process.argv[3] ?? "auto-draft-result.json";
const repoRoot = process.env.KYOLI_GAM_REPO_ROOT
  ? resolve(process.env.KYOLI_GAM_REPO_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const capturePath = "packages/anthropic-multi-account/src/claude-code/fingerprint/capture.ts";
const packageName = "opencode-anthropic-multi-account";
const workflowName = "fingerprint-drift-watch.yml";

function sanitizeVersionForPath(version) {
  return version.replace(/[^0-9A-Za-z.-]/g, "-");
}

function writeGithubOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  appendFileSync(process.env.GITHUB_OUTPUT, `should_create_pr=${result.shouldCreatePr}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `changed_files=${JSON.stringify(result.changedFiles)}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `branch_name=${result.branchName ?? ""}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `commit_message=${result.commitMessage ?? ""}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `pr_title=${result.prTitle ?? ""}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `pr_body_path=${result.prBodyPath ?? ""}\n`);
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
  const current = capture.match(/maxTested: "([^"]+)"/)?.[1] ?? null;
  const nextCapture = capture.replace(/maxTested: "[^"]+"/, `maxTested: "${ccVersion}"`);

  if (nextCapture === capture) {
    return { changed: false, previousVersion: current };
  }

  writeFileSync(absoluteCapturePath, nextCapture);
  return { changed: true, previousVersion: current };
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

function formatDriftItems(items) {
  return items.map((item) => {
    const category = item?.category ?? "unknown";
    const severity = item?.severity ?? "unknown";
    const message = item?.message ?? "No message provided.";
    return `- **${category}** (${severity}) — ${message}`;
  }).join("\n");
}

function writePrBody(report, ccVersion, previousVersion, changesetPath) {
  const bodyPath = "auto-draft-pr-body.md";
  const absoluteBodyPath = join(repoRoot, bodyPath);
  const items = Array.isArray(report.items) ? report.items : [];
  const itemList = formatDriftItems(items) || "- No drift items were included in the report.";
  const previousText = previousVersion ? `v${previousVersion}` : "the previous maxTested value";

  writeFileSync(
    absoluteBodyPath,
    `## Auto-drafted by ${workflowName}\n\n`
      + `The drift watcher flagged Claude Code v${ccVersion} as outside the current supported range. This PR:\n\n`
      + `1. Bumps \`SUPPORTED_CC_RANGE.maxTested\` from ${previousText} → \`v${ccVersion}\` in \`${capturePath}\`\n`
      + `2. Adds a patch changeset at \`${changesetPath}\` for \`${packageName}\`\n\n`
      + `### Items in the drift report\n\n`
      + `${itemList}\n\n`
      + `### What happens when you merge this\n\n`
      + `The repository release workflow uses Changesets. Merging this PR adds the release intent; the next release workflow run opens or updates the version-packages PR, and publishing happens after that version PR is merged.\n\n`
      + `### Maintainer checklist before merging\n\n`
      + `- [ ] Install the new Claude Code locally: \`npm install -g @anthropic-ai/claude-code@${ccVersion}\`\n`
      + `- [ ] Run the Anthropic package test suite against the new Claude Code version.\n`
      + `- [ ] If any fingerprint-sensitive fields changed, re-capture the bundled template locally: \`bun run --cwd packages/anthropic-multi-account bake:fingerprint\`\n`
      + `- [ ] Confirm \`bun run --cwd packages/anthropic-multi-account check:fingerprint-drift\` and the static drift check both report clean results after any manual template update.\n`
      + `- [ ] Merge this PR when the compatibility update is verified.\n\n`
      + `### About this auto-draft\n\n`
      + `Only \`compat.range\`-only drift reports are auto-patched. Template re-capture, OAuth scope/client/URL drift, and other fingerprint-sensitive changes still require maintainer judgment and stay manual.\n\n`
      + `---\n\n`
      + `_Generated by \`packages/anthropic-multi-account/scripts/auto-draft-static-oauth-drift-fix.mjs\`._\n`,
  );

  return bodyPath;
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
  const captureUpdate = updateCaptureMaxTested(ccVersion);
  if (captureUpdate.changed) {
    changedFiles.push(capturePath);
  }

  const changesetPath = writeChangeset(ccVersion);
  const prBodyPath = writePrBody(report, ccVersion, captureUpdate.previousVersion, changesetPath);
  changedFiles.push(changesetPath);

  return {
    shouldCreatePr: changedFiles.length > 0,
    changedFiles,
    branchName: `bot/cc-drift-v${sanitizeVersionForPath(ccVersion)}`,
    commitMessage: `chore(cc-drift): ${packageName} maxTested → v${ccVersion}`,
    prTitle: `chore(cc-drift): ${packageName} maxTested → v${ccVersion}`,
    prBodyPath,
    reason: changedFiles.length > 0 ? "compat.range patched" : "no file changes",
  };
}

export {
  createCompatRangePatch,
  sanitizeVersionForPath,
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const result = createCompatRangePatch(report);
  writeResult(result);
}
