import { CredentialUnavailableError, type ModelInfo } from "@kyoli-gam/core";

const CLAUDE_CODE_MODELS_ENDPOINT = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_CODE_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
const FAMILY_RANK: Record<string, number> = { fable: 0, opus: 1, sonnet: 2, haiku: 3 };
const MIN_GENERATION = 4;

export const CLAUDE_FABLE_MODEL_ID = "claude-fable-5";
export const CLAUDE_FABLE_1M_MODEL_ID = `${CLAUDE_FABLE_MODEL_ID}[1m]`;
export const CLAUDE_SONNET_MODEL_ID = "claude-sonnet-5";
export const CLAUDE_SONNET_1M_MODEL_ID = `${CLAUDE_SONNET_MODEL_ID}[1m]`;

export const FALLBACK_CLAUDE_CODE_BASE_MODELS: readonly ClaudeCodeCatalogEntry[] = [
  { id: CLAUDE_FABLE_MODEL_ID, displayName: "Claude Fable 5" },
  { id: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
  { id: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
  { id: CLAUDE_SONNET_MODEL_ID, displayName: "Claude Sonnet 5" },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
];

export interface ClaudeCodeCatalogEntry {
  id: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
}

export interface ClaudeCodeModelCatalogCredential {
  value: string;
  accountId?: string;
}

export interface ClaudeCodeModelCatalogOptions {
  fetchImpl: typeof fetch;
  selectCredential: (excludeAccountIds: string[]) => Promise<ClaudeCodeModelCatalogCredential | undefined>;
  userAgent?: string;
  xApp?: string;
  anthropicVersion?: string;
  anthropicBeta?: string;
}

type JsonRecordValue = null | boolean | number | string | JsonRecordValue[] | { [key: string]: JsonRecordValue };

let cachedBaseEntries: ClaudeCodeCatalogEntry[] = [...FALLBACK_CLAUDE_CODE_BASE_MODELS];

export function createClaudeCodeModelCatalog(options: ClaudeCodeModelCatalogOptions) {
  let cache: { expiresAt: number; models: ModelInfo[] } | undefined;

  return {
    async listModels() {
      if (!cache || cache.expiresAt <= Date.now()) {
        const liveModels = await fetchClaudeCodeModels(options);
        if (liveModels.length > 0) {
          cache = { expiresAt: Date.now() + CLAUDE_CODE_MODEL_CATALOG_TTL_MS, models: liveModels };
        }
      }
      const models = cache?.models ?? buildAndCacheClaudeCodeModels(FALLBACK_CLAUDE_CODE_BASE_MODELS);
      return models.filter((model) => !isSuspendedClaudeCodeModel(model.upstreamId));
    },
    reset() {
      cache = undefined;
    },
  };
}

export function buildClaudeCodeModels(entries: readonly ClaudeCodeCatalogEntry[]): ModelInfo[] {
  const normalized = normalizeClaudeCodeCatalogEntries(entries);
  cachedBaseEntries = normalized;
  return buildAndCacheClaudeCodeModels(normalized);
}

async function fetchClaudeCodeModels(options: ClaudeCodeModelCatalogOptions): Promise<ModelInfo[]> {
  const entries = await fetchClaudeCodeCatalogEntries(options).catch(() => []);
  return entries.length > 0 ? buildAndCacheClaudeCodeModels(entries) : [];
}

function buildAndCacheClaudeCodeModels(entries: readonly ClaudeCodeCatalogEntry[]): ModelInfo[] {
  cachedBaseEntries = [...entries];
  const baseIds = cachedBaseEntries.map((entry) => entry.id);
  return cachedBaseEntries.flatMap((entry) => {
    const base = toClaudeCodeModelInfo(entry, baseIds);
    return longContextEligible(entry.id)
      ? [base, toClaudeCodeModelInfo({ ...entry, id: `${entry.id}[1m]` }, baseIds)]
      : [base];
  });
}

async function fetchClaudeCodeCatalogEntries(options: ClaudeCodeModelCatalogOptions): Promise<ClaudeCodeCatalogEntry[]> {
  const excludedAccountIds: string[] = [];

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const excludedCount = excludedAccountIds.length;
    const credential = await options.selectCredential(excludedAccountIds).catch((error) => {
      if (error instanceof CredentialUnavailableError) {
        pushUnique(excludedAccountIds, error.accountId);
        return undefined;
      }
      throw error;
    });
    if (!credential) {
      if (excludedAccountIds.length > excludedCount) continue;
      return [];
    }

    const entries = await fetchClaudeCodeCatalogEntriesWithCredential(options, credential);
    if (entries !== undefined) return entries;
    if (!credential.accountId) return [];
    pushUnique(excludedAccountIds, credential.accountId);
  }

  return [];
}

async function fetchClaudeCodeCatalogEntriesWithCredential(
  options: ClaudeCodeModelCatalogOptions,
  credential: ClaudeCodeModelCatalogCredential,
): Promise<ClaudeCodeCatalogEntry[] | undefined> {
  const url = new URL(CLAUDE_CODE_MODELS_ENDPOINT);
  url.searchParams.set("limit", "100");
  const response = await options.fetchImpl(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential.value}`,
      "anthropic-version": options.anthropicVersion ?? ANTHROPIC_VERSION,
      "anthropic-beta": options.anthropicBeta ?? CLAUDE_CODE_BETA,
      ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
      ...(options.xApp ? { "x-app": options.xApp } : {}),
    },
  });
  if (response.status === 401 || response.status === 403) return undefined;
  if (!response.ok) return [];

  const payload = await response.json().catch(() => undefined);
  const rawEntries = readArray(readRecord(payload)?.data)
    .map(readClaudeCodeCatalogEntry)
    .filter((entry): entry is ClaudeCodeCatalogEntry => Boolean(entry));
  return normalizeClaudeCodeCatalogEntries(rawEntries);
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function readClaudeCodeCatalogEntry(value: unknown): ClaudeCodeCatalogEntry | undefined {
  const record = readRecord(value);
  const id = readString(record?.id);
  if (!record || !id) return undefined;
  return {
    id,
    displayName: readString(record.display_name) ?? readString(record.name),
    metadata: filterJsonRecord(record),
  };
}

export function normalizeClaudeCodeCatalogEntries(
  entries: readonly ClaudeCodeCatalogEntry[],
): ClaudeCodeCatalogEntry[] {
  const byKey = new Map<string, ClaudeCodeCatalogEntry>();
  for (const entry of entries) {
    if (!isUsableClaudeCodeBaseModel(entry.id)) continue;
    const key = entry.id.replace(/-\d{8}$/, "").toLowerCase();
    const existing = byKey.get(key);
    if (!existing || entry.id.toLowerCase() === key) {
      byKey.set(key, { ...entry, id: entry.id });
    }
  }
  return [...byKey.values()].sort(compareClaudeCodeBaseModels);
}

function isUsableClaudeCodeBaseModel(id: string): boolean {
  if (!/^claude-/i.test(id) || id.includes("[")) return false;
  const family = modelFamily(id);
  if (!family || family === "fable") return true;
  return (modelVersionKey(id)[0] ?? 0) >= MIN_GENERATION;
}

function toClaudeCodeModelInfo(entry: ClaudeCodeCatalogEntry, baseIds: readonly string[]): ModelInfo {
  const isLongContext = isClaudeCode1mModelLabel(entry.id);
  const metadata = {
    ...(entry.metadata ?? {}),
    ...(isLongContext ? { max_context_window: 1_000_000 } : {}),
  };
  return {
    id: `anthropic/${entry.id}`,
    provider: "claude-code",
    upstreamId: entry.id,
    displayName: isLongContext ? `${displayNameFor(entry)} [1m]` : displayNameFor(entry),
    aliases: aliasesForClaudeCodeModel(entry.id, baseIds),
    capabilities: capabilitiesForClaudeCodeModel(entry.id),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function aliasesForClaudeCodeModel(id: string, baseIds: readonly string[]): string[] {
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

function capabilitiesForClaudeCodeModel(id: string): ModelInfo["capabilities"] {
  const capabilities: ModelInfo["capabilities"] = ["messages", "tools", "streaming", "claude-code"];
  const family = modelFamily(id);
  if (family !== "haiku") capabilities.push("reasoning");
  return capabilities;
}

function displayNameFor(entry: ClaudeCodeCatalogEntry): string {
  return entry.displayName ?? entry.id
    .replace(/\[1m\]$/i, "")
    .replace(/^claude-/, "Claude ")
    .split("-")
    .map((part) => part ? part[0]?.toUpperCase() + part.slice(1) : part)
    .join(" ");
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
  return resolveAliasAgainst(unprefixed, getCachedClaudeCodeBaseModels()) ?? STATIC_MODEL_ALIASES[unprefixed.toLowerCase()] ?? unprefixed;
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

export function getCachedClaudeCodeBaseModels(): string[] {
  return cachedBaseEntries.map((entry) => entry.id);
}

export function _resetClaudeCodeModelCatalogForTest(): void {
  cachedBaseEntries = [...FALLBACK_CLAUDE_CODE_BASE_MODELS];
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

function resolveFamilyBase(family: string, baseIds: readonly string[]): string | undefined {
  return baseIds
    .filter((id) => modelFamily(id) === family && !id.includes("["))
    .sort(compareClaudeCodeBaseModels)[0];
}

function longContextEligible(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized.startsWith("claude-") && !normalized.includes("haiku") && !normalized.endsWith("[1m]");
}

function compareClaudeCodeBaseModels(a: ClaudeCodeCatalogEntry | string, b: ClaudeCodeCatalogEntry | string): number {
  const aId = typeof a === "string" ? a : a.id;
  const bId = typeof b === "string" ? b : b.id;
  const aRank = FAMILY_RANK[modelFamily(aId) ?? ""] ?? 99;
  const bRank = FAMILY_RANK[modelFamily(bId) ?? ""] ?? 99;
  if (aRank !== bRank) return aRank - bRank;
  return compareVersionDesc(modelVersionKey(aId), modelVersionKey(bId));
}

function modelFamily(id: string): string | undefined {
  const normalized = stripClaudeCodeContext1mTag(stripClaudeCodeProviderPrefix(id)).toLowerCase();
  for (const family of MODEL_FAMILIES) {
    if (normalized.includes(family)) return family;
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

const STATIC_MODEL_ALIASES: Record<string, string> = {
  opus47: "claude-opus-4-7",
  opus46: "claude-opus-4-6",
  sonnet46: "claude-sonnet-4-6",
};

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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function filterJsonRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, JsonRecordValue] => isJsonRecordValue(entry[1])),
  );
}

function isJsonRecordValue(value: unknown): value is JsonRecordValue {
  if (value === null) return true;
  if (["boolean", "number", "string"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonRecordValue);
  return Boolean(readRecord(value)) && Object.values(value as Record<string, unknown>).every(isJsonRecordValue);
}
