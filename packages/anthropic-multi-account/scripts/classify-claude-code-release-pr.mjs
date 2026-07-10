import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const TRUSTED_LABEL = "claude-code-auto-release";
const AUTO_CHANGESET_PATTERN = /^\.changeset\/claude-code-auto-([ab])-[0-9a-z.-]+\.md$/i;
const GENERATED_PACKAGE_FILE_PATTERN = /^packages\/(?:[^/]+\/)*(package\.json|CHANGELOG\.md)$/;
const VERSION_LINE_PATTERN = /^\s*"version":\s*"(\d+\.\d+\.\d+)",?$/;

function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => typeof label === "string" ? label : label?.name)
    .filter((label) => typeof label === "string");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function changedPatchLines(file) {
  if (typeof file?.patch !== "string") return [];
  return file.patch.split("\n").filter((line) => /^[+-]/.test(line));
}

function removedFileContent(file) {
  const lines = changedPatchLines(file);
  if (file?.additions !== 0 || file?.deletions !== lines.length || lines.some((line) => !line.startsWith("-"))) {
    return null;
  }
  return `${lines.map((line) => line.slice(1)).join("\n")}\n`;
}

function manifestVersionChange(file) {
  const changedLines = changedPatchLines(file);
  if (file?.status !== "modified" || file.additions !== 1 || file.deletions !== 1 || changedLines.length !== 2) {
    return null;
  }
  const oldVersion = changedLines[0]?.startsWith("-")
    ? changedLines[0].slice(1).match(VERSION_LINE_PATTERN)?.[1]
    : null;
  const newVersion = changedLines[1]?.startsWith("+")
    ? changedLines[1].slice(1).match(VERSION_LINE_PATTERN)?.[1]
    : null;
  return oldVersion && newVersion ? { oldVersion, newVersion } : null;
}

function parseTrustedChangeset(content) {
  if (typeof content !== "string") return null;
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") return null;
  const closingDelimiter = lines.indexOf("---", 1);
  if (closingDelimiter < 2) return null;

  const packageNames = lines.slice(1, closingDelimiter).map((line) => (
    line.match(/^"([^"]+)": (?:patch|minor|major)$/)?.[1]
  ));
  const summary = lines.slice(closingDelimiter + 1).join("\n").trim();
  if (packageNames.some((name) => !name) || packageNames.length === 0 || !summary) return null;
  return { packageNames: new Set(packageNames), summary };
}

function isGeneratedChangelog(file, expected, trustedChangeset, sourceUrl) {
  const changedLines = changedPatchLines(file);
  const addedContent = changedLines.map((line) => line.slice(1)).join("\n");
  const generatedPatch = file?.status === "modified"
    && file.deletions === 0
    && file.additions > 0
    && changedLines.length === file.additions
    && changedLines.every((line) => line.startsWith("+"))
    && addedContent.split("\n").includes(`## ${expected.newVersion}`);
  if (!generatedPatch) return false;

  return !trustedChangeset.packageNames.has(file.packageName)
    || (addedContent.includes(sourceUrl) && addedContent.includes(trustedChangeset.summary));
}

function releasePlanByName(expectedReleases) {
  const entries = (Array.isArray(expectedReleases) ? expectedReleases : [])
    .filter((release) => (
      typeof release?.name === "string"
      && typeof release?.oldVersion === "string"
      && typeof release?.newVersion === "string"
    ))
    .map((release) => [release.name, release]);
  return new Map(entries);
}

export function classifyClaudeCodeReleasePullRequest({
  repository,
  sourcePrNumber,
  sourceLabels,
  releaseBody,
  files,
  expectedChangesetPath,
  expectedChangesetContent,
  sourceChangesetContent,
  expectedReleases,
}) {
  if (!labelNames(sourceLabels).includes(TRUSTED_LABEL)) {
    return { autoMerge: false, reason: `source PR is missing ${TRUSTED_LABEL}` };
  }

  if (typeof repository !== "string" || !repository.includes("/")) {
    return { autoMerge: false, reason: "release policy is missing the repository identity" };
  }
  const sourceLinkPattern = new RegExp(
    `https://github\\.com/${escapeRegExp(repository)}/pull/${sourcePrNumber}(?!\\d)`,
  );
  if (typeof releaseBody !== "string" || !sourceLinkPattern.test(releaseBody)) {
    return { autoMerge: false, reason: "release PR does not include the exact trusted source PR" };
  }

  const changedFiles = Array.isArray(files) ? files : [];
  const changesets = changedFiles.filter((file) => file?.filename?.startsWith(".changeset/"));
  if (changesets.length !== 1) {
    return { autoMerge: false, reason: "release PR must contain exactly one Claude Code drift changeset" };
  }

  const changeset = changesets[0];
  const changesetMatch = changeset.filename.match(AUTO_CHANGESET_PATTERN);
  if (!changesetMatch || changeset.status !== "removed" || changeset.filename !== expectedChangesetPath) {
    return { autoMerge: false, reason: `untrusted changeset in release PR: ${changeset.filename}` };
  }
  if (removedFileContent(changeset) !== expectedChangesetContent) {
    return { autoMerge: false, reason: "release PR changeset content differs from the trusted source" };
  }
  if (sourceChangesetContent !== expectedChangesetContent) {
    return { autoMerge: false, reason: "current changeset differs from the trusted source PR blob" };
  }
  const trustedChangeset = parseTrustedChangeset(sourceChangesetContent);
  if (!trustedChangeset) {
    return { autoMerge: false, reason: "trusted source changeset is not a valid auto-release input" };
  }

  const expectedByName = releasePlanByName(expectedReleases);
  if (expectedByName.size === 0) {
    return { autoMerge: false, reason: "trusted source has no Changesets release plan" };
  }

  const generatedFiles = changedFiles.filter((file) => !file?.filename?.startsWith(".changeset/"));
  if (generatedFiles.some((file) => !GENERATED_PACKAGE_FILE_PATTERN.test(file?.filename ?? ""))) {
    const unexpected = generatedFiles.find((file) => !GENERATED_PACKAGE_FILE_PATTERN.test(file?.filename ?? ""));
    return { autoMerge: false, reason: `unexpected release PR file: ${unexpected?.filename ?? "unknown"}` };
  }

  const manifests = generatedFiles.filter((file) => file.filename.endsWith("package.json"));
  const changelogs = generatedFiles.filter((file) => file.filename.endsWith("CHANGELOG.md"));
  if (manifests.length !== expectedByName.size || changelogs.length !== expectedByName.size) {
    return { autoMerge: false, reason: "release PR package/changelog set differs from the Changesets release plan" };
  }

  const seenManifests = new Set();
  for (const file of manifests) {
    const expected = expectedByName.get(file.packageName);
    const actual = manifestVersionChange(file);
    if (!expected || !actual || actual.oldVersion !== expected.oldVersion || actual.newVersion !== expected.newVersion) {
      return { autoMerge: false, reason: `package manifest differs from the release plan: ${file.filename}` };
    }
    seenManifests.add(file.packageName);
  }

  const seenChangelogs = new Set();
  const sourceUrl = `https://github.com/${repository}/pull/${sourcePrNumber}`;
  for (const file of changelogs) {
    const expected = expectedByName.get(file.packageName);
    if (!expected || !isGeneratedChangelog(file, expected, trustedChangeset, sourceUrl)) {
      return { autoMerge: false, reason: `non-generated changelog patch: ${file.filename}` };
    }
    seenChangelogs.add(file.packageName);
  }
  if (seenManifests.size !== expectedByName.size || seenChangelogs.size !== expectedByName.size) {
    return { autoMerge: false, reason: "release PR is missing a package from the Changesets release plan" };
  }

  return {
    autoMerge: true,
    className: changesetMatch[1].toUpperCase(),
    reason: "release PR exactly matches the trusted Claude Code changeset and Changesets release plan",
  };
}

function addPackageNames(files, repoRoot) {
  return files.map((file) => {
    const match = file?.filename?.match(GENERATED_PACKAGE_FILE_PATTERN);
    if (!match) return file;
    const manifestPath = match[1] === "package.json"
      ? file.filename
      : join(dirname(file.filename), "package.json");
    try {
      return {
        ...file,
        packageName: JSON.parse(readFileSync(join(repoRoot, manifestPath), "utf8")).name,
      };
    } catch {
      return file;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourcePath = process.argv[2] ?? "source-pr.json";
  const releasePath = process.argv[3] ?? "release-pr.json";
  const filesPath = process.argv[4] ?? "release-pr-files.json";
  const policyPath = process.argv[5] ?? "release-policy-input.json";
  const resultPath = process.argv[6] ?? "release-classification.json";
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const result = classifyClaudeCodeReleasePullRequest({
    repository: process.env.GITHUB_REPOSITORY,
    sourcePrNumber: source.number,
    sourceLabels: source.labels,
    releaseBody: release.body,
    files: addPackageNames(JSON.parse(readFileSync(filesPath, "utf8")), process.cwd()),
    expectedChangesetPath: policy.autoChangesetPath,
    expectedChangesetContent: policy.autoChangesetContent,
    sourceChangesetContent: source.changesetContent,
    expectedReleases: policy.releases,
  });
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}
