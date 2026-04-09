import { createHash } from "node:crypto";
import {
  ANTHROPIC_OAUTH_ADAPTER,
  TOOL_PREFIX,
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
const TOOL_PREFIX_RESPONSE_RE = /"name"\s*:\s*"mcp_([^"]+)"/g;
const PARAGRAPH_REMOVAL_ANCHORS = [
  "github.com/anomalyco/opencode",
  "opencode.ai/docs",
] as const;
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

type TextContentBlock = { type: string; text?: string; [key: string]: unknown };
type SystemTextEntry = { type: string; text?: string; [key: string]: unknown };
type ToolEntry = { name?: string };
type MessageContentBlock = { type: string; name?: string; text?: string; [key: string]: unknown };
type MessageEntry = {
  role?: string;
  content?: string | MessageContentBlock[];
  [key: string]: unknown;
};
type RequestPayload = {
  system?: unknown;
  tools?: ToolEntry[];
  messages?: MessageEntry[];
};

type NormalizedSystemEntry = SystemTextEntry & { type: "text"; text: string };

function addToolPrefix(name: string | undefined): string | undefined {
  if (!ANTHROPIC_OAUTH_ADAPTER.transform.addToolPrefix) {
    return name;
  }

  if (!name || name.startsWith(TOOL_PREFIX)) {
    return name;
  }

  return `${TOOL_PREFIX}${name}`;
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

function stripToolPrefixFromLine(line: string): string {
  if (!ANTHROPIC_OAUTH_ADAPTER.transform.stripToolPrefixInResponse) {
    return line;
  }

  return line.replace(TOOL_PREFIX_RESPONSE_RE, '"name": "$1"');
}

function processCompleteLines(buffer: string): { output: string; remaining: string } {
  const lines = buffer.split("\n");
  const remaining = lines.pop() ?? "";

  if (lines.length === 0) {
    return { output: "", remaining };
  }

  const output = `${lines.map(stripToolPrefixFromLine).join("\n")}\n`;
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

    if (ANTHROPIC_OAUTH_ADAPTER.transform.rewriteOpenCodeBranding) {
      const normalizedSystemEntries = normalizeSystemEntries(parsed.system);
      parsed.system = relocateSystemTextToFirstUser(parsed, normalizedSystemEntries);
    }

    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: addToolPrefix(tool.name),
      }));
    }

    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => {
        if (message.content && Array.isArray(message.content)) {
          message.content = message.content.map((contentBlock) => {
            if (contentBlock.type === "tool_use" && contentBlock.name) {
              return { ...contentBlock, name: addToolPrefix(contentBlock.name) };
            }
            return contentBlock;
          });
        }
        return message;
      });
    }

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

export function createResponseStreamTransform(response: Response): Response {
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
              controller.enqueue(encoder.encode(stripToolPrefixFromLine(buffer)));
              buffer = "";
            }
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const { output, remaining } = processCompleteLines(buffer);
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
