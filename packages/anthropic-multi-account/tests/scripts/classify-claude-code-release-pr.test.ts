import { describe, expect, test } from "vitest";
import {
  classifyClaudeCodeReleasePullRequest,
} from "../../scripts/classify-claude-code-release-pr.mjs";

const changesetPath = ".changeset/claude-code-auto-a-2-1-206-123.md";
const changesetContent = `---
"opencode-anthropic-multi-account": patch
---

Refresh Claude Code.
`;
const generatedReleaseFiles = [
  {
    filename: changesetPath,
    status: "removed",
    additions: 0,
    deletions: 5,
    patch: "@@ -1,5 +0,0 @@\n----\n-\"opencode-anthropic-multi-account\": patch\n----\n-\n-Refresh Claude Code.",
  },
  {
    filename: "packages/anthropic-multi-account/package.json",
    packageName: "opencode-anthropic-multi-account",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1,5 +1,5 @@\n-  \"version\": \"0.2.85\",\n+  \"version\": \"0.2.86\",",
  },
  {
    filename: "packages/anthropic-multi-account/CHANGELOG.md",
    packageName: "opencode-anthropic-multi-account",
    status: "modified",
    additions: 5,
    deletions: 0,
    patch: "@@ -1,3 +1,8 @@\n+## 0.2.86\n+\n+### Patch Changes\n+\n+- [#210](https://github.com/other-yuka/kyoli-gam/pull/210) - Refresh Claude Code.",
  },
];
const expectedReleases = [{
  name: "opencode-anthropic-multi-account",
  oldVersion: "0.2.85",
  newVersion: "0.2.86",
}];

function classify(overrides: Record<string, unknown> = {}) {
  return classifyClaudeCodeReleasePullRequest({
    repository: "other-yuka/kyoli-gam",
    sourcePrNumber: 210,
    sourceLabels: ["claude-code-auto-release"],
    releaseBody: "- [#210](https://github.com/other-yuka/kyoli-gam/pull/210) refresh Claude Code",
    files: generatedReleaseFiles,
    expectedChangesetPath: changesetPath,
    expectedChangesetContent: changesetContent,
    sourceChangesetContent: changesetContent,
    expectedReleases,
    ...overrides,
  });
}

describe("Claude Code release PR classifier", () => {
  test("allows an isolated generated release from a trusted drift PR", () => {
    expect(classify()).toMatchObject({ autoMerge: true, className: "A" });
  });

  test("allows an isolated Class B rebake release", () => {
    const classBPath = changesetPath.replace("claude-code-auto-a-", "claude-code-auto-b-");
    const files = generatedReleaseFiles.map((file) => ({
      ...file,
      filename: file.filename.replace("claude-code-auto-a-", "claude-code-auto-b-"),
      patch: file.patch.replaceAll("pull/210", "pull/211"),
    }));

    expect(classify({
      sourcePrNumber: 211,
      releaseBody: "- [#211](https://github.com/other-yuka/kyoli-gam/pull/211) rebake Claude Code",
      files,
      expectedChangesetPath: classBPath,
    })).toMatchObject({ autoMerge: true, className: "B" });
  });

  test("allows the fixed-package fanout generated from one trusted changeset", () => {
    const dependencyFiles = [
      {
        filename: "packages/multi-account-core/package.json",
        packageName: "opencode-multi-account-core",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,5 +1,5 @@\n-  \"version\": \"0.2.85\",\n+  \"version\": \"0.2.86\",",
      },
      {
        filename: "packages/multi-account-core/CHANGELOG.md",
        packageName: "opencode-multi-account-core",
        status: "modified",
        additions: 2,
        deletions: 0,
        patch: "@@ -1,3 +1,5 @@\n+## 0.2.86\n+",
      },
    ];
    const releases = [
      ...expectedReleases,
      { name: "opencode-multi-account-core", oldVersion: "0.2.85", newVersion: "0.2.86" },
    ];

    expect(classify({
      files: [...generatedReleaseFiles, ...dependencyFiles],
      expectedReleases: releases,
    })).toMatchObject({ autoMerge: true, className: "A" });
    expect(classify({
      files: [...generatedReleaseFiles, dependencyFiles[1]],
      expectedReleases: releases,
    }).autoMerge).toBe(false);
  });

  test.each([
    {
      name: "forged source without the trusted label",
      overrides: { sourceLabels: [] },
    },
    {
      name: "a link to a different repository",
      overrides: {
        releaseBody: "- [#210](https://github.com/attacker/other/pull/210)",
      },
    },
    {
      name: "mixed non-drift changeset",
      overrides: {
        files: [
          ...generatedReleaseFiles,
          { filename: ".changeset/unrelated-feature.md", status: "removed" },
        ],
      },
    },
    {
      name: "source code in a generated release PR",
      overrides: {
        files: [
          ...generatedReleaseFiles,
          { filename: "packages/core/src/index.ts", status: "modified" },
        ],
      },
    },
    {
      name: "release body that does not include the source PR",
      overrides: {
        releaseBody: "- [#209](https://github.com/other-yuka/kyoli-gam/pull/209)",
      },
    },
    {
      name: "release body with only a longer PR number",
      overrides: {
        releaseBody: "- [#2100](https://github.com/other-yuka/kyoli-gam/pull/2100)",
      },
    },
    {
      name: "a second auto-shaped changeset",
      overrides: {
        files: [
          ...generatedReleaseFiles,
          {
            filename: ".changeset/claude-code-auto-b-2-1-207-456.md",
            status: "removed",
            additions: 0,
            deletions: 5,
            patch: generatedReleaseFiles[0].patch,
          },
        ],
      },
    },
    {
      name: "a Class C changeset",
      overrides: {
        files: generatedReleaseFiles.map((file) => ({
          ...file,
          filename: file.filename.replace("claude-code-auto-a-", "claude-code-auto-c-"),
        })),
        expectedChangesetPath: changesetPath.replace("claude-code-auto-a-", "claude-code-auto-c-"),
      },
    },
    {
      name: "a package manifest dependency rewrite",
      overrides: {
        files: generatedReleaseFiles.map((file) => file.filename.endsWith("package.json")
          ? {
              ...file,
              additions: 2,
              deletions: 2,
              patch: `${file.patch}\n-  \"valibot\": \"^1.4.2\"\n+  \"valibot\": \"latest\"`,
            }
          : file),
      },
    },
    {
      name: "edited changeset contents",
      overrides: {
        files: generatedReleaseFiles.map((file) => file.filename.startsWith(".changeset/")
          ? {
              ...file,
              patch: file.patch.replace("opencode-anthropic-multi-account", "@kyoli-gam/cli"),
            }
          : file),
      },
    },
    {
      name: "a changeset blob modified after the trusted source PR",
      overrides: {
        sourceChangesetContent: changesetContent.replace("patch", "major"),
      },
    },
    {
      name: "changelog notes that do not come from the trusted changeset",
      overrides: {
        files: generatedReleaseFiles.map((file) => file.filename.endsWith("CHANGELOG.md")
          ? {
              ...file,
              patch: file.patch
                .replace("pull/210", "pull/999")
                .replace("Refresh Claude Code.", "Unrelated release notes."),
            }
          : file),
      },
    },
    {
      name: "a version bump that differs from the release plan",
      overrides: {
        files: generatedReleaseFiles.map((file) => file.filename.endsWith("package.json")
          ? { ...file, patch: file.patch.replace("0.2.86", "99.0.0") }
          : file),
      },
    },
    {
      name: "missing generated changelog",
      overrides: {
        files: generatedReleaseFiles.filter((file) => !file.filename.endsWith("CHANGELOG.md")),
      },
    },
  ])("rejects $name", ({ overrides }) => {
    expect(classify(overrides).autoMerge).toBe(false);
  });
});
