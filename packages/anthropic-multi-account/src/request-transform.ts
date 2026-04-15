import { createHash } from "node:crypto";
import {
  ANTHROPIC_OAUTH_ADAPTER,
} from "./constants";
import { getModelBetas } from "./betas";
import { getUserAgent } from "./model-config";
import { INJECTED_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./anthropic-prompt";

export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function getInjectedSystemPrompt(): string {
  return INJECTED_SYSTEM_PROMPT;
}

function sampleCodeUnits(text: string, indices: number[]): string {
  return indices
    .map((i) => (i < text.length ? text.charCodeAt(i).toString(16) : "30"))
    .join("");
}

export function buildBillingHeader(firstUserMessage: string): string {
  const version = ANTHROPIC_OAUTH_ADAPTER.cliVersion;
  const salt = ANTHROPIC_OAUTH_ADAPTER.billingSalt;
  if (!version || !salt) return "";

  const sampled = sampleCodeUnits(firstUserMessage, [4, 7, 20]);
  const hash = createHash("sha256")
    .update(`${salt}${sampled}${version}`)
    .digest("hex")
    .slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${version}.${hash}; cc_entrypoint=cli; cch=00000;`;
}

const OPENCODE_CAMEL_RE = /OpenCode/g;
const OPENCODE_LOWER_RE = /(?<!\/)opencode/gi;
const TOOL_MASK_PREFIX = "tool_";
const PARAGRAPH_REMOVAL_ANCHORS = [
  "github.com/anomalyco/opencode",
  "opencode.ai/docs",
] as const;
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const DOCUMENTED_BUILTIN_TOOL_NAMES = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "ListMcpResourcesTool",
  "LSP",
  "Monitor",
  "NotebookEdit",
  "PowerShell",
  "Read",
  "ReadMcpResourceTool",
  "SendMessage",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TeamCreate",
  "TeamDelete",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
]);

type TextContentBlock = { type: string; text?: string; [key: string]: unknown };
type SystemTextEntry = { type: string; text?: string; [key: string]: unknown };
type ToolEntry = { name?: string; type?: string; [key: string]: unknown };
type MessageContentBlock = { type: string; name?: string; text?: string; [key: string]: unknown };
type ToolChoice = { type?: string; name?: string; [key: string]: unknown };
type MessageEntry = {
  role?: string;
  content?: string | MessageContentBlock[];
  [key: string]: unknown;
};
type RequestPayload = {
  system?: unknown;
  tools?: ToolEntry[];
  messages?: MessageEntry[];
  tool_choice?: ToolChoice;
};

type NormalizedSystemEntry = SystemTextEntry & { type: "text"; text: string };
type ToolMaskMap = Map<string, string>;

function isTypedTool(tool: ToolEntry): boolean {
  return typeof tool.type === "string" && tool.type.trim().length > 0;
}

function shouldMaskToolName(name: string | undefined): name is string {
  if (!name) {
    return false;
  }

  return !DOCUMENTED_BUILTIN_TOOL_NAMES.has(name)
    && !name.startsWith(TOOL_MASK_PREFIX);
}

function extractFirstUserTextFromMessageContent(content: MessageEntry["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n\n");
}

function extractFirstUserText(parsed: RequestPayload): string {
  if (!Array.isArray(parsed.messages)) {
    return "";
  }

  const firstUserMessage = parsed.messages.find((message) => message.role === "user");
  if (!firstUserMessage) {
    return "";
  }

  return extractFirstUserTextFromMessageContent(firstUserMessage.content).trim();
}

function buildMaskedToolName(seed: string, toolName: string, length = 8): string {
  const digest = createHash("sha256")
    .update(`tool-mask:${seed}:${toolName}`)
    .digest("hex")
    .slice(0, length);

  return `${TOOL_MASK_PREFIX}${digest}`;
}

function collectMaskCandidates(parsed: RequestPayload): string[] {
  const candidates = new Set<string>();

  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (!isRecord(tool) || isTypedTool(tool) || !shouldMaskToolName(tool.name)) {
        continue;
      }

      candidates.add(tool.name);
    }
  }

  if (Array.isArray(parsed.messages)) {
    for (const message of parsed.messages) {
      if (!Array.isArray(message.content)) {
        continue;
      }

      for (const contentBlock of message.content) {
        if (contentBlock.type !== "tool_use" || !shouldMaskToolName(contentBlock.name)) {
          continue;
        }

        candidates.add(contentBlock.name);
      }
    }
  }

  if (parsed.tool_choice?.type === "tool" && shouldMaskToolName(parsed.tool_choice.name)) {
    candidates.add(parsed.tool_choice.name);
  }

  return [...candidates];
}

function buildToolMaskMap(parsed: RequestPayload): ToolMaskMap {
  const maskMap: ToolMaskMap = new Map();
  const candidates = collectMaskCandidates(parsed);
  const firstUserText = extractFirstUserText(parsed);
  const usedMaskedNames = new Set<string>();

  for (const candidate of candidates) {
    let hashLength = 8;
    let maskedName = buildMaskedToolName(firstUserText, candidate, hashLength);

    while (usedMaskedNames.has(maskedName)) {
      hashLength += 2;
      maskedName = buildMaskedToolName(firstUserText, candidate, hashLength);
    }

    maskMap.set(candidate, maskedName);
    usedMaskedNames.add(maskedName);
  }

  return maskMap;
}

export function extractRequestToolMaskMap(body: string | undefined): ToolMaskMap {
  if (!body) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(body) as RequestPayload;
    return buildToolMaskMap(parsed);
  } catch {
    return new Map();
  }
}

function renameMaskedToolName(name: string | undefined, maskMap: ToolMaskMap): string | undefined {
  if (!name) {
    return name;
  }

  return maskMap.get(name) ?? name;
}

function remapToolUseNames(messages: MessageEntry[] | undefined, maskMap: ToolMaskMap): MessageEntry[] | undefined {
  if (!Array.isArray(messages)) {
    return messages;
  }

  return messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    return {
      ...message,
      content: message.content.map((contentBlock) => {
        if (contentBlock.type !== "tool_use" || !contentBlock.name) {
          return contentBlock;
        }

        const nextName = renameMaskedToolName(contentBlock.name, maskMap);
        return nextName === contentBlock.name ? contentBlock : { ...contentBlock, name: nextName };
      }),
    };
  });
}

function remapToolChoice(toolChoice: ToolChoice | undefined, maskMap: ToolMaskMap): ToolChoice | undefined {
  if (!toolChoice || toolChoice.type !== "tool" || typeof toolChoice.name !== "string") {
    return toolChoice;
  }

  const nextName = renameMaskedToolName(toolChoice.name, maskMap);
  return nextName === toolChoice.name ? toolChoice : { ...toolChoice, name: nextName };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProtectedSystemText(text: string): boolean {
  return text === SYSTEM_PROMPT
    || text === INJECTED_SYSTEM_PROMPT
    || text.startsWith(BILLING_HEADER_PREFIX);
}

function sanitizeSystemText(text: string): string {
  const paragraphs = text
    .split(/\n\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .filter((paragraph) => !PARAGRAPH_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor)));

  return paragraphs
    .join("\n\n")
    .replace(OPENCODE_CAMEL_RE, "Claude Code")
    .replace(OPENCODE_LOWER_RE, "Claude")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeSystemEntries(system: unknown): NormalizedSystemEntry[] {
  if (typeof system === "string") {
    const text = system.trim();
    return text ? [{ type: "text", text }] : [];
  }

  if (!Array.isArray(system)) {
    return [];
  }

  const normalized: NormalizedSystemEntry[] = [];
  for (const entry of system) {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text) {
        normalized.push({ type: "text", text });
      }
      continue;
    }

    if (!isRecord(entry)) {
      continue;
    }

    const rawText = typeof entry.text === "string" ? entry.text.trim() : "";
    if (!rawText) {
      continue;
    }

    normalized.push({
      ...entry,
      type: "text",
      text: rawText,
    });
  }

  return normalized;
}

function prependToMessageContent(
  content: MessageEntry["content"],
  prefix: string,
): MessageEntry["content"] {
  if (!prefix) {
    return content;
  }

  if (typeof content === "string") {
    return content ? `${prefix}\n\n${content}` : prefix;
  }

  if (!Array.isArray(content)) {
    return [{ type: "text", text: prefix }];
  }

  const firstTextIndex = content.findIndex(
    (block) => isRecord(block) && block.type === "text" && typeof block.text === "string",
  );

  if (firstTextIndex === -1) {
    return [{ type: "text", text: prefix }, ...content];
  }

  return content.map((block, index) => {
    if (index !== firstTextIndex || !isRecord(block) || typeof block.text !== "string") {
      return block;
    }

    return {
      ...block,
      text: block.text ? `${prefix}\n\n${block.text}` : prefix,
    } satisfies TextContentBlock;
  });
}

function relocateSystemTextToFirstUser(parsed: RequestPayload, systemEntries: NormalizedSystemEntry[]): NormalizedSystemEntry[] {
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return systemEntries.map((entry) => (
      isProtectedSystemText(entry.text)
        ? entry
        : { ...entry, text: sanitizeSystemText(entry.text) }
    )).filter((entry) => entry.text);
  }

  const preservedEntries: NormalizedSystemEntry[] = [];
  const relocatedTexts: string[] = [];

  for (const entry of systemEntries) {
    if (isProtectedSystemText(entry.text)) {
      preservedEntries.push(entry);
      continue;
    }

    const sanitizedText = sanitizeSystemText(entry.text);
    if (!sanitizedText) {
      continue;
    }

    relocatedTexts.push(sanitizedText);
  }

  if (relocatedTexts.length === 0) {
    return systemEntries.map((entry) => (
      isProtectedSystemText(entry.text)
        ? entry
        : { ...entry, text: sanitizeSystemText(entry.text) }
    )).filter((entry) => entry.text);
  }

  const prefix = relocatedTexts.join("\n\n");
  const nextMessages = [...parsed.messages];
  const userMessageIndex = nextMessages.findIndex((message) => message.role === "user");

  if (userMessageIndex === -1) {
    return systemEntries.map((entry) => (
      isProtectedSystemText(entry.text)
        ? entry
        : { ...entry, text: sanitizeSystemText(entry.text) }
    )).filter((entry) => entry.text);
  }

  const userMessage = nextMessages[userMessageIndex];
  if (!userMessage) {
    return systemEntries.map((entry) => (
      isProtectedSystemText(entry.text)
        ? entry
        : { ...entry, text: sanitizeSystemText(entry.text) }
    )).filter((entry) => entry.text);
  }

  nextMessages[userMessageIndex] = {
    ...userMessage,
    content: prependToMessageContent(userMessage.content, prefix),
  };
  parsed.messages = nextMessages;

  return preservedEntries;
}

export function extractToolNamesFromRequestBody(body: string | undefined): string[] {
  if (!body) {
    return [];
  }

  try {
    const parsed = JSON.parse(body) as RequestPayload;
    if (!Array.isArray(parsed.tools)) {
      return [];
    }

    return parsed.tools
      .map((tool) => (typeof tool.name === "string" ? tool.name : null))
      .filter((toolName): toolName is string => Boolean(toolName));
  } catch {
    return [];
  }
}

function stripToolPrefixFromLine(line: string, maskMap: ToolMaskMap): string {
  if (!ANTHROPIC_OAUTH_ADAPTER.transform.stripToolPrefixInResponse) {
    return line;
  }

  let nextLine = line;

  for (const [originalName, maskedName] of maskMap) {
    nextLine = nextLine.replace(
      new RegExp(`"name"\\s*:\\s*"${maskedName}"`, "g"),
      `"name": "${originalName}"`,
    );
  }

  return nextLine;
}

function processCompleteLines(buffer: string, maskMap: ToolMaskMap): { output: string; remaining: string } {
  const lines = buffer.split("\n");
  const remaining = lines.pop() ?? "";

  if (lines.length === 0) {
    return { output: "", remaining };
  }

  const output = `${lines.map((line) => stripToolPrefixFromLine(line, maskMap)).join("\n")}\n`;
  return { output, remaining };
}

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  accessToken: string,
  modelId = "unknown",
  excludedBetas?: Set<string>,
): Headers {
  const headers = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => { headers.set(key, value); });
  }

  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => { headers.set(key, value); });
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        if (value !== undefined) headers.set(key, String(value));
      }
    } else {
      for (const [key, value] of Object.entries(init.headers)) {
        if (value !== undefined) headers.set(key, String(value));
      }
    }
  }

  const incomingBetas = (headers.get("anthropic-beta") || "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  const modelBetas = getModelBetas(modelId, excludedBetas);
  const mergedBetas = [...new Set([
    ...modelBetas,
    ...incomingBetas,
  ])].join(",");

  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("anthropic-beta", mergedBetas);
  headers.set("user-agent", getUserAgent());
  headers.set("anthropic-dangerous-direct-browser-access", "true");
  headers.set("x-app", "cli");
  headers.delete("x-api-key");

  return headers;
}

export function transformRequestBody(body: string | undefined): string | undefined {
  if (!body) return body;

  try {
    const parsed: RequestPayload = JSON.parse(body);
    const toolMaskMap = buildToolMaskMap(parsed);

    if (ANTHROPIC_OAUTH_ADAPTER.transform.rewriteOpenCodeBranding) {
      const normalizedSystemEntries = normalizeSystemEntries(parsed.system);
      parsed.system = relocateSystemTextToFirstUser(parsed, normalizedSystemEntries);
    }

    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: renameMaskedToolName(tool.name, toolMaskMap),
      }));
    }

    parsed.messages = remapToolUseNames(parsed.messages, toolMaskMap);
    parsed.tool_choice = remapToolChoice(parsed.tool_choice, toolMaskMap);

    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

export function extractModelIdFromBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    return "unknown";
  }

  try {
    const parsed = JSON.parse(body) as { model?: string };
    return parsed.model ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function transformRequestUrl(input: RequestInfo | URL): RequestInfo | URL {
  let url: URL | null = null;
  try {
    if (typeof input === "string" || input instanceof URL) {
      url = new URL(input.toString());
    } else if (input instanceof Request) {
      url = new URL(input.url);
    }
  } catch {
    return input;
  }

  if (
    ANTHROPIC_OAUTH_ADAPTER.transform.enableMessagesBetaQuery
    && url
    && url.pathname === "/v1/messages"
    && !url.searchParams.has("beta")
  ) {
    url.searchParams.set("beta", "true");
    return input instanceof Request ? new Request(url.toString(), input) : url;
  }

  return input;
}

export function createResponseStreamTransform(response: Response, maskMap: ToolMaskMap = new Map()): Response {
  if (!response.body) return response;

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
              controller.enqueue(encoder.encode(stripToolPrefixFromLine(buffer, maskMap)));
              buffer = "";
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const { output, remaining } = processCompleteLines(buffer, maskMap);
          buffer = remaining;

          if (output) {
            controller.enqueue(encoder.encode(output));
            return;
          }
        }
      } catch (error) {
        try { reader.cancel().catch(() => {}); } catch {}
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
