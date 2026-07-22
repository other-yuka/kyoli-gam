import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const packageRoot = join(import.meta.dirname, "../..");
const workflow = readFileSync(
  join(packageRoot, "../../.github/workflows/release.yml"),
  "utf8",
);

describe("Release provenance", () => {
  test("hands a merged release to its version commit run before publishing", () => {
    const releasePolicyStep = workflow.indexOf("- name: Classify and handle release PR");
    const releasePolicy = workflow.slice(releasePolicyStep);
    const botTokenGuard = releasePolicy.indexOf('if [ -z "$RELEASE_BOT_PAT" ]; then');
    const botTokenExport = releasePolicy.indexOf('export GH_TOKEN="$RELEASE_BOT_PAT"');
    const mergeRequest = releasePolicy.indexOf('"repos/${GITHUB_REPOSITORY}/pulls/${pr}/merge"');

    expect(workflow).toMatch(/push:\n\s+branches: \[main\]/);
    expect(releasePolicyStep).toBeGreaterThan(-1);
    expect(workflow.slice(0, releasePolicyStep)).toContain("publish: pnpm run release");
    expect(releasePolicy).not.toContain("publish: pnpm run release");
    expect(workflow).not.toContain("steps.auto_publish");
    expect(releasePolicy).toContain("RELEASE_BOT_PAT: ${{ secrets.KYOLI_RELEASE_BOT_PAT }}");
    expect(botTokenGuard).toBeGreaterThan(-1);
    expect(botTokenExport).toBeGreaterThan(botTokenGuard);
    expect(mergeRequest).toBeGreaterThan(botTokenExport);
  });
});
