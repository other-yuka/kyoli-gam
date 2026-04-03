import { ANTHROPIC_OAUTH_ADAPTER } from "./constants";

export interface ModelOverride {
  exclude?: string[];
  add?: string[];
}

export interface ModelConfig {
  ccVersion: string;
  baseBetas: string[];
  longContextBetas: string[];
  modelOverrides: Record<string, ModelOverride>;
}

function splitBetaFlags(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config: ModelConfig = {
  ccVersion: ANTHROPIC_OAUTH_ADAPTER.cliVersion,
  baseBetas: splitBetaFlags(ANTHROPIC_OAUTH_ADAPTER.requestBetaHeader),
  longContextBetas: ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"],
  modelOverrides: {
    "4-6": {
      add: ["effort-2025-11-24"],
    },
  },
};

export function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion;
}

export function getUserAgent(): string {
  if (process.env.ANTHROPIC_USER_AGENT) {
    return process.env.ANTHROPIC_USER_AGENT;
  }

  if (process.env.ANTHROPIC_CLI_VERSION) {
    return `claude-cli/${getCliVersion()} (external, cli)`;
  }

  return ANTHROPIC_OAUTH_ADAPTER.cliUserAgent;
}

export function getRequiredBetas(): string[] {
  return splitBetaFlags(process.env.ANTHROPIC_BETA_FLAGS ?? config.baseBetas.join(","));
}

export function getModelOverride(modelId: string): ModelOverride | null {
  const lowerModelId = modelId.toLowerCase();
  for (const [pattern, override] of Object.entries(config.modelOverrides)) {
    if (lowerModelId.includes(pattern)) {
      return override;
    }
  }

  return null;
}
