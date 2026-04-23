import { execFileSync as defaultExecFileSync } from "node:child_process";
import bundledFingerprintData from "./fingerprint/data.json";

export const DEFAULT_CLI_VERSION = bundledFingerprintData.cc_version;
const CLI_VERSION_PATTERN = /(\d+\.\d+\.\d+)/;
const CLAUDE_VERSION_TIMEOUT_MS = 3_000;

type CliVersionProbe = typeof defaultExecFileSync;

let detectedVersion: string | null = null;
let cliVersionProbe: CliVersionProbe = defaultExecFileSync;

function parseCliVersion(output: string): string | null {
  return output.match(CLI_VERSION_PATTERN)?.[1] ?? null;
}

function probeCliVersion(): string {
  return cliVersionProbe("claude", ["--version"], {
    encoding: "utf8",
    timeout: CLAUDE_VERSION_TIMEOUT_MS,
  });
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
    const output = probeCliVersion();
    detectedVersion = parseCliVersion(output) ?? DEFAULT_CLI_VERSION;
  } catch {
    detectedVersion = DEFAULT_CLI_VERSION;
  }

  return detectedVersion;
}

export function resetDetectedVersionForTest(): void {
  detectedVersion = null;
}

export function setCliVersionDetectionOverridesForTest(probe: CliVersionProbe | null): void {
  cliVersionProbe = probe ?? defaultExecFileSync;
}
