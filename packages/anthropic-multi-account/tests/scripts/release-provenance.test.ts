import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const packageRoot = join(import.meta.dirname, "../..");
const repoRoot = join(packageRoot, "../..");
const workflow = readFileSync(
  join(repoRoot, ".github/workflows/release.yml"),
  "utf8",
);
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const changesetConfig = JSON.parse(readFileSync(join(repoRoot, ".changeset/config.json"), "utf8"));

describe("Release provenance", () => {
  test("hands a merged release to its version commit run before publishing", () => {
    const releasePolicyStep = workflow.indexOf("- name: Classify and handle release PR");
    const changesetsStep = workflow.slice(
      workflow.indexOf("- name: Create Release PR or Publish"),
      releasePolicyStep,
    );
    const releasePolicy = workflow.slice(releasePolicyStep);
    const botTokenGuard = releasePolicy.indexOf('if [ -z "$RELEASE_BOT_PAT" ]; then');
    const botTokenExport = releasePolicy.indexOf('export GH_TOKEN="$RELEASE_BOT_PAT"');
    const mergeRequest = releasePolicy.indexOf('"repos/${GITHUB_REPOSITORY}/pulls/${pr}/merge"');

    expect(workflow).toMatch(/push:\n\s+branches: \[main\]/);
    expect(releasePolicyStep).toBeGreaterThan(-1);
    expect(changesetsStep).toContain("uses: changesets/action@v2");
    expect(changesetsStep).toContain("github-token: ${{ secrets.KYOLI_RELEASE_BOT_PAT || secrets.GITHUB_TOKEN }}");
    expect(changesetsStep).toContain('pr-title: "chore: version packages"');
    expect(changesetsStep).toContain('commit-message: "chore: version packages"');
    expect(changesetsStep).toContain("version-script: pnpm exec changeset version");
    expect(changesetsStep).toContain("publish-script: pnpm run release");
    expect(changesetsStep).toContain("create-github-releases: true");
    expect(changesetsStep).not.toMatch(/\n\s+GITHUB_TOKEN:/);
    expect(releasePolicy).not.toContain("publish-script: pnpm run release");
    expect(workflow).not.toContain("steps.auto_publish");
    expect(releasePolicy).toContain("RELEASE_BOT_PAT: ${{ secrets.KYOLI_RELEASE_BOT_PAT }}");
    expect(botTokenGuard).toBeGreaterThan(-1);
    expect(botTokenExport).toBeGreaterThan(botTokenGuard);
    expect(mergeRequest).toBeGreaterThan(botTokenExport);
  });

  test("keeps Changesets v3 aligned with the current private package release fanout", () => {
    expect(rootPackage.devDependencies).toMatchObject({
      "@changesets/changelog-github": "^1.0.0",
      "@changesets/cli": "^3.0.0",
    });
    expect(changesetConfig.$schema).toBe("https://unpkg.com/@changesets/config@4.0.0/schema.json");
    expect(changesetConfig.privatePackages).toEqual({ version: true, tag: false });
  });
});
