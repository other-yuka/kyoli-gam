import { execFileSync } from "node:child_process";

const DEFAULT_CLI_VERSION = "2.1.100";
const CLI_VERSION_PATTERN = /(\d+\.\d+\.\d+)/;
const CLAUDE_VERSION_TIMEOUT_MS = 3_000;

let detectedVersion: string | null = null;

function parseCliVersion(output: string): string | null {
  return output.match(CLI_VERSION_PATTERN)?.[1] ?? null;
}

export function detectCliVersion(): string {
  if (detectedVersion !== null) {
    return detectedVersion;
  }

  const overriddenVersion = process.env.ANTHROPIC_CLI_VERSION;
  if (overriddenVersion) {
    detectedVersion = overriddenVersion;
    return detectedVersion;
  }

  try {
    const output = execFileSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: CLAUDE_VERSION_TIMEOUT_MS,
    });
    detectedVersion = parseCliVersion(output) ?? DEFAULT_CLI_VERSION;
  } catch {
    detectedVersion = DEFAULT_CLI_VERSION;
  }

  return detectedVersion;
}

export function resetDetectedVersionForTest(): void {
  detectedVersion = null;
}
