import {
  ANTHROPIC_OAUTH_ADAPTER,
  ANTHROPIC_BETA_HEADER,
  CLAUDE_CLI_USER_AGENT,
  TOOL_PREFIX,
} from "./constants";

const OPENCODE_CAMEL_RE = /OpenCode/g;
const OPENCODE_LOWER_RE = /(?<!\/)opencode/gi;
const TOOL_PREFIX_RESPONSE_RE = /"name"\s*:\s*"mcp_([^"]+)"/g;

type SystemTextEntry = { type: string; text?: string };
type ToolEntry = { name?: string };
type MessageContentBlock = { type: string; name?: string };
type MessageEntry = { content?: MessageContentBlock[] };
type RequestPayload = {
  system?: SystemTextEntry[];
  tools?: ToolEntry[];
  messages?: MessageEntry[];
};

function addToolPrefix(name: string | undefined): string | undefined {
  if (!ANTHROPIC_OAUTH_ADAPTER.transform.addToolPrefix) {
    return name;
  }

  if (!name || name.startsWith(TOOL_PREFIX)) {
    return name;
  }

  return `${TOOL_PREFIX}${name}`;
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
): Headers {
  const headers = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => headers.set(key, value));
  }

  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => headers.set(key, value));
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

  const mergedBetas = [...new Set([
    ...ANTHROPIC_BETA_HEADER.split(","),
    ...incomingBetas,
  ])].join(",");

  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("anthropic-beta", mergedBetas);
  headers.set("user-agent", CLAUDE_CLI_USER_AGENT);
  headers.delete("x-api-key");

  return headers;
}

export function transformRequestBody(body: string | undefined): string | undefined {
  if (!body) return body;

  try {
    const parsed: RequestPayload = JSON.parse(body);

    if (parsed.system && Array.isArray(parsed.system)) {
      parsed.system = parsed.system.map((systemEntry) => {
        if (
          ANTHROPIC_OAUTH_ADAPTER.transform.rewriteOpenCodeBranding
          && systemEntry.type === "text"
          && systemEntry.text
        ) {
          return {
            ...systemEntry,
            text: systemEntry.text
              .replace(OPENCODE_CAMEL_RE, "Claude Code")
              .replace(OPENCODE_LOWER_RE, "Claude"),
          };
        }
        return systemEntry;
      });
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
