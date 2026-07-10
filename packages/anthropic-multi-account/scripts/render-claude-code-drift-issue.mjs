import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const defaultWorkflowPath = ".github/workflows/claude-code-drift-watch.yml";

function formatReport(report) {
  return JSON.stringify(report, null, 2);
}

function resolveWorkflowRunUrl(env = process.env) {
  const serverUrl = env.GITHUB_SERVER_URL;
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;

  if (!serverUrl || !repository || !runId) {
    return null;
  }

  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

function buildClaudeCodeDriftIssueBody({
  report,
  workflowPath = defaultWorkflowPath,
  workflowRunUrl = resolveWorkflowRunUrl(),
  checkedAt = new Date().toISOString(),
} = {}) {
  const ccVersion = typeof report?.ccVersion === "string" && report.ccVersion
    ? report.ccVersion
    : "unknown";
  const workflowRunSection = workflowRunUrl
    ? `${workflowRunUrl}\n`
    : "Unavailable outside GitHub Actions.\n";

  return `## Claude Code drift

\`${workflowPath}\` detected drift against \`@anthropic-ai/claude-code@${ccVersion}\` on \`${checkedAt}\`.

### How kyoli handles this

Kyoli keeps Claude Code compatibility explicit for both Server Mode and OpenCode Plugin Mode. Compat-range-only drift is sent to exact-version live classification and does not open this issue. This alert is reserved for OAuth URL/client drift, scanner drift, or an unsafe static result because those can affect real-account traffic.

### Fix checklist

- [ ] Install the new Claude Code locally: \`npm install -g @anthropic-ai/claude-code@${ccVersion}\`.
- [ ] Run \`pnpm --dir packages/cli run doctor claude --binary\`.
- [ ] Run \`pnpm --dir packages/cli run doctor claude --template\`, \`pnpm --dir packages/cli run doctor claude --wire\`, and \`pnpm --dir packages/cli run doctor claude --obedience\`.
- [ ] Re-bake only if fingerprint-sensitive fields changed: \`pnpm --dir packages/anthropic-multi-account bake:fingerprint\`.
- [ ] Run \`pnpm --filter opencode-anthropic-multi-account test:contract:native\`.
- [ ] Add a patch changeset for affected packages when a release is needed.

### Workflow run

${workflowRunSection}
### Drift report

\`\`\`json
${formatReport(report)}
\`\`\`
`;
}

export {
  buildClaudeCodeDriftIssueBody,
  resolveWorkflowRunUrl,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reportPath = process.argv[2] ?? "drift-report.json";
  const outputPath = process.argv[3] ?? "issue-body.md";
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  writeFileSync(outputPath, buildClaudeCodeDriftIssueBody({ report }));
}
