import { createHash, randomUUID } from "node:crypto";
import type { ClaudeIdentity } from "./claude-identity";
import type { TemplateData } from "./fingerprint-capture";

const BILLING_SEED = "59cf53e54c78";
const DEFAULT_CC_VERSION = "2.1.100";
const SESSION_IDLE_ROTATE_MS = 15 * 60 * 1000;
const MAX_TOOL_RESULT_TEXT_LENGTH = 30 * 1024;
const TRUNCATION_SUFFIX = "[...truncated]";
const DEFAULT_CONTEXT_MANAGEMENT = {};
const DEFAULT_OUTPUT_CONFIG = {};
const ORCHESTRATION_TAG_NAMES = [
  "system-reminder",
  "env",
  "system_information",
  "current_working_directory",
  "operating_system",
  "default_shell",
  "home_directory",
  "task_metadata",
  "directories",
  "thinking",
  "agent_persona",
  "agent_context",
  "tool_context",
  "persona",
  "tool_call",
] as const;
const ORCHESTRATION_PATTERNS = ORCHESTRATION_TAG_NAMES.flatMap((tag) => [
  new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"),
  new RegExp(`<${tag}\\b[^>]*/>`, "gi"),
]);
const FRAMEWORK_PATTERNS: RegExp[] = [
  /\b(roo[- ]?cline|roo[- ]?code|big[- ]?agi|claude[- ]?bridge|amazon\s+q)\b/gi,
  /\b(openclaw|hermes|aider|cursor|windsurf|cline|continue|copilot|cody)\b/gi,
  /\b(zed|plandex|tabby|opencode|daytona)\b/gi,
  /\b(librechat|typingmind)\b/gi,
  /\b(openai|gpt-4|gpt-3\.5)\b/gi,
  /powered by [a-z]+/gi,
  /\bgateway\b/gi,
  /\bsessions_[a-z_]+\b/gi,
];

type JsonRecord = Record<string, unknown>;

type ContentBlock = JsonRecord & {
  type?: string;
  name?: string;
  text?: string;
  content?: unknown;
};

type Message = JsonRecord & {
  role?: string;
  content?: string | ContentBlock[];
};

type ReverseLookup = Map<string, string> | Record<string, string> | undefined;

interface UpstreamRequestTestOverrides {
  now?: () => number;
  createSessionId?: () => string;
}

let upstreamRequestTestOverrides: UpstreamRequestTestOverrides = {};
let sessionId: string = randomUUID();
let sessionLastUsed = 0;

function now(): number {
  return upstreamRequestTestOverrides.now?.() ?? Date.now();
}

function createSessionId(): string {
  return upstreamRequestTestOverrides.createSessionId?.() ?? randomUUID();
}

function getActiveSessionId(): string {
  const currentTime = now();

  if (sessionLastUsed === 0 || (currentTime - sessionLastUsed) > SESSION_IDLE_ROTATE_MS) {
    sessionId = createSessionId();
  }

  sessionLastUsed = currentTime;
  return sessionId;
}

export function getUpstreamSessionId(): string {
  return getActiveSessionId();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function cloneBody<T>(value: T): T {
  return structuredClone(value);
}

function sanitizeContent(text: string): string {
  let result = text;

  for (const pattern of ORCHESTRATION_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "");
  }

  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function sanitizeAndScrubText(text: string): string {
  return scrubFrameworkIdentifiers(sanitizeContent(text))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripCacheControl(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      stripCacheControl(item);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  delete value.cache_control;

  for (const nested of Object.values(value)) {
    stripCacheControl(nested);
  }
}

function sanitizeMessageBlock(block: ContentBlock): void {
  if (typeof block.text === "string") {
    block.text = sanitizeAndScrubText(block.text);
  }

  if (block.type !== "tool_result") {
    return;
  }

  if (typeof block.content === "string") {
    block.content = truncateToolResultText(sanitizeAndScrubText(block.content));
    return;
  }

  if (!Array.isArray(block.content)) {
    return;
  }

  for (const item of block.content) {
    if (isRecord(item) && typeof item.text === "string") {
      item.text = truncateToolResultText(sanitizeAndScrubText(item.text));
    }
  }
}

function stripAssistantThinkingBlocks(messages: Message[]): void {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    message.content = message.content.filter((block) => block.type !== "thinking");
  }
}

function hasMeaningfulContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((block) => {
    if (!isRecord(block)) {
      return false;
    }

     if (block.type === "tool_use") {
      return true;
    }

    if (typeof block.text === "string" && block.text.trim().length > 0) {
      return true;
    }

    if (typeof block.content === "string" && block.content.trim().length > 0) {
      return true;
    }

    return false;
  });
}

function trimTrailingEmptyTurns(messages: Message[]): void {
  while (messages.length > 0) {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || hasMeaningfulContent(lastMessage.content)) {
      return;
    }

    messages.pop();
  }
}

function normalizeSystemTexts(system: unknown): string[] {
  if (typeof system === "string") {
    const next = sanitizeAndScrubText(system);
    return next ? [next] : [];
  }

  if (!Array.isArray(system)) {
    return [];
  }

  const texts: string[] = [];

  for (const entry of system) {
    if (typeof entry === "string") {
      const next = sanitizeAndScrubText(entry);
      if (next) {
        texts.push(next);
      }
      continue;
    }

    if (isRecord(entry) && typeof entry.text === "string") {
      const next = sanitizeAndScrubText(entry.text);
      if (next) {
        texts.push(next);
      }
    }
  }

  return texts;
}

function filterInjectedSystemTexts(
  systemTexts: string[],
  template: TemplateData,
  billingHeader: string,
): string[] {
  return systemTexts.filter((entry) => (
    entry !== billingHeader
    && entry !== template.agent_identity
    && entry !== template.system_prompt
    && !entry.startsWith("x-anthropic-billing-header:")
  ));
}

function extractFirstUserMessage(messages: Message[] | undefined): string {
  if (!Array.isArray(messages)) {
    return "";
  }

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    if (typeof message.content === "string") {
      return message.content;
    }

    if (!Array.isArray(message.content)) {
      return "";
    }

    const text = message.content
      .filter((block) => typeof block.text === "string")
      .map((block) => block.text)
      .join("\n\n")
      .trim();

    return text;
  }

  return "";
}

function hasCompleteToolSchemas(tools: Array<{ [key: string]: unknown }>): boolean {
  return tools.length > 0
    && tools.every((tool) => typeof tool === "object" && tool !== null && "input_schema" in tool);
}

function enrichIncomingToolsWithTemplateSchemas(
  incomingTools: Array<{ [key: string]: unknown }>,
  templateTools: Array<{ [key: string]: unknown }>,
): Array<{ [key: string]: unknown }> {
  if (!hasCompleteToolSchemas(templateTools) || incomingTools.length !== templateTools.length) {
    return incomingTools;
  }

  return incomingTools.map((tool, index) => {
    if ("input_schema" in tool) {
      return tool;
    }

    const templateTool = templateTools[index];
    return templateTool && "input_schema" in templateTool
      ? { ...tool, input_schema: templateTool.input_schema }
      : tool;
  });
}

function buildOutboundTools(
  incomingTools: Array<{ [key: string]: unknown }>,
  templateTools: Array<{ [key: string]: unknown }>,
): Array<{ [key: string]: unknown }> {
  if (incomingTools.length > 0) {
    return enrichIncomingToolsWithTemplateSchemas(incomingTools, templateTools);
  }

  if (!hasCompleteToolSchemas(templateTools)) {
    return incomingTools;
  }

  return templateTools.map((tool) => ({ ...tool }));
}

function getCcVersion(template: TemplateData): string {
  return template.cc_version ?? DEFAULT_CC_VERSION;
}

function buildBillingHeader(firstUserMessage: string, template: TemplateData): string {
  const version = getCcVersion(template);
  const buildTag = computeBuildTag(firstUserMessage, version);
  return `x-anthropic-billing-header: cc_version=${version}.${buildTag}; cc_entrypoint=cli; cch=00000;`;
}

function truncateToolResultText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_TOOL_RESULT_TEXT_LENGTH)}${TRUNCATION_SUFFIX}`;
}

function getReverseName(name: string, reverseLookup: ReverseLookup): string {
  if (!reverseLookup) {
    return name;
  }

  if (reverseLookup instanceof Map) {
    return reverseLookup.get(name) ?? name;
  }

  return typeof reverseLookup[name] === "string" ? String(reverseLookup[name]) : name;
}

function reverseMapToolUseNames(value: unknown, reverseLookup: ReverseLookup): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reverseMapToolUseNames(item, reverseLookup));
  }

  if (!isRecord(value)) {
    return value;
  }

  const cloned: JsonRecord = {};

  for (const [key, nested] of Object.entries(value)) {
    cloned[key] = reverseMapToolUseNames(nested, reverseLookup);
  }

  if (cloned.type === "tool_use" && typeof cloned.name === "string") {
    cloned.name = getReverseName(cloned.name, reverseLookup);
  }

  return cloned;
}

function remapSseLine(line: string, reverseLookup: ReverseLookup): string {
  if (!line.startsWith("data:")) {
    return line;
  }

  const payload = line.slice(5).trimStart();
  if (payload.length === 0 || payload === "[DONE]") {
    return line;
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    return `data: ${JSON.stringify(reverseMapResponse(parsed, reverseLookup))}`;
  } catch {
    return line;
  }
}

export function sanitizeMessages(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }

    if (typeof message.content === "string") {
      message.content = sanitizeContent(message.content);
      continue;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      if (isRecord(block) && typeof block.text === "string") {
        block.text = sanitizeContent(block.text);
      }
    }
  }
}

export function scrubFrameworkIdentifiers(text: string): string {
  let result = text;

  for (const pattern of FRAMEWORK_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, ...args: unknown[]) => {
      const offset = args.at(-2);
      const source = args.at(-1);

      if (typeof offset !== "number" || typeof source !== "string") {
        return match;
      }

      const before = offset > 0 ? source[offset - 1] ?? "" : "";
      const after = (offset + match.length) < source.length ? source[offset + match.length] ?? "" : "";

      if (before === "." || before === "/" || before === "\\" || before === "-" || before === "_") {
        return match;
      }

      if (after === "/" || after === "\\") {
        return match;
      }

      return "";
    });
  }

  return result;
}

export function computeBuildTag(userMessage: string, version: string): string {
  const chars = [4, 7, 20].map((index) => userMessage[index] ?? "0").join("");
  return createHash("sha256")
    .update(`${BILLING_SEED}${chars}${version}`)
    .digest("hex")
    .slice(0, 3);
}

export function buildUpstreamRequest(
  inputBody: Record<string, unknown>,
  identity: ClaudeIdentity,
  template: TemplateData,
  options?: { sessionId?: string },
): Record<string, unknown> {
  const body = cloneBody(inputBody);
  const messages = Array.isArray(body.messages) ? body.messages as Message[] : [];
  const systemTexts = normalizeSystemTexts(body.system);

  stripCacheControl(body);
  sanitizeMessages(body);
  stripAssistantThinkingBlocks(messages);

  for (const message of messages) {
    if (typeof message.content === "string") {
      message.content = sanitizeAndScrubText(message.content);
      continue;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      sanitizeMessageBlock(block);
    }

  }

  trimTrailingEmptyTurns(messages);

  const firstUserMessage = extractFirstUserMessage(messages);
  const billingHeader = buildBillingHeader(firstUserMessage, template);
  const mergedSystemPrompt = [
    template.system_prompt,
    ...filterInjectedSystemTexts(systemTexts, template, billingHeader),
  ]
    .map((entry) => sanitizeAndScrubText(entry))
    .filter(Boolean)
    .join("\n\n");
  const activeSessionId = options?.sessionId ?? getActiveSessionId();

  body.messages = messages;

  const incomingTools = Array.isArray(body.tools) ? body.tools as Array<{ [key: string]: unknown }> : [];
  body.tools = buildOutboundTools(incomingTools, template.tools);
  body.system = [
    {
      type: "text",
      text: billingHeader,
    },
    {
      type: "text",
      text: template.agent_identity,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: mergedSystemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];
  body.metadata = {
    ...(isRecord(body.metadata) ? body.metadata : {}),
    user_id: JSON.stringify({
      device_id: identity.deviceId,
      account_uuid: identity.accountUuid,
      session_id: activeSessionId,
    }),
  };
  body.thinking = { type: "adaptive" };
  body.context_management = DEFAULT_CONTEXT_MANAGEMENT;
  body.output_config = DEFAULT_OUTPUT_CONFIG;
  body.max_tokens = 64_000;

  return orderBodyForOutbound(body, template.body_field_order);
}

export function orderBodyForOutbound(
  body: Record<string, unknown>,
  overrideOrder?: string[],
): Record<string, unknown> {
  if (!Array.isArray(overrideOrder) || overrideOrder.length === 0) return body;

  const ordered: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const name of overrideOrder) {
    if (seen.has(name)) continue;
    if (Object.prototype.hasOwnProperty.call(body, name)) {
      ordered[name] = body[name];
      seen.add(name);
    }
  }

  for (const k of Object.keys(body)) {
    if (!seen.has(k)) ordered[k] = body[k];
  }

  return ordered;
}

export function reverseMapResponse<T>(response: T, reverseLookup?: ReverseLookup): T {
  return reverseMapToolUseNames(response, reverseLookup) as T;
}

export function createStreamingReverseMapper(response: Response, reverseLookup?: ReverseLookup): Response {
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            buffer += decoder.decode();
            if (buffer) {
              const lines = buffer.split("\n").map((line) => remapSseLine(line, reverseLookup));
              controller.enqueue(encoder.encode(lines.join("\n")));
              buffer = "";
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          if (lines.length > 0) {
            const remapped = `${lines.map((line) => remapSseLine(line, reverseLookup)).join("\n")}\n`;
            controller.enqueue(encoder.encode(remapped));
            return;
          }
        }
      } catch (error) {
        try {
          await reader.cancel();
        } catch {
        }
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function setUpstreamRequestTestOverridesForTest(overrides: UpstreamRequestTestOverrides | null): void {
  upstreamRequestTestOverrides = overrides ?? {};
}

export function resetUpstreamRequestForTest(): void {
  upstreamRequestTestOverrides = {};
  sessionId = randomUUID();
  sessionLastUsed = 0;
}

export {
  BILLING_SEED,
  MAX_TOOL_RESULT_TEXT_LENGTH,
  SESSION_IDLE_ROTATE_MS,
  TRUNCATION_SUFFIX,
};
