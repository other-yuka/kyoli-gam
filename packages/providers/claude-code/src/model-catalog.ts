import { CredentialUnavailableError, type ModelInfo } from "@kyoli-gam/core";
import {
  aliasesForClaudeCodeModel,
  CLAUDE_FABLE_MODEL_ID,
  CLAUDE_SONNET_MODEL_ID,
  compareClaudeCodeBaseModelIds,
  isClaudeCode1mModelLabel,
  isSuspendedClaudeCodeModel,
  longContextEligible,
  modelFamily,
  resetCachedClaudeCodeBaseModelsForTest,
  setCachedClaudeCodeBaseModels,
  stripClaudeCodeContext1mTag,
} from "./model-aliases";

const ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_CODE_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const MIN_GENERATION = 4;

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
  baseUrl: string;
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
  setCachedClaudeCodeBaseModels(baseIds);
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
  const url = new URL(`${options.baseUrl}/v1/models`);
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

export function _resetClaudeCodeModelCatalogForTest(): void {
  cachedBaseEntries = [...FALLBACK_CLAUDE_CODE_BASE_MODELS];
  resetCachedClaudeCodeBaseModelsForTest();
}

function compareClaudeCodeBaseModels(a: ClaudeCodeCatalogEntry | string, b: ClaudeCodeCatalogEntry | string): number {
  const aId = typeof a === "string" ? a : a.id;
  const bId = typeof b === "string" ? b : b.id;
  return compareClaudeCodeBaseModelIds(aId, bId);
}

function modelVersionKey(id: string): number[] {
  return id.match(/\d+/g)?.map(Number) ?? [];
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
