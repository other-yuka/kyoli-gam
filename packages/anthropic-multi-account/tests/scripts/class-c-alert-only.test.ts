import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(
  join(packageRoot, "../../.github/workflows/claude-code-billing-claim-canary.yml"),
  "utf8",
);

describe("Class C billing canary lifecycle", () => {
  test("can manage alerts but cannot create PRs, write code, or release", () => {
    expect(workflow).toMatch(/permissions:\n\s+contents: read\n\s+issues: write/);
    expect(workflow).toContain("gh issue create");
    expect(workflow).toContain("gh issue edit");
    expect(workflow).toContain("gh issue close");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toMatch(/\bgh pr\b/);
    expect(workflow).not.toMatch(/\bchangeset\b/i);
  });
});
