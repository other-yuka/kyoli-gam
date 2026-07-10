import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLAUDE_CODE_VERSION_PATTERN } from "./claude-code-version-utils.mjs";
import {
  classifyLiveFingerprintDiff,
  createLabelOnlyFingerprintUpdate,
} from "./live-fingerprint-drift-utils.mjs";

function defaultRepoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function defaultBundledPath(repoRoot) {
  return join(repoRoot, "packages/providers/claude-code/src/fingerprint/data.json");
}

function safeToken(value) {
  return String(value).replace(/[^0-9A-Za-z.-]/g, "-");
}

function writeGithubOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) return;

  const outputs = {
    class_name: result.className,
    branch_name: result.branchName,
    commit_message: result.commitMessage,
    pr_title: result.prTitle,
    pr_body_path: result.prBodyPath,
    changed_files: JSON.stringify(result.changedFiles),
    changeset_path: result.changesetPath,
    target_version: result.targetVersion,
  };
  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

export function prepareLiveFingerprintPullRequest({
  className,
  report,
  capturedFingerprint,
  repoRoot = defaultRepoRoot(),
  bundledPath = defaultBundledPath(repoRoot),
  runId = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
    : "local",
  runUrl = process.env.GITHUB_SERVER_URL
    && process.env.GITHUB_REPOSITORY
    && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
}) {
  if (className !== "A" && className !== "B") {
    throw new Error(`Unsupported Claude Code update class: ${className}`);
  }

  const targetVersion = report?.summary?.actualCcVersion;
  if (typeof targetVersion !== "string" || !CLAUDE_CODE_VERSION_PATTERN.test(targetVersion)) {
    throw new Error("Live fingerprint report is missing a concrete actualCcVersion");
  }
  const expectedClassification = className === "A" ? "label-only" : "shape";
  if (report?.classification !== expectedClassification) {
    throw new Error(`Class ${className} requires a ${expectedClassification} live report`);
  }
  if (capturedFingerprint?.cc_version !== targetVersion) {
    throw new Error("Captured fingerprint version does not match the live report target");
  }

  const bundled = JSON.parse(readFileSync(bundledPath, "utf8"));
  if (className === "A") {
    const updated = createLabelOnlyFingerprintUpdate(bundled, capturedFingerprint);
    writeFileSync(bundledPath, `${JSON.stringify(updated, null, 2)}\n`);
  } else {
    const postRebake = classifyLiveFingerprintDiff(bundled, capturedFingerprint, [], {
      targetVersion,
    });
    if (postRebake.classification !== "clean") {
      throw new Error(`Class B rebake does not match the classified live fingerprint: ${postRebake.reason}`);
    }
  }

  const safeVersion = safeToken(targetVersion);
  const safeRunId = safeToken(runId);
  const classToken = className.toLowerCase();
  const changesetPath = `.changeset/claude-code-auto-${classToken}-${safeVersion.replaceAll(".", "-")}-${safeRunId}.md`;
  const changesetFullPath = join(repoRoot, changesetPath);
  mkdirSync(dirname(changesetFullPath), { recursive: true });

  const description = className === "A"
    ? `Refresh Claude Code version labels for \`@anthropic-ai/claude-code@${targetVersion}\` after exact-version live capture proved the wire shape unchanged.`
    : `Rebake the Claude Code fingerprint for \`@anthropic-ai/claude-code@${targetVersion}\` after exact-version live capture detected wire-shape drift.`;
  writeFileSync(
    changesetFullPath,
    `---\n"opencode-anthropic-multi-account": patch\n---\n\n${description}\n`,
  );

  const branchName = `bot/claude-fingerprint-${classToken}-${safeVersion}-${safeRunId}`;
  const prTitle = `fix(claude-code): Auto-refresh Class ${className} fingerprint for ${targetVersion}`;
  const prBodyPath = "claude-code-auto-pr-body.md";
  const runLine = runUrl ? `- Live evidence: ${runUrl}` : "- Live evidence: local run";
  writeFileSync(
    join(repoRoot, prBodyPath),
    `## Class ${className} Claude Code update\n\n${description}\n\n## Automated gates\n\n- Exact target version captured: \`${targetVersion}\`\n- Fingerprint scrub and classification completed\n- Server Mode provider tests completed before PR creation\n- OpenCode Mode native contract tests completed before PR creation\n- The automation waits for required checks, revalidates the head commit, and then merges\n${runLine}\n\n## Release\n\nThis PR is labeled for isolated Changesets release validation. A release PR auto-merges only when it contains Claude Code automation changesets and generated package metadata exclusively.\n`,
  );

  const result = {
    className,
    targetVersion,
    branchName,
    commitMessage: prTitle,
    prTitle,
    prBodyPath,
    changesetPath,
    changedFiles: [
      "packages/providers/claude-code/src/fingerprint/data.json",
      changesetPath,
    ],
  };
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const className = process.argv[2];
  const reportPath = process.argv[3] ?? "live-template-drift.json";
  const capturePath = process.argv[4] ?? "live-template-capture.json";
  const resultPath = process.argv[5] ?? "live-template-pr.json";
  const result = prepareLiveFingerprintPullRequest({
    className,
    report: JSON.parse(readFileSync(reportPath, "utf8")),
    capturedFingerprint: JSON.parse(readFileSync(capturePath, "utf8")),
  });
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  writeGithubOutputs(result);
}
