import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(packageRoot, "scripts/auto-draft-static-oauth-drift-fix.mjs");
const capturePath = "packages/anthropic-multi-account/src/claude-code/fingerprint/capture.ts";

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "kyoli-drift-autodraft-"));
  await mkdir(dirname(join(repoRoot, capturePath)), { recursive: true });
  await writeFile(
    join(repoRoot, capturePath),
    "export const SUPPORTED_CC_RANGE = { minTested: \"2.1.120\", maxTested: \"2.1.128\" };\n",
  );
  return repoRoot;
}

async function runAutoDraft(repoRoot: string, report: unknown) {
  const reportPath = join(repoRoot, "drift-report.json");
  const resultPath = join(repoRoot, "auto-draft-result.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const result = spawnSync(process.execPath, [scriptPath, reportPath, resultPath], {
    cwd: repoRoot,
    env: { ...process.env, KYOLI_GAM_REPO_ROOT: repoRoot },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`${result.stderr}\n${result.stdout}`);
  }

  return JSON.parse(await readFile(resultPath, "utf8")) as {
    shouldCreatePr: boolean;
    changedFiles: string[];
    branchName?: string;
    commitMessage?: string;
    prTitle?: string;
    prBodyPath?: string;
    reason: string;
  };
}

describe("auto-draft-static-oauth-drift-fix", () => {
  test("creates a dario-style auto-draft PR payload for compat range drift", async () => {
    const repoRoot = await createTempRepo();
    try {
      const result = await runAutoDraft(repoRoot, {
        ccVersion: "2.1.132",
        items: [
          {
            category: "compat.range",
            severity: "medium",
            message: "CC v2.1.132 is beyond SUPPORTED_CC_RANGE.maxTested.",
          },
        ],
      });

      const capture = await readFile(join(repoRoot, capturePath), "utf8");
      const changeset = await readFile(join(repoRoot, ".changeset/claude-code-drift-2.1.132.md"), "utf8");
      const prBody = await readFile(join(repoRoot, result.prBodyPath ?? ""), "utf8");

      expect(result.shouldCreatePr).toBe(true);
      expect(result.changedFiles).toEqual([
        capturePath,
        ".changeset/claude-code-drift-2.1.132.md",
      ]);
      expect(result.branchName).toBe("bot/claude-code-drift-v2.1.132");
      expect(result.commitMessage).toBe("chore(claude-code): maxTested → v2.1.132");
      expect(result.prTitle).toBe(result.commitMessage);
      expect(capture).toContain('maxTested: "2.1.132"');
      expect(changeset).toContain('"opencode-anthropic-multi-account": patch');
      expect(prBody).toContain("## Auto-drafted by claude-code-drift-watch.yml");
      expect(prBody).toContain("Bumps `SUPPORTED_CC_RANGE.maxTested` from v2.1.128 → `v2.1.132`");
      expect(prBody).toContain("pnpm --dir packages/cli doctor claude --wire");
      expect(prBody).toContain("### Maintainer checklist before merging");
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("skips reports that are not compat-range-only", async () => {
    const repoRoot = await createTempRepo();
    try {
      const result = await runAutoDraft(repoRoot, {
        ccVersion: "2.1.132",
        items: [
          { category: "compat.range", severity: "medium", message: "range" },
          { category: "template.version", severity: "low", message: "template" },
        ],
      });

      expect(result).toEqual({
        shouldCreatePr: false,
        changedFiles: [],
        reason: "drift is not compat.range-only",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("skips when maxTested cannot be patched", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "kyoli-drift-autodraft-"));
    try {
      await mkdir(dirname(join(repoRoot, capturePath)), { recursive: true });
      await writeFile(
        join(repoRoot, capturePath),
        "export const SUPPORTED_CC_RANGE = { minTested: \"2.1.120\" };\n",
      );

      const result = await runAutoDraft(repoRoot, {
        ccVersion: "2.1.132",
        items: [
          { category: "compat.range", severity: "medium", message: "range" },
        ],
      });

      expect(result).toEqual({
        shouldCreatePr: false,
        changedFiles: [],
        reason: "maxTested field not found",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("skips when maxTested is already current", async () => {
    const repoRoot = await createTempRepo();
    try {
      await writeFile(
        join(repoRoot, capturePath),
        "export const SUPPORTED_CC_RANGE = { minTested: \"2.1.120\", maxTested: \"2.1.132\" };\n",
      );

      const result = await runAutoDraft(repoRoot, {
        ccVersion: "2.1.132",
        items: [
          { category: "compat.range", severity: "medium", message: "range" },
        ],
      });

      expect(result).toEqual({
        shouldCreatePr: false,
        changedFiles: [],
        reason: "maxTested already up to date",
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
