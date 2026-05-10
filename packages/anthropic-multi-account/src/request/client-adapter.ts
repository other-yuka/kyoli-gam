const MAX_TOOL_RESULT_TEXT_LENGTH = 30 * 1024;
const TRUNCATION_SUFFIX = "[...truncated]";

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

export type JsonRecord = Record<string, unknown>;

export type ContentBlock = JsonRecord & {
  type?: string;
  name?: string;
  text?: string;
  content?: unknown;
};

export type Message = JsonRecord & {
  role?: string;
  content?: string | ContentBlock[];
};

export interface AdaptedClientRequest {
  body: JsonRecord;
  firstUserMessage: string;
  messages: Message[];
  systemTexts: string[];
}

export function normalizeAnthropicClientRequest(inputBody: JsonRecord): AdaptedClientRequest {
  const body = structuredClone(inputBody);
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

  compactMessageContent(messages);
  removeEmptyTurns(messages);
  trimTrailingEmptyTurns(messages);
  body.messages = messages;
  stripUnsupportedSamplingFields(body);
  stripThinkingControlFields(body);

  return {
    body,
    firstUserMessage: extractFirstUserMessage(messages),
    messages,
    systemTexts,
  };
}

export function sanitizeMessages(body: JsonRecord): void {
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

    message.content = message.content.filter((block) => {
      return !isRecord(block) || block.type !== "text" || block.text !== "";
    });
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

export function truncateToolResultText(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_TOOL_RESULT_TEXT_LENGTH)}${TRUNCATION_SUFFIX}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
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

  block.content = block.content
    .map((item) => {
      if (isRecord(item) && typeof item.text === "string") {
        return {
          ...item,
          text: truncateToolResultText(sanitizeAndScrubText(item.text)),
        };
      }

      return item;
    })
    .filter((item) => !isRecord(item) || typeof item.text !== "string" || item.text.trim().length > 0);
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

    if (block.type === "tool_use" || block.type === "tool_result") {
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

function removeEmptyTurns(messages: Message[]): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && hasMeaningfulContent(message.content)) {
      continue;
    }

    messages.splice(index, 1);
  }
}

function compactMessageContent(messages: Message[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }

    message.content = message.content.filter((block) => {
      if (!isRecord(block)) {
        return false;
      }

      if (block.type === "text") {
        return typeof block.text !== "string" || block.text.trim().length > 0;
      }

      return true;
    });
  }
}

function stripUnsupportedSamplingFields(body: JsonRecord): void {
  delete body.temperature;
  delete body.top_p;
  delete body.top_k;
}

function stripThinkingControlFields(body: JsonRecord): void {
  delete body.thinking;
  delete body.context_management;
  delete body.output_config;
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

export {
  MAX_TOOL_RESULT_TEXT_LENGTH,
  ORCHESTRATION_TAG_NAMES,
  TRUNCATION_SUFFIX,
};
