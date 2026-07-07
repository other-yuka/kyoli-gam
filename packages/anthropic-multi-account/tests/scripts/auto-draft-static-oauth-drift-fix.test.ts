import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  applyCompatRangeFix,
  branchNameForVersion,
  classifyDriftReport,
  replaceBundledFingerprintVersion,
  replaceMaxTested,
} from "../../scripts/auto-draft-static-oauth-drift-fix.mjs";

const tempDirs: string[] = [];

function makeTempPackageRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "kyoli-drift-auto-"));
  tempDirs.push(repoRoot);
  const packageRoot = join(repoRoot, "packages/anthropic-multi-account");
  mkdirSync(join(packageRoot, "src/claude-code/fingerprint"), { recursive: true });
  mkdirSync(join(repoRoot, "packages/providers/claude-code/src/fingerprint"), { recursive: true });
  writeFileSync(
    join(packageRoot, "src/claude-code/fingerprint/capture.ts"),
    `export const SUPPORTED_CC_RANGE = {\n  min: "1.0.0",\n  maxTested: "2.1.161",\n} as const;\n`,
  );
  for (const path of [
    join(packageRoot, "src/claude-code/fingerprint/data.json"),
    join(repoRoot, "packages/providers/claude-code/src/fingerprint/data.json"),
  ]) {
    writeFileSync(path, `{\n  "cc_version": "2.1.161",\n  "header_values": {\n    "user-agent": "claude-cli/2.1.161 (external, sdk-cli)"\n  }\n}\n`);
  }
  return { repoRoot, packageRoot };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("auto-draft static OAuth drift fix", () => {
  test("classifies compat.range-only drift as auto-draftable", () => {
    const result = classifyDriftReport({
      drift: true,
      ccVersion: "2.1.162",
      items: [{ category: "compat.range" }],
    });

    expect(result.shouldCreatePr).toBe(true);
    expect(result.shouldOpenIssue).toBe(false);
    expect(result.branchName).toBe("bot/cc-drift-v2.1.162");
    expect(result.prTitle).toContain("2.1.162");
  });

  test("keeps OAuth drift human-gated", () => {
    const result = classifyDriftReport({
      drift: true,
      ccVersion: "2.1.162",
      items: [{ category: "compat.range" }, { category: "oauth.clientId" }],
    });

    expect(result.shouldCreatePr).toBe(false);
    expect(result.shouldOpenIssue).toBe(true);
    expect(result.reason).toContain("manual drift review");
  });

  test("updates maxTested without touching the supported minimum", () => {
    const updated = replaceMaxTested(
      `const range = { min: "1.0.0", maxTested: "2.1.161" }`,
      "2.1.162",
    );

    expect(updated).toContain(`min: "1.0.0"`);
    expect(updated).toContain(`maxTested: "2.1.162"`);
  });

  test("updates bundled fingerprint version metadata", () => {
    const updated = replaceBundledFingerprintVersion(
      `{\n  "cc_version": "2.1.161",\n  "header_values": {\n    "user-agent": "claude-cli/2.1.161 (external, sdk-cli)"\n  }\n}\n`,
      "2.1.162",
    );

    expect(updated).toContain(`"cc_version": "2.1.162"`);
    expect(updated).toContain(`"user-agent": "claude-cli/2.1.162 (external, sdk-cli)"`);
  });

  test("applies a compat.range fix and writes a patch changeset", () => {
    const { repoRoot, packageRoot } = makeTempPackageRoot();
    const result = applyCompatRangeFix({
      drift: true,
      checkedAt: "2026-06-04T00:00:00Z",
      ccVersion: "2.1.162",
      items: [{ category: "compat.range" }],
    }, { packageRootPath: packageRoot });

    expect(result.changedFiles).toEqual([
      "packages/anthropic-multi-account/src/claude-code/fingerprint/capture.ts",
      "packages/anthropic-multi-account/src/claude-code/fingerprint/data.json",
      "packages/providers/claude-code/src/fingerprint/data.json",
      ".changeset/claude-code-2-1-162-drift.md",
    ]);
    expect(readFileSync(join(packageRoot, "src/claude-code/fingerprint/capture.ts"), "utf8"))
      .toContain(`maxTested: "2.1.162"`);
    expect(readFileSync(join(packageRoot, "src/claude-code/fingerprint/data.json"), "utf8"))
      .toContain(`claude-cli/2.1.162`);
    expect(readFileSync(join(repoRoot, "packages/providers/claude-code/src/fingerprint/data.json"), "utf8"))
      .toContain(`"cc_version": "2.1.162"`);
    expect(readFileSync(join(repoRoot, ".changeset/claude-code-2-1-162-drift.md"), "utf8"))
      .toContain("opencode-anthropic-multi-account");
    expect(readFileSync(join(repoRoot, "pr-body.md"), "utf8"))
      .toContain("compat.range");
  });

  test("sanitizes branch names from version strings", () => {
    expect(branchNameForVersion("2.1.162+build/meta")).toBe("bot/cc-drift-v2.1.162-build-meta");
  });
});
