export interface EffortCapabilityRejection {
  rejected: string;
  supported: string[];
}

export interface EffortClampResult<TBody> {
  body: TBody;
  changed: boolean;
  modelId?: string;
  effort?: string;
}

export const EFFORT_PREFERENCE = ["xhigh", "max", "high", "medium", "low"] as const;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeEffortValue(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z_-]+$/g, "");
}

export function parseEffortCapabilityRejection(body: string): EffortCapabilityRejection | null {
  const match = /does not support effort level\s+['"`]?([^'"`.\s]+)['"`]?\.?\s*Supported levels:\s*([a-z,\s_-]+)/i.exec(body);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  const supported = match[2]
    .split(",")
    .map(normalizeEffortValue)
    .filter(Boolean);

  return supported.length > 0
    ? { rejected: normalizeEffortValue(match[1]), supported }
    : null;
}

export function bestSupportedEffort(supported: readonly string[]): string {
  for (const effort of EFFORT_PREFERENCE) {
    if (supported.includes(effort)) {
      return effort;
    }
  }

  return supported[0] ?? "high";
}

export function clampUnsupportedEffortInBody<TBody extends BodyInit | null | undefined>(
  body: TBody,
  supportedEffortsByModel: ReadonlyMap<string, readonly string[]>,
): EffortClampResult<TBody | string> {
  if (typeof body !== "string") {
    return { body, changed: false };
  }

  try {
    const parsed = JSON.parse(body) as unknown;
    const record = readRecord(parsed);
    const modelId = typeof record?.model === "string" ? record.model : undefined;
    const outputConfig = readRecord(record?.output_config);
    const effort = typeof outputConfig?.effort === "string" ? outputConfig.effort : undefined;
    if (!modelId || !outputConfig || !effort) {
      return { body, changed: false, modelId };
    }

    const supported = supportedEffortsByModel.get(modelId);
    if (!supported || supported.includes(effort)) {
      return { body, changed: false, modelId, effort };
    }

    const clamped = bestSupportedEffort(supported);
    outputConfig.effort = clamped;
    return { body: JSON.stringify(record), changed: true, modelId, effort: clamped };
  } catch {
    return { body, changed: false };
  }
}

export function clampEffortAfterRejection<TBody extends BodyInit | null | undefined>(
  body: TBody,
  rejection: EffortCapabilityRejection,
  supportedEffortsByModel: Map<string, string[]>,
): EffortClampResult<TBody | string> {
  if (typeof body !== "string") {
    return { body, changed: false };
  }

  try {
    const parsed = JSON.parse(body) as unknown;
    const record = readRecord(parsed);
    const modelId = typeof record?.model === "string" ? record.model : undefined;
    const outputConfig = readRecord(record?.output_config);
    const effort = typeof outputConfig?.effort === "string" ? outputConfig.effort : undefined;
    if (!modelId || !outputConfig || !effort) {
      return { body, changed: false, modelId };
    }

    supportedEffortsByModel.set(modelId, [...rejection.supported]);
    if (rejection.supported.includes(effort)) {
      return { body, changed: false, modelId, effort };
    }

    const clamped = bestSupportedEffort(rejection.supported);
    outputConfig.effort = clamped;
    return { body: JSON.stringify(record), changed: true, modelId, effort: clamped };
  } catch {
    return { body, changed: false };
  }
}
