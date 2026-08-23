import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  CLAUDE_CODE_VERSION_PATTERN,
  compareClaudeCodeVersions,
} from "./claude-code-version-utils.mjs";

export function selectSupersededClaudeCodeIssueNumbers(issues, targetVersion, exactTitle = "") {
  if (!CLAUDE_CODE_VERSION_PATTERN.test(targetVersion)) return [];
  return (Array.isArray(issues) ? issues : [])
    .filter((issue) => {
      const title = issue?.title ?? "";
      if (exactTitle && title === exactTitle) return true;
      const version = /v(\d+\.\d+\.\d+)/.exec(title)?.[1];
      return version && compareClaudeCodeVersions(version, targetVersion) <= 0;
    })
    .map((issue) => issue.number)
    .filter((number) => Number.isInteger(number));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const issues = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const targetVersion = process.argv[3] ?? "";
  const exactTitle = process.argv[4] ?? "";
  for (const number of selectSupersededClaudeCodeIssueNumbers(issues, targetVersion, exactTitle)) {
    process.stdout.write(`${number}\n`);
  }
}
