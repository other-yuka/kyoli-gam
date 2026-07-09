type JsonRecord = Record<string, unknown>;

const ZERO_COST = { input: 0, output: 0, cache: { read: 0, write: 0 } };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModels(provider: unknown): Record<string, unknown> {
  return isRecord(provider) && isRecord(provider.models) ? provider.models : {};
}

export async function zeroCostProviderModels(provider: unknown): Promise<Record<string, any>> {
  return Object.fromEntries(
    Object.entries(readModels(provider)).map(([id, model]) => [
      id,
      isRecord(model) ? { ...model, cost: ZERO_COST } : model,
    ]),
  );
}
