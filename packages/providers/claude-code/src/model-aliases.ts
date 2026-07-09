const MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
const FAMILY_RANK: Record<string, number> = { fable: 0, opus: 1, sonnet: 2, haiku: 3 };

export const CLAUDE_FABLE_MODEL_ID = "claude-fable-5";
export const CLAUDE_FABLE_1M_MODEL_ID = `${CLAUDE_FABLE_MODEL_ID}[1m]`;
export const CLAUDE_SONNET_MODEL_ID = "claude-sonnet-5";
export const CLAUDE_SONNET_1M_MODEL_ID = `${CLAUDE_SONNET_MODEL_ID}[1m]`;

export const FALLBACK_CLAUDE_CODE_BASE_MODEL_IDS = [
  CLAUDE_FABLE_MODEL_ID,
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  CLAUDE_SONNET_MODEL_ID,
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
] as const;

const STATIC_MODEL_ALIASES: Record<string, string> = {
  opus47: "claude-opus-4-7",
  opus46: "claude-opus-4-6",
  sonnet46: "claude-sonnet-4-6",
};

let cachedBaseModelIds: string[] = [...FALLBACK_CLAUDE_CODE_BASE_MODEL_IDS];

export function setCachedClaudeCodeBaseModels(baseIds: readonly string[]): void {
  cachedBaseModelIds = [...baseIds];
}

export function getCachedClaudeCodeBaseModels(): string[] {
  return [...cachedBaseModelIds];
}

export function resetCachedClaudeCodeBaseModelsForTest(): void {
  cachedBaseModelIds = [...FALLBACK_CLAUDE_CODE_BASE_MODEL_IDS];
}

export function aliasesForClaudeCodeModel(id: string, baseIds: readonly string[]): string[] {
  const aliases = [id, `claude-code/${id}`];
  const stripped = stripClaudeCodeContext1mTag(id);
  const family = modelFamily(stripped);
  if (!family || resolveFamilyBase(family, baseIds) !== stripped) return aliases;

  if (id.endsWith("[1m]")) {
    aliases.push(`${family}1m`, `claude-code/${family}1m`, `anthropic/${family}1m`);
  } else {
    aliases.push(family, `claude-code/${family}`, `anthropic/${family}`);
  }
  return [...new Set(aliases)];
}

export function stripClaudeCodeProviderPrefix(modelId: string): string {
  const slash = modelId.indexOf("/");
  if (slash === -1) return modelId;

  const provider = modelId.slice(0, slash).toLowerCase();
  return provider === "anthropic" || provider === "claude-code"
    ? modelId.slice(slash + 1)
    : modelId;
}

export function resolveClaudeCodeModelAlias(modelId: string): string {
  const unprefixed = stripClaudeCodeProviderPrefix(modelId.trim());
  return resolveAliasAgainst(unprefixed, cachedBaseModelIds) ?? STATIC_MODEL_ALIASES[unprefixed.toLowerCase()] ?? unprefixed;
}

export function stripClaudeCodeContext1mTag(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, "");
}

export function toClaudeCodeWireModelId(modelId: string): string {
  return stripClaudeCodeContext1mTag(resolveClaudeCodeModelAlias(modelId));
}

export function isClaudeCode1mModelLabel(modelId: string): boolean {
  return /\[1m\]$/i.test(resolveClaudeCodeModelAlias(modelId));
}

export function isClaudeFableModel(modelId: string): boolean {
  return resolveClaudeCodeModelAlias(modelId).toLowerCase().includes("fable");
}

export function isSuspendedClaudeCodeModel(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const suspendedFamilies = readSuspendedClaudeCodeFamilies(env);
  const family = modelFamily(resolveClaudeCodeModelAlias(modelId));
  return Boolean(family && suspendedFamilies.has(family));
}

export function describeSuspendedClaudeCodeModel(modelId: string): string {
  const normalized = resolveClaudeCodeModelAlias(modelId);
  if (isClaudeFableModel(normalized)) {
    return "Claude Fable 5 is disabled for this Claude Code provider by configuration.";
  }
  return `${normalized} is temporarily unavailable through Claude Code.`;
}

export function resolveFamilyBase(family: string, baseIds: readonly string[]): string | undefined {
  return baseIds
    .filter((id) => modelFamily(id) === family && !id.includes("["))
    .sort(compareClaudeCodeBaseModelIds)[0];
}

export function longContextEligible(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized.startsWith("claude-") && !normalized.includes("haiku") && !normalized.endsWith("[1m]");
}

export function compareClaudeCodeBaseModelIds(a: string, b: string): number {
  const aRank = FAMILY_RANK[modelFamily(a) ?? ""] ?? 99;
  const bRank = FAMILY_RANK[modelFamily(b) ?? ""] ?? 99;
  if (aRank !== bRank) return aRank - bRank;
  return compareVersionDesc(modelVersionKey(a), modelVersionKey(b));
}

export function modelFamily(id: string): string | undefined {
  const normalized = stripClaudeCodeContext1mTag(stripClaudeCodeProviderPrefix(id)).toLowerCase();
  for (const family of MODEL_FAMILIES) {
    if (normalized.includes(family)) return family;
  }
  return undefined;
}

function resolveAliasAgainst(modelId: string, baseIds: readonly string[]): string | undefined {
  const normalized = stripClaudeCodeProviderPrefix(modelId).trim().toLowerCase();
  if (isModelFamily(normalized)) return resolveFamilyBase(normalized, baseIds) ?? undefined;

  const match = /^([a-z]+)1m$/.exec(normalized);
  if (match?.[1] && isModelFamily(match[1])) {
    const base = resolveFamilyBase(match[1], baseIds);
    return base && longContextEligible(base) ? `${base}[1m]` : undefined;
  }
  return undefined;
}

function isModelFamily(value: string): value is typeof MODEL_FAMILIES[number] {
  return (MODEL_FAMILIES as readonly string[]).includes(value);
}

function modelVersionKey(id: string): number[] {
  return id.match(/\d+/g)?.map(Number) ?? [];
}

function compareVersionDesc(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (b[index] ?? -1) - (a[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

function readSuspendedClaudeCodeFamilies(env: NodeJS.ProcessEnv): Set<string> {
  const raw = env.KYOLI_SUSPENDED_CLAUDE_CODE_FAMILIES
    ?? env.KYOLI_SUSPENDED_CLAUDE_MODELS
    ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .map((entry) => modelFamily(entry) ?? entry),
  );
}
