import { config, getModelOverride, getRequiredBetas } from "./model-config";

export const LONG_CONTEXT_BETAS = config.longContextBetas;
export const OAUTH_BETA = "oauth-2025-04-20";

const excludedBetas = new Map<string, Set<string>>();

let lastBetaFlagsEnv = process.env.ANTHROPIC_BETA_FLAGS;
let lastModelId: string | undefined;

export function getExcludedBetas(modelId: string): Set<string> {
  const currentBetaFlags = process.env.ANTHROPIC_BETA_FLAGS;
  if (currentBetaFlags !== lastBetaFlagsEnv) {
    excludedBetas.clear();
    lastBetaFlagsEnv = currentBetaFlags;
  }

  if (lastModelId !== undefined && lastModelId !== modelId) {
    excludedBetas.clear();
  }
  lastModelId = modelId;

  return excludedBetas.get(modelId) ?? new Set();
}

export function addExcludedBeta(modelId: string, beta: string): void {
  const nextExcludedBetas = excludedBetas.get(modelId) ?? new Set<string>();
  nextExcludedBetas.add(beta);
  excludedBetas.set(modelId, nextExcludedBetas);
}

export function resetExcludedBetas(): void {
  excludedBetas.clear();
  lastModelId = undefined;
  lastBetaFlagsEnv = process.env.ANTHROPIC_BETA_FLAGS;
}

export function isLongContextError(responseBody: string): boolean {
  return responseBody.includes("Extra usage is required for long context requests")
    || responseBody.includes("long context beta is not yet available");
}

export function isUnexpectedBetaError(responseBody: string): boolean {
  return responseBody.includes("Unexpected value") && responseBody.includes("anthropic-beta");
}

export function extractRejectedBetas(responseBody: string): string[] {
  const match = /Unexpected value\(s\):\s*([^\n]+?)\s*for the anthropic-beta header/i.exec(responseBody);
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(",")
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

export function ensureOauthBeta(betas: string[]): string[] {
  return betas.includes(OAUTH_BETA) ? betas : [OAUTH_BETA, ...betas];
}

export function getNextBetaToExclude(modelId: string): string | null {
  const excluded = getExcludedBetas(modelId);
  for (const beta of LONG_CONTEXT_BETAS) {
    if (!excluded.has(beta)) {
      return beta;
    }
  }

  return null;
}

export function supports1mContext(modelId: string): boolean {
  const lowerModelId = modelId.toLowerCase();
  if (!lowerModelId.includes("opus") && !lowerModelId.includes("sonnet")) {
    return false;
  }

  const versionMatch = lowerModelId.match(/(opus|sonnet)-(\d+)-(\d+)/);
  if (!versionMatch) {
    return false;
  }

  const major = Number.parseInt(versionMatch[2] ?? "0", 10);
  const minor = Number.parseInt(versionMatch[3] ?? "0", 10);
  const effectiveMinor = minor > 99 ? 0 : minor;
  return major > 4 || (major === 4 && effectiveMinor >= 6);
}

export function getModelBetas(modelId: string, excluded?: Set<string>): string[] {
  const betas = [...getRequiredBetas()];
  const longContextBeta = config.longContextBetas[0];

  if (
    longContextBeta
    && process.env.ANTHROPIC_ENABLE_1M_CONTEXT === "true"
    && supports1mContext(modelId)
  ) {
    betas.push(longContextBeta);
  }

  const override = getModelOverride(modelId);
  if (override?.exclude) {
    for (const excludedBeta of override.exclude) {
      const index = betas.indexOf(excludedBeta);
      if (index !== -1) {
        betas.splice(index, 1);
      }
    }
  }

  if (override?.add) {
    for (const addedBeta of override.add) {
      if (!betas.includes(addedBeta)) {
        betas.push(addedBeta);
      }
    }
  }

  if (!excluded || excluded.size === 0) {
    return betas;
  }

  return betas.filter((beta) => !excluded.has(beta));
}
