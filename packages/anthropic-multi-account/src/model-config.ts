import { loadCCDerivedRequestProfile } from "./cc-derived-profile";
import { ANTHROPIC_OAUTH_ADAPTER } from "./constants";

export interface ModelOverride {
  exclude?: string[];
  add?: string[];
}

export interface ModelConfig {
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
  baseBetas: splitBetaFlags(ANTHROPIC_OAUTH_ADAPTER.requestBetaHeader),
  longContextBetas: ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"],
  modelOverrides: {
    "4-6": {
      add: ["effort-2025-11-24"],
    },
  },
};

export function getCliVersion(): string {
  return loadCCDerivedRequestProfile().cliVersion;
}

export function getUserAgent(): string {
  return loadCCDerivedRequestProfile().userAgent;
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
