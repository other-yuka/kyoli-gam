import { CredentialUnavailableError, createCachedModelList, type ModelInfo } from "@kyoli-gam/core";

const CODEX_BACKEND_API_BASE = "https://chatgpt.com/backend-api";
const CODEX_MODELS_ENDPOINT = `${CODEX_BACKEND_API_BASE}/codex/models`;
const CODEX_CLIENT_VERSION = "0.0.0";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_USER_AGENT = "codex_cli_rs/0.0.0";
const CODEX_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

const GPT_5_6_REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balanced reasoning" },
  { effort: "high", description: "Deeper reasoning" },
  { effort: "xhigh", description: "Extra deep reasoning" },
  { effort: "max", description: "Maximum reasoning" },
];

export const FALLBACK_CODEX_MODELS: ModelInfo[] = [
  codexModel("gpt-5.6-sol", "GPT-5.6 Sol", { supported_reasoning_levels: GPT_5_6_REASONING_LEVELS }),
  codexModel("gpt-5.6-terra", "GPT-5.6 Terra", { supported_reasoning_levels: GPT_5_6_REASONING_LEVELS }),
  codexModel("gpt-5.6-luna", "GPT-5.6 Luna", { supported_reasoning_levels: GPT_5_6_REASONING_LEVELS }),
  codexModel("gpt-5.5", "GPT-5.5"),
  codexModel("gpt-5.4", "GPT-5.4"),
  codexModel("gpt-5.4-mini", "GPT-5.4 Mini"),
  codexModel("gpt-5.3-codex", "GPT-5.3 Codex"),
  codexModel("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"),
  codexModel("gpt-5.2", "GPT-5.2"),
];

export interface CodexModelCatalogCredential {
  value: string;
  accountId?: string;
  chatgptAccountId?: string;
}

export interface CodexModelCatalogOptions {
  fetchImpl: typeof fetch;
  selectCredential: (excludeAccountIds: string[]) => Promise<CodexModelCatalogCredential | undefined>;
}

type JsonRecordValue = null | boolean | number | string | JsonRecordValue[] | { [key: string]: JsonRecordValue };

export function createCodexModelCatalog(options: CodexModelCatalogOptions) {
  return createCachedModelList({
    ttlMs: CODEX_MODEL_CATALOG_TTL_MS,
    fetchLive: () => fetchCodexModelCatalog(options),
    fallback: () => FALLBACK_CODEX_MODELS,
  });
}

function codexModel(upstreamId: string, displayName: string, metadata?: Record<string, unknown>): ModelInfo {
  return {
    id: `openai/${upstreamId}`,
    provider: "codex",
    upstreamId,
    displayName,
    aliases: [upstreamId, `codex/${upstreamId}`],
    capabilities: ["chat", "responses", "tools", "streaming", "reasoning", "codex"],
    metadata,
  };
}

async function fetchCodexModelCatalog(input: CodexModelCatalogOptions): Promise<ModelInfo[]> {
  const excludedAccountIds: string[] = [];
  let lastAccessError: Error | undefined;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const excludedCount = excludedAccountIds.length;
    const credential = await input.selectCredential(excludedAccountIds).catch((error) => {
      if (error instanceof CredentialUnavailableError) {
        pushUnique(excludedAccountIds, error.accountId);
        return undefined;
      }
      throw error;
    });
    if (!credential) {
      if (excludedAccountIds.length > excludedCount) continue;
      if (lastAccessError) throw lastAccessError;
      return [];
    }

    const result = await fetchCodexModelCatalogWithCredential(input, credential);
    if (result.ok) return result.models;
    lastAccessError = result.error;
    if (!credential.accountId) throw lastAccessError;
    pushUnique(excludedAccountIds, credential.accountId);
  }

  if (lastAccessError) throw lastAccessError;
  return [];
}

async function fetchCodexModelCatalogWithCredential(
  input: CodexModelCatalogOptions,
  credential: CodexModelCatalogCredential,
): Promise<
  | { ok: true; models: ModelInfo[] }
  | { ok: false; error: Error }
> {
  const url = new URL(CODEX_MODELS_ENDPOINT);
  url.searchParams.set("client_version", CODEX_CLIENT_VERSION);
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${credential.value}`,
    originator: CODEX_ORIGINATOR,
    "user-agent": CODEX_USER_AGENT,
  };
  if (credential.chatgptAccountId) headers["ChatGPT-Account-ID"] = credential.chatgptAccountId;

  const response = await input.fetchImpl(url, { headers }).catch(() => undefined);
  if (!response) return { ok: true, models: [] };
  if (response.status === 401 || response.status === 403) {
    const payload = await response.json().catch(() => undefined);
    return {
      ok: false,
      error: createCodexModelCatalogError(
        readCodexModelCatalogErrorMessage(payload) ?? `Codex model catalog failed with ${response.status}`,
        response.status,
      ),
    };
  }
  if (!response.ok) return { ok: true, models: [] };

  const payload = await response.json().catch(() => undefined);
  return { ok: true, models: mapCodexModelCatalog(payload) };
}

function readCodexModelCatalogErrorMessage(payload: unknown): string | undefined {
  const record = readRecord(payload);
  const error = readRecord(record?.error);
  return readString(error?.message) ?? readString(record?.message);
}

function createCodexModelCatalogError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status, code: "codex_model_catalog_error" });
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function mapCodexModelCatalog(payload: unknown): ModelInfo[] {
  const models = readRecord(payload)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map(mapCodexModelEntry)
    .filter((model): model is ModelInfo => Boolean(model));
}

function mapCodexModelEntry(value: unknown): ModelInfo | undefined {
  const record = readRecord(value);
  const upstreamId = readString(record?.slug) ?? readString(record?.model) ?? readString(record?.id);
  if (!record || !upstreamId) return undefined;
  if (record.supported_in_api === false) return undefined;
  if (["hide", "none"].includes(readString(record.visibility)?.toLowerCase() ?? "")) return undefined;

  const capabilities: ModelInfo["capabilities"] = ["chat", "responses", "streaming", "codex"];
  if (record.supports_parallel_tool_calls === true || readArray(record.experimental_supported_tools).length > 0) {
    capabilities.push("tools");
  }
  if (readArray(record.supported_reasoning_levels).length > 0 || record.default_reasoning_level) {
    capabilities.push("reasoning");
  }

  return {
    id: `openai/${upstreamId}`,
    provider: "codex",
    upstreamId,
    displayName: readString(record.display_name) ?? upstreamId,
    aliases: [upstreamId, `codex/${upstreamId}`],
    capabilities,
    metadata: filterJsonRecord(record),
  };
}

function filterJsonRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, JsonRecordValue] => isJsonRecordValue(entry[1])),
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
    ? (value as Record<string, unknown>)
    : undefined;
}

function isJsonRecordValue(value: unknown): value is JsonRecordValue {
  if (value === null) return true;
  if (["boolean", "number", "string"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonRecordValue);
  return Boolean(readRecord(value)) && Object.values(value as Record<string, unknown>).every(isJsonRecordValue);
}
