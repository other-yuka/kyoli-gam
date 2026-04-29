import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;
type ToolEntry = { name?: string; [key: string]: unknown };
type RequestPayload = {
  tools?: ToolEntry[];
  messages?: Array<Record<string, unknown>>;
  tool_choice?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ReverseLookup = Map<string, string>;

const TOOL_MASK_PREFIX = "tool_";

type ToolFlowLookup = {
  originalToOutgoing: Map<string, string>;
  outgoingToOriginal: ReverseLookup;
};

type OutgoingNameRegistry = {
  usedOutgoing: Set<string>;
  reservedOriginals: ReadonlySet<string>;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function shouldMaskToolName(
  name: string | undefined,
  claudeToolNames: ReadonlySet<string>,
  options: { preserveToolPrefix: boolean },
): name is string {
  if (!name) {
    return false;
  }

  return !claudeToolNames.has(name)
    && !name.startsWith("mcp__")
    && (!options.preserveToolPrefix || !name.startsWith(TOOL_MASK_PREFIX));
}

function buildMaskedToolName(toolName: string, length = 8): string {
  const digest = createHash("sha256")
    .update(`tool-mask:${toolName}`)
    .digest("hex")
    .slice(0, length);

  return `${TOOL_MASK_PREFIX}${digest}`;
}

function isOutgoingNameAvailable(name: string, registry: OutgoingNameRegistry): boolean {
  return !registry.usedOutgoing.has(name) && !registry.reservedOriginals.has(name);
}

function buildAvailableMaskedToolName(toolName: string, registry: OutgoingNameRegistry): string {
  for (let length = 8; length <= 64; length += 2) {
    const masked = buildMaskedToolName(toolName, length);
    if (isOutgoingNameAvailable(masked, registry)) {
      return masked;
    }
  }

  const fullDigestName = buildMaskedToolName(toolName, 64);
  for (let suffix = 1; suffix <= 1_024; suffix += 1) {
    const masked = `${fullDigestName}_${suffix}`;
    if (isOutgoingNameAvailable(masked, registry)) {
      return masked;
    }
  }

  return `${fullDigestName}_${registry.usedOutgoing.size + registry.reservedOriginals.size}`;
}

function collectCurrentToolNames(parsed: RequestPayload): string[] {
  const names = new Set<string>();

  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (isRecord(tool) && typeof tool.name === "string") {
        names.add(tool.name);
      }
    }
  }

  return [...names];
}

function collectReferencedToolNames(parsed: RequestPayload): string[] {
  const names = new Set<string>();

  if (Array.isArray(parsed.messages)) {
    for (const message of parsed.messages) {
      if (!isRecord(message) || !Array.isArray(message.content)) {
        continue;
      }

      for (const block of message.content) {
        if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
          names.add(block.name);
        }
      }
    }
  }

  if (isRecord(parsed.tool_choice) && parsed.tool_choice.type === "tool" && typeof parsed.tool_choice.name === "string") {
    names.add(parsed.tool_choice.name);
  }

  return [...names];
}

function buildClaudeToolNameSet(claudeToolNames: readonly string[]): ReadonlySet<string> {
  return new Set(claudeToolNames.filter((name) => typeof name === "string" && name.length > 0));
}

export function buildRequestScopedToolLookup(
  parsed: RequestPayload,
  claudeToolNames: readonly string[],
): ReverseLookup {
  return buildToolFlowLookup(parsed, claudeToolNames).outgoingToOriginal;
}

function buildToolFlowLookup(
  parsed: RequestPayload,
  claudeToolNames: readonly string[],
): ToolFlowLookup {
  const originalToOutgoing = new Map<string, string>();
  const outgoingToOriginal: ReverseLookup = new Map();
  const registry: OutgoingNameRegistry = {
    usedOutgoing: new Set<string>(),
    reservedOriginals: new Set(collectCurrentToolNames(parsed)),
  };
  const claudeToolSet = buildClaudeToolNameSet(claudeToolNames);

  const registerCurrent = (originalName: string) => {
    if (originalToOutgoing.has(originalName)) {
      return;
    }

    if (!shouldMaskToolName(originalName, claudeToolSet, { preserveToolPrefix: false })) {
      originalToOutgoing.set(originalName, originalName);
      outgoingToOriginal.set(originalName, originalName);
      registry.usedOutgoing.add(originalName);
      return;
    }

    const masked = buildAvailableMaskedToolName(originalName, registry);

    originalToOutgoing.set(originalName, masked);
    outgoingToOriginal.set(masked, originalName);
    registry.usedOutgoing.add(masked);
  };

  const registerReference = (originalName: string) => {
    if (originalToOutgoing.has(originalName) || outgoingToOriginal.has(originalName)) {
      return;
    }

    if (!shouldMaskToolName(originalName, claudeToolSet, { preserveToolPrefix: true })) {
      originalToOutgoing.set(originalName, originalName);
      outgoingToOriginal.set(originalName, originalName);
      registry.usedOutgoing.add(originalName);
      return;
    }

    const masked = buildAvailableMaskedToolName(originalName, registry);
    originalToOutgoing.set(originalName, masked);
    outgoingToOriginal.set(masked, originalName);
    registry.usedOutgoing.add(masked);
  };

  for (const originalName of collectCurrentToolNames(parsed)) {
    registerCurrent(originalName);
  }

  for (const originalName of collectReferencedToolNames(parsed)) {
    registerReference(originalName);
  }

  return { originalToOutgoing, outgoingToOriginal };
}

function getOutgoingName(name: string | undefined, lookup: ToolFlowLookup): string | undefined {
  if (!name) {
    return name;
  }

  if (lookup.outgoingToOriginal.has(name)) {
    return name;
  }

  return lookup.originalToOutgoing.get(name) ?? name;
}

function getOriginalName(name: string, reverseLookup: ReverseLookup): string {
  return reverseLookup.get(name) ?? name;
}

function rewriteToolUseNames(value: unknown, lookup: ToolFlowLookup): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteToolUseNames(item, lookup));
  }

  if (!isRecord(value)) {
    return value;
  }

  const cloned: JsonRecord = {};
  for (const [key, nested] of Object.entries(value)) {
    cloned[key] = rewriteToolUseNames(nested, lookup);
  }

  if (cloned.type === "tool_use" && typeof cloned.name === "string") {
    cloned.name = getOutgoingName(cloned.name, lookup);
  }

  return cloned;
}

function reverseToolUseNames(value: unknown, reverseLookup: ReverseLookup): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reverseToolUseNames(item, reverseLookup));
  }

  if (!isRecord(value)) {
    return value;
  }

  const cloned: JsonRecord = {};
  for (const [key, nested] of Object.entries(value)) {
    cloned[key] = reverseToolUseNames(nested, reverseLookup);
  }

  if (cloned.type === "tool_use" && typeof cloned.name === "string") {
    cloned.name = getOriginalName(cloned.name, reverseLookup);
  }

  return cloned;
}

export function applyOutboundToolFlow(
  parsed: RequestPayload,
  claudeToolNames: readonly string[],
): { body: string; reverseLookup: ReverseLookup } {
  const lookup = buildToolFlowLookup(parsed, claudeToolNames);
  const next: RequestPayload = { ...parsed };

  if (Array.isArray(parsed.tools)) {
    next.tools = parsed.tools.map((tool) => ({
      ...tool,
      name: getOutgoingName(tool.name, lookup),
    }));
  }

  if (Array.isArray(parsed.messages)) {
    next.messages = parsed.messages.map((message) => {
      if (!isRecord(message) || !Array.isArray(message.content)) {
        return message;
      }

      return {
        ...message,
        content: rewriteToolUseNames(message.content, lookup),
      };
    });
  }

  if (isRecord(parsed.tool_choice) && parsed.tool_choice.type === "tool") {
    next.tool_choice = {
      ...parsed.tool_choice,
      name: getOutgoingName(parsed.tool_choice.name as string | undefined, lookup),
    };
  }

  return {
    body: JSON.stringify(next),
    reverseLookup: lookup.outgoingToOriginal,
  };
}

export function reverseToolFlowPayload<T>(value: T, reverseLookup?: ReverseLookup): T {
  if (!reverseLookup || reverseLookup.size === 0) {
    return value;
  }

  return reverseToolUseNames(value, reverseLookup) as T;
}
