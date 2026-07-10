import { claudeCodeIntegration } from "../claude-code";
import { ANTHROPIC_OAUTH_ADAPTER } from "../shared/constants";

export const FABLE_FALLBACK_CREDIT_BETA = "fallback-credit-2026-06-01";
export const MID_CONVERSATION_SYSTEM_BETA = "mid-conversation-system-2026-04-07";
export const EFFORT_BETA = "effort-2025-11-24";

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
  longContextBetas: ["context-1m-2025-08-07", "context-management-2025-06-27"],
  modelOverrides: {
    fable: {
      add: [FABLE_FALLBACK_CREDIT_BETA],
    },
    "sonnet-5": {
      add: [EFFORT_BETA],
    },
    sonnet: {
      exclude: [MID_CONVERSATION_SYSTEM_BETA],
      add: [EFFORT_BETA],
    },
    haiku: {
      exclude: [MID_CONVERSATION_SYSTEM_BETA, EFFORT_BETA],
    },
    "4-6": {
      add: [EFFORT_BETA],
    },
  },
};

export function getCliVersion(): string {
  return claudeCodeIntegration.loadRequestProfile().cliVersion;
}

export function getUserAgent(): string {
  return claudeCodeIntegration.loadRequestProfile().userAgent;
}

export function getRequiredBetas(): string[] {
  return splitBetaFlags(
    process.env.ANTHROPIC_BETA_FLAGS
      ?? claudeCodeIntegration.loadRequestProfile().betaHeader
      ?? config.baseBetas.join(","),
  );
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
