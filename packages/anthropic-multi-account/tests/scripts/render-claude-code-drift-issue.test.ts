import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(packageRoot, "scripts/render-claude-code-drift-issue.mjs");

describe("render-claude-code-drift-issue", () => {
  test("renders a manual drift issue body from a report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kyoli-drift-issue-"));
    try {
      const reportPath = join(dir, "drift-report.json");
      const bodyPath = join(dir, "issue-body.md");
      await writeFile(reportPath, `${JSON.stringify({
        ccVersion: "2.1.140",
        items: [
          {
            category: "oauth.clientId",
            severity: "high",
            message: "client id changed",
          },
        ],
      }, null, 2)}\n`);

      const result = spawnSync(process.execPath, [scriptPath, reportPath, bodyPath], {
        env: {
          ...process.env,
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "alice/kyoli-gam",
          GITHUB_RUN_ID: "12345",
        },
        encoding: "utf8",
      });

      if (result.status !== 0) {
        throw new Error(`${result.stderr}\n${result.stdout}`);
      }

      const body = await readFile(bodyPath, "utf8");
      expect(body).toContain("Claude Code drift");
      expect(body).toContain("@anthropic-ai/claude-code@2.1.140");
      expect(body).toContain("https://github.com/alice/kyoli-gam/actions/runs/12345");
      expect(body).toContain("oauth.clientId");
      expect(body).toContain("pnpm --dir packages/cli doctor claude --wire");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
