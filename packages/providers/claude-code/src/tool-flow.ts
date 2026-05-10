import { createHash } from "node:crypto";
import { isClaudeCodeTemplateToolName } from "./fingerprint-template";

type JsonRecord = Record<string, unknown>;
type ToolEntry = { name?: string; [key: string]: unknown };

interface ClaudeToolPayload {
  tools?: ToolEntry[];
  messages?: Array<Record<string, unknown>>;
  tool_choice?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ReverseToolLookup = Map<string, string>;

const TOOL_MASK_PREFIX = "tool_";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function shouldMaskToolName(name: string | undefined): name is string {
  return Boolean(
    name &&
      !name.startsWith("mcp__") &&
      !name.startsWith(TOOL_MASK_PREFIX) &&
      !isClaudeCodeTemplateToolName(name),
  );
}

function maskToolName(name: string): string {
  const digest = createHash("sha256").update(`claude-code-tool:${name}`).digest("hex").slice(0, 10);
  return `${TOOL_MASK_PREFIX}${digest}`;
}

function collectToolNames(payload: ClaudeToolPayload): string[] {
  const names = new Set<string>();

  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools) {
      if (typeof tool.name === "string") names.add(tool.name);
    }
  }

  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      if (!isRecord(message) || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
          names.add(block.name);
        }
      }
    }
  }

  if (
    isRecord(payload.tool_choice) &&
    payload.tool_choice.type === "tool" &&
    typeof payload.tool_choice.name === "string"
  ) {
    names.add(payload.tool_choice.name);
  }

  return [...names];
}

function buildLookup(payload: ClaudeToolPayload): {
  originalToOutgoing: Map<string, string>;
  outgoingToOriginal: ReverseToolLookup;
} {
  const originalToOutgoing = new Map<string, string>();
  const outgoingToOriginal: ReverseToolLookup = new Map();
  const used = new Set<string>();

  for (const original of collectToolNames(payload)) {
    const outgoingBase = shouldMaskToolName(original) ? maskToolName(original) : original;
    let outgoing = outgoingBase;
    let suffix = 1;

    while (used.has(outgoing) && originalToOutgoing.get(original) !== outgoing) {
      outgoing = `${outgoingBase}_${suffix}`;
      suffix += 1;
    }

    originalToOutgoing.set(original, outgoing);
    outgoingToOriginal.set(outgoing, original);
    used.add(outgoing);
  }

  return { originalToOutgoing, outgoingToOriginal };
}

function outgoingName(name: string | undefined, lookup: Map<string, string>): string | undefined {
  if (!name) return name;
  return lookup.get(name) ?? name;
}

function originalName(name: string | undefined, lookup: ReverseToolLookup): string | undefined {
  if (!name) return name;
  return lookup.get(name) ?? name;
}

function rewriteToolUseNames(value: unknown, lookup: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteToolUseNames(item, lookup));
  if (!isRecord(value)) return value;

  const next: JsonRecord = {};
  for (const [key, nested] of Object.entries(value)) {
    next[key] = rewriteToolUseNames(nested, lookup);
  }

  if (next.type === "tool_use" && typeof next.name === "string") {
    next.name = outgoingName(next.name, lookup);
  }

  return next;
}

function reverseToolUseNames(value: unknown, lookup: ReverseToolLookup): unknown {
  if (Array.isArray(value)) return value.map((item) => reverseToolUseNames(item, lookup));
  if (!isRecord(value)) return value;

  const next: JsonRecord = {};
  for (const [key, nested] of Object.entries(value)) {
    next[key] = reverseToolUseNames(nested, lookup);
  }

  if (next.type === "tool_use" && typeof next.name === "string") {
    next.name = originalName(next.name, lookup);
  }

  return next;
}

export function applyClaudeToolFlow(payload: ClaudeToolPayload): {
  payload: ClaudeToolPayload;
  reverseLookup: ReverseToolLookup;
} {
  const lookup = buildLookup(payload);
  const next: ClaudeToolPayload = { ...payload };

  if (Array.isArray(payload.tools)) {
    next.tools = payload.tools.map((tool) => ({
      ...tool,
      name: outgoingName(tool.name, lookup.originalToOutgoing),
    }));
  }

  if (Array.isArray(payload.messages)) {
    next.messages = payload.messages.map((message) => {
      if (!isRecord(message) || !Array.isArray(message.content)) return message;
      return {
        ...message,
        content: rewriteToolUseNames(message.content, lookup.originalToOutgoing),
      };
    });
  }

  if (isRecord(payload.tool_choice) && payload.tool_choice.type === "tool") {
    next.tool_choice = {
      ...payload.tool_choice,
      name: outgoingName(payload.tool_choice.name as string | undefined, lookup.originalToOutgoing),
    };
  }

  return { payload: next, reverseLookup: lookup.outgoingToOriginal };
}

export function reverseClaudeToolFlow<T>(payload: T, lookup: ReverseToolLookup): T {
  if (lookup.size === 0) return payload;
  return reverseToolUseNames(payload, lookup) as T;
}
