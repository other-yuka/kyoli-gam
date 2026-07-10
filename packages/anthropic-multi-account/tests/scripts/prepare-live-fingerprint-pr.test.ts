import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  prepareLiveFingerprintPullRequest,
} from "../../scripts/prepare-live-fingerprint-pr.mjs";

const tempDirs: string[] = [];

function fingerprint(version: string) {
  return {
    _version: 1,
    _captured: "2026-07-10T00:00:00Z",
    _source: "live",
    agent_identity: "Claude Code",
    system_prompt: "system",
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    tool_names: ["Read"],
    cc_version: version,
    anthropic_beta: "oauth-2025-04-20",
    header_order: ["User-Agent"],
    header_values: { "user-agent": `claude-cli/${version}` },
    body_field_order: ["model", "messages"],
  };
}

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "kyoli-live-pr-"));
  tempDirs.push(repoRoot);
  const bundledPath = join(repoRoot, "packages/providers/claude-code/src/fingerprint/data.json");
  mkdirSync(join(repoRoot, "packages/providers/claude-code/src/fingerprint"), { recursive: true });
  writeFileSync(bundledPath, `${JSON.stringify(fingerprint("2.1.205"), null, 2)}\n`);
  return { repoRoot, bundledPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("prepare live fingerprint PR", () => {
  test("writes a Class A label-only update and machine-identifiable changeset", () => {
    const { repoRoot, bundledPath } = tempRepo();
    const captured = {
      ...fingerprint("2.1.206"),
      _captured: "2026-07-11T00:00:00Z",
      _source: "live",
      _schemaVersion: 99,
    };
    const result = prepareLiveFingerprintPullRequest({
      className: "A",
      report: { classification: "label-only", summary: { actualCcVersion: "2.1.206" } },
      capturedFingerprint: captured,
      repoRoot,
      bundledPath,
      runId: "12345",
      runUrl: "https://github.com/other-yuka/kyoli-gam/actions/runs/12345",
    });

    expect(JSON.parse(readFileSync(bundledPath, "utf8"))).toEqual(fingerprint("2.1.206"));
    expect(result).toMatchObject({
      className: "A",
      branchName: "bot/claude-fingerprint-a-2.1.206-12345",
      changedFiles: [
        "packages/providers/claude-code/src/fingerprint/data.json",
        ".changeset/claude-code-auto-a-2-1-206-12345.md",
      ],
    });
    expect(readFileSync(join(repoRoot, result.changesetPath), "utf8"))
      .toContain('"opencode-anthropic-multi-account": patch');
    expect(readFileSync(join(repoRoot, result.prBodyPath), "utf8"))
      .toContain("Class A");
  });

  test("prepares Class B metadata without replacing the rebaked fingerprint", () => {
    const { repoRoot, bundledPath } = tempRepo();
    writeFileSync(bundledPath, `${JSON.stringify(fingerprint("2.1.206"), null, 2)}\n`);

    const result = prepareLiveFingerprintPullRequest({
      className: "B",
      report: { classification: "shape", summary: { actualCcVersion: "2.1.206" } },
      capturedFingerprint: fingerprint("2.1.206"),
      repoRoot,
      bundledPath,
      runId: "999",
    });

    expect(JSON.parse(readFileSync(bundledPath, "utf8"))).toEqual(fingerprint("2.1.206"));
    expect(result.branchName).toBe("bot/claude-fingerprint-b-2.1.206-999");
    expect(result.changesetPath).toBe(".changeset/claude-code-auto-b-2-1-206-999.md");
  });

  test("rejects an update whose report and capture target versions disagree", () => {
    const { repoRoot, bundledPath } = tempRepo();

    expect(() => prepareLiveFingerprintPullRequest({
      className: "A",
      report: { classification: "label-only", summary: { actualCcVersion: "2.1.206" } },
      capturedFingerprint: fingerprint("2.1.207"),
      repoRoot,
      bundledPath,
      runId: "12345",
    })).toThrow("Captured fingerprint version does not match");
  });

  test("rejects Class C before it can create a PR or changeset", () => {
    const { repoRoot, bundledPath } = tempRepo();

    expect(() => prepareLiveFingerprintPullRequest({
      className: "C",
      report: { classification: "shape", summary: { actualCcVersion: "2.1.206" } },
      capturedFingerprint: fingerprint("2.1.206"),
      repoRoot,
      bundledPath,
      runId: "12345",
    })).toThrow("Unsupported Claude Code update class: C");
  });
});
