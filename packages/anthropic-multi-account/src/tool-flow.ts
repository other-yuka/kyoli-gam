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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function shouldMaskToolName(name: string | undefined, claudeToolNames: ReadonlySet<string>): name is string {
  if (!name) {
    return false;
  }

  return !claudeToolNames.has(name)
    && !name.startsWith("mcp__")
    && !name.startsWith(TOOL_MASK_PREFIX);
}

function extractFirstUserText(parsed: RequestPayload): string {
  if (!Array.isArray(parsed.messages)) {
    return "";
  }

  const firstUser = parsed.messages.find((message) => message.role === "user");
  if (!isRecord(firstUser)) {
    return "";
  }

  const content = firstUser.content;
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n\n")
    .trim();
}

function buildMaskedToolName(seed: string, toolName: string, length = 8): string {
  const digest = createHash("sha256")
    .update(`tool-mask:${seed}:${toolName}`)
    .digest("hex")
    .slice(0, length);

  return `${TOOL_MASK_PREFIX}${digest}`;
}

function collectToolNames(parsed: RequestPayload): string[] {
  const names = new Set<string>();

  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (isRecord(tool) && typeof tool.name === "string") {
        names.add(tool.name);
      }
    }
  }

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
  const lookup: ReverseLookup = new Map();
  const usedOutgoing = new Set<string>();
  const seed = extractFirstUserText(parsed);
  const claudeToolSet = buildClaudeToolNameSet(claudeToolNames);

  for (const originalName of collectToolNames(parsed)) {
    if (!shouldMaskToolName(originalName, claudeToolSet)) {
      lookup.set(originalName, originalName);
      usedOutgoing.add(originalName);
      continue;
    }

    let length = 8;
    let masked = buildMaskedToolName(seed, originalName, length);
    while (usedOutgoing.has(masked)) {
      length += 2;
      masked = buildMaskedToolName(seed, originalName, length);
    }

    lookup.set(masked, originalName);
    usedOutgoing.add(masked);
  }

  return lookup;
}

function getOutgoingName(name: string | undefined, reverseLookup: ReverseLookup): string | undefined {
  if (!name) {
    return name;
  }

  for (const [outgoing, original] of reverseLookup) {
    if (original === name) {
      return outgoing;
    }
  }

  return name;
}

function rewriteToolUseNames(value: unknown, reverseLookup: ReverseLookup): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteToolUseNames(item, reverseLookup));
  }

  if (!isRecord(value)) {
    return value;
  }

  const cloned: JsonRecord = {};
  for (const [key, nested] of Object.entries(value)) {
    cloned[key] = rewriteToolUseNames(nested, reverseLookup);
  }

  if (cloned.type === "tool_use" && typeof cloned.name === "string") {
    cloned.name = getOutgoingName(cloned.name, reverseLookup);
  }

  return cloned;
}

export function applyOutboundToolFlow(
  parsed: RequestPayload,
  claudeToolNames: readonly string[],
): { body: string; reverseLookup: ReverseLookup } {
  const reverseLookup = buildRequestScopedToolLookup(parsed, claudeToolNames);
  const next: RequestPayload = { ...parsed };

  if (Array.isArray(parsed.tools)) {
    next.tools = parsed.tools.map((tool) => ({
      ...tool,
      name: getOutgoingName(tool.name, reverseLookup),
    }));
  }

  if (Array.isArray(parsed.messages)) {
    next.messages = parsed.messages.map((message) => {
      if (!isRecord(message) || !Array.isArray(message.content)) {
        return message;
      }

      return {
        ...message,
        content: rewriteToolUseNames(message.content, reverseLookup),
      };
    });
  }

  if (isRecord(parsed.tool_choice) && parsed.tool_choice.type === "tool") {
    next.tool_choice = {
      ...parsed.tool_choice,
      name: getOutgoingName(parsed.tool_choice.name as string | undefined, reverseLookup),
    };
  }

  return {
    body: JSON.stringify(next),
    reverseLookup,
  };
}

export function reverseToolFlowPayload<T>(value: T, reverseLookup?: ReverseLookup): T {
  if (!reverseLookup || reverseLookup.size === 0) {
    return rewriteToolUseNames(value, new Map()) as T;
  }

  return rewriteToolUseNames(value, reverseLookup) as T;
}
