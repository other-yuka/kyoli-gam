type JsonRecord = Record<string, unknown>;

export interface RuntimeModelCapability {
  maxOutputTokens?: number;
  supportsThinking?: boolean;
}

const runtimeModelCapabilities = new Map<string, RuntimeModelCapability>();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase();
  const slashIndex = trimmed.indexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

function readLimitOutput(raw: JsonRecord): number | undefined {
  const limit = isRecord(raw.limit) ? raw.limit : undefined;
  const capabilityLimit = isRecord(raw.capabilities) && isRecord(raw.capabilities.limit)
    ? raw.capabilities.limit
    : undefined;
  return readNumber(limit?.output) ?? readNumber(capabilityLimit?.output);
}

function readThinkingSupport(raw: JsonRecord): boolean | undefined {
  return readBoolean(raw.reasoning)
    ?? readBoolean(raw.thinking)
    ?? readBoolean(raw.supportsThinking)
    ?? (isRecord(raw.capabilities)
      ? readBoolean(raw.capabilities.reasoning)
        ?? readBoolean(raw.capabilities.thinking)
        ?? readBoolean(raw.capabilities.supportsThinking)
      : undefined);
}

export function ingestProviderModelsCapabilities(models: Record<string, unknown>): void {
  runtimeModelCapabilities.clear();

  for (const [key, value] of Object.entries(models)) {
    if (!isRecord(value)) {
      continue;
    }

    const resolvedId = typeof value.id === "string" ? value.id : key;
    const capability: RuntimeModelCapability = {
      maxOutputTokens: readLimitOutput(value),
      supportsThinking: readThinkingSupport(value),
    };

    runtimeModelCapabilities.set(normalizeModelId(resolvedId), capability);
    runtimeModelCapabilities.set(normalizeModelId(key), capability);
  }
}

export function getRuntimeModelCapability(modelId: string): RuntimeModelCapability | undefined {
  return runtimeModelCapabilities.get(normalizeModelId(modelId));
}

export function resetRuntimeModelCapabilitiesForTest(): void {
  runtimeModelCapabilities.clear();
}
