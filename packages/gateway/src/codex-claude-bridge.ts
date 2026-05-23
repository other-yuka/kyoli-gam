import { randomUUID } from "node:crypto";
import type {
  GatewayRequestContext,
  GatewayRoute,
  GatewayWebSocketContext,
  GatewayWebSocketMessage,
  ModelInfo,
  ProviderAdapter,
} from "@kyoli-gam/core";
import { jsonResponse } from "@kyoli-gam/core";

const VIRTUAL_CODEX_CLAUDE_PREFIX = "kyoli-claude/";
const DEFAULT_CLAUDE_MAX_TOKENS = 4096;
const COMPACT_INSTRUCTIONS =
  "Summarize the conversation so a coding agent can continue with the same goals, decisions, files, commands, and unresolved issues. Keep it concise and operational.";

interface CodexClaudeBridgeInput {
  context: GatewayRequestContext;
  provider: ProviderAdapter;
}

interface AnthropicMessageBody {
  max_tokens: number;
  messages: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  model: string;
  stream: boolean;
  system?: string | Array<Record<string, unknown>>;
  tool_choice?: Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
}

interface StreamState {
  contentBlocks: Map<number, AnthropicContentBlockState>;
  outputItems: Array<Record<string, unknown>>;
  outputText: string;
  response: Record<string, unknown>;
}

type AnthropicContentBlockState =
  | {
    index: number;
    itemIndex: number;
    text: string;
    type: "text";
  }
  | {
    argumentsText: string;
    callId: string;
    index: number;
    itemIndex: number;
    name: string;
    type: "tool_use";
  };

export function isCodexClaudeModel(model: string | undefined): boolean {
  return typeof model === "string" && model.startsWith(VIRTUAL_CODEX_CLAUDE_PREFIX);
}

export function codexClaudeModelToClaudeCodeModel(model: string): string {
  return `claude-code/${model.slice(VIRTUAL_CODEX_CLAUDE_PREFIX.length)}`;
}

export function toCodexClaudeModelEntry(model: ModelInfo): Record<string, unknown> | undefined {
  if (model.provider !== "claude-code") return undefined;
  if (!model.capabilities.includes("messages")) return undefined;
  if (!isCodexClaudeBridgeCandidate(model.upstreamId)) return undefined;

  const slug = `${VIRTUAL_CODEX_CLAUDE_PREFIX}${model.upstreamId}`;
  const contextWindow = readNumber(model.metadata?.max_context_window) ?? 200_000;
  return {
    slug,
    display_name: `${model.displayName ?? model.upstreamId} (Claude bridge)`,
    description: "Claude Code account routed through the Codex Responses bridge.",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balanced reasoning" },
      { effort: "high", description: "Deeper reasoning" },
    ],
    supported_in_api: true,
    priority: 10,
    minimal_client_version: null,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: "medium",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: model.capabilities.includes("tools"),
    shell_type: "shell_command",
    supports_image_detail_original: true,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 90,
    experimental_supported_tools: [],
    input_modalities: ["text", "image"],
    supports_search_tool: true,
    available_in_plans: ["claude-code"],
    prefer_websockets: false,
    visibility: "list",
  };
}

function isCodexClaudeBridgeCandidate(upstreamId: string): boolean {
  return /^claude-(sonnet|opus|haiku)-4(?:-\d+)*$/.test(upstreamId) &&
    !/-\d{8}$/.test(upstreamId);
}

export async function handleCodexClaudeBridgeRequest(
  input: CodexClaudeBridgeInput,
): Promise<Response> {
  if (input.context.route === "/backend-api/codex/responses/compact") {
    return handleCodexClaudeCompactBridgeRequest(input);
  }

  const body = readRecord(input.context.body);
  if (!body) {
    return jsonResponse(
      { error: { type: "invalid_request", message: "Codex Claude bridge requires a JSON object body." } },
      { status: 400 },
    );
  }

  const converted = convertCodexResponsesBodyToAnthropicMessages(body);
  if (!converted.ok) return converted.response;

  const request = new Request(new URL("/v1/messages", input.context.request.url), {
    method: input.context.request.method,
    headers: input.context.request.headers,
    body: JSON.stringify(converted.body),
  });
  const upstream = await input.provider.handleRequest({
    request,
    route: "/v1/messages",
    sessionKey: input.context.sessionKey,
    body: converted.body,
    model: converted.body.model,
  });

  return convertAnthropicResponseToCodexResponses(upstream, {
    model: readString(body.model) ?? converted.body.model,
    stream: converted.body.stream,
  });
}

export async function handleCodexClaudeBridgeWebSocket(input: {
  context: GatewayWebSocketContext;
  provider: ProviderAdapter;
}): Promise<void> {
  await input.context.websocket.accept({
    "x-codex-turn-state": input.context.request.headers.get("x-codex-turn-state") ?? randomUUID(),
  });

  while (true) {
    const message = await input.context.websocket.receive();
    if (message.type === "close") {
      await input.context.websocket.close(message.code, message.reason);
      return;
    }
    if (message.type !== "text") {
      await sendWebSocketError(input.context, "unsupported_message", "Claude bridge only supports text WebSocket messages.");
      continue;
    }

    const body = readCodexWebSocketResponseBody(message);
    if (!body) {
      await sendWebSocketError(input.context, "invalid_request", "Claude bridge could not read response.create payload.");
      continue;
    }
    if (!isCodexClaudeModel(readString(body.model))) {
      await sendWebSocketError(input.context, "invalid_request", "Claude bridge WebSocket received a non kyoli-claude model.");
      continue;
    }

    const response = await handleCodexClaudeBridgeRequest({
      context: {
        request: new Request(new URL(input.context.route, input.context.request.url), {
          method: "POST",
          headers: input.context.request.headers,
          body: JSON.stringify(body),
        }),
        route: input.context.route,
        sessionKey: input.context.sessionKey,
        body,
        model: readString(body.model),
      },
      provider: input.provider,
    });
    await sendResponseOverWebSocket(input.context, response);
  }
}

async function handleCodexClaudeCompactBridgeRequest(
  input: CodexClaudeBridgeInput,
): Promise<Response> {
  const body = readRecord(input.context.body);
  if (!body) {
    return jsonResponse(
      { error: { type: "invalid_request", message: "Codex Claude compact bridge requires a JSON object body." } },
      { status: 400 },
    );
  }

  const compactBody = {
    ...body,
    instructions: collectCompactInstructions(body.instructions),
    stream: false,
  };
  const converted = convertCodexResponsesBodyToAnthropicMessages(compactBody);
  if (!converted.ok) return converted.response;

  const request = new Request(new URL("/v1/messages", input.context.request.url), {
    method: input.context.request.method,
    headers: input.context.request.headers,
    body: JSON.stringify(converted.body),
  });
  const upstream = await input.provider.handleRequest({
    request,
    route: "/v1/messages",
    sessionKey: input.context.sessionKey,
    body: converted.body,
    model: converted.body.model,
  });

  if (!upstream.ok) return upstream;
  const payload = await upstream.clone().json().catch(() => undefined);
  const responsePayload = convertAnthropicMessageToResponsePayload(
    payload,
    readString(body.model) ?? converted.body.model,
  );
  return jsonResponse({
    object: "response.compaction",
    type: "response.compact",
    status: "completed",
    output: responsePayload.output,
  });
}

function convertCodexResponsesBodyToAnthropicMessages(body: Record<string, unknown>):
  | { ok: true; body: AnthropicMessageBody }
  | { ok: false; response: Response } {
  const model = readString(body.model);
  if (!isCodexClaudeModel(model)) {
    return {
      ok: false,
      response: jsonResponse(
        { error: { type: "invalid_request", message: "Claude bridge requires a kyoli-claude/* model." } },
        { status: 400 },
      ),
    };
  }
  const modelSlug = model ?? "";

  const convertedInput = convertResponsesInput(body.input);
  if (!convertedInput.ok) return convertedInput;

  const system = collectSystem(body.instructions, convertedInput.system);
  const stream = body.stream !== false;
  const messages = convertedInput.messages.length > 0
    ? convertedInput.messages
    : [{ role: "user", content: "" }];
  const result: AnthropicMessageBody = {
    model: codexClaudeModelToClaudeCodeModel(modelSlug),
    max_tokens: readPositiveInteger(body.max_output_tokens) ??
      readPositiveInteger(body.max_tokens) ??
      DEFAULT_CLAUDE_MAX_TOKENS,
    messages,
    stream,
  };

  if (system) result.system = system;
  const tools = convertResponsesTools(body.tools);
  if (tools.length > 0) result.tools = tools;
  const toolChoice = convertResponsesToolChoice(body.tool_choice);
  if (toolChoice) result.tool_choice = toolChoice;
  const metadata = readRecord(body.metadata);
  if (metadata) result.metadata = metadata;

  return { ok: true, body: result };
}

function readCodexWebSocketResponseBody(message: GatewayWebSocketMessage): Record<string, unknown> | undefined {
  if (message.type !== "text") return undefined;
  const record = readRecordFromJson(message.data);
  if (!record) return undefined;

  const body = readRecord(record.response) ??
    readRecord(record.request) ??
    readRecord(record.value) ??
    record;
  const model = readString(record.model) ??
    readString(readRecord(record.response)?.model) ??
    readString(readRecord(record.request)?.model) ??
    readString(readRecord(record.value)?.model);
  return model && !body.model ? { ...body, model } : body;
}

async function sendResponseOverWebSocket(
  context: GatewayWebSocketContext,
  response: Response,
): Promise<void> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    await sendSseResponseOverWebSocket(context, response);
    return;
  }

  const payload = contentType.includes("application/json")
    ? await response.text()
    : JSON.stringify({
      type: "response.failed",
      response: {
        status: "failed",
        error: {
          type: "upstream_error",
          message: await response.text().catch(() => "Claude bridge request failed."),
        },
      },
    });
  await context.websocket.sendText(payload);
}

async function sendSseResponseOverWebSocket(
  context: GatewayWebSocketContext,
  response: Response,
): Promise<void> {
  const text = await response.text();
  for (const frame of splitSseFrames(text)) {
    const data = readSseData(frame);
    if (!data || data === "[DONE]") continue;
    await context.websocket.sendText(data);
  }
}

function splitSseFrames(text: string): string[] {
  return text.split(/\r?\n\r?\n/).filter((frame) => frame.trim().length > 0);
}

async function sendWebSocketError(
  context: GatewayWebSocketContext,
  type: string,
  message: string,
): Promise<void> {
  await context.websocket.sendText(JSON.stringify({
    type: "response.failed",
    response: {
      status: "failed",
      error: { type, message },
    },
  }));
}

function convertResponsesInput(input: unknown):
  | { ok: true; messages: Array<Record<string, unknown>>; system: Array<Record<string, unknown>> }
  | { ok: false; response: Response } {
  if (typeof input === "string") {
    return {
      ok: true,
      messages: [{ role: "user", content: input }],
      system: [],
    };
  }
  if (!Array.isArray(input)) {
    return {
      ok: true,
      messages: [{ role: "user", content: "" }],
      system: [],
    };
  }

  const messages: Array<Record<string, unknown>> = [];
  const system: Array<Record<string, unknown>> = [];
  for (const item of input) {
    const record = readRecord(item);
    if (!record) continue;

    const type = readString(record.type);
    const role = readString(record.role);
    if (type === "function_call_output") {
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: readString(record.call_id) ?? readString(record.id) ?? `call_${randomUUID()}`,
          content: stringifyToolOutput(record.output),
        }],
      });
      continue;
    }
    if (type === "function_call") {
      messages.push({
        role: "assistant",
        content: [{
          type: "tool_use",
          id: readString(record.call_id) ?? readString(record.id) ?? `call_${randomUUID()}`,
          name: readString(record.name) ?? "tool",
          input: parseToolArguments(record.arguments),
        }],
      });
      continue;
    }

    const content = convertMessageContent(record.content, role === "assistant" ? "assistant" : "user");
    if (role === "system" || role === "developer") {
      system.push(...content);
      continue;
    }
    messages.push({
      role: role === "assistant" ? "assistant" : "user",
      content,
    });
  }

  return { ok: true, messages: coalesceMessages(messages), system };
}

function convertMessageContent(content: unknown, role: "assistant" | "user"): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: "" }];

  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    const record = readRecord(part);
    if (!record) continue;

    const type = readString(record.type);
    const text = readString(record.text);
    if (type === "text" || type === "input_text" || type === "output_text") {
      blocks.push({ type: "text", text: text ?? "" });
      continue;
    }
    if (type === "input_image" || type === "image") {
      const source = convertImageSource(record);
      if (source) blocks.push({ type: "image", source });
      continue;
    }
    if (role === "user" && type === "tool_result") {
      blocks.push(record);
    }
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function convertImageSource(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const imageUrl = readString(record.image_url) ?? readString(readRecord(record.image_url)?.url);
  if (!imageUrl?.startsWith("data:")) return undefined;

  const match = imageUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) return undefined;
  return {
    type: "base64",
    media_type: match[1],
    data: match[2],
  };
}

function coalesceMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const coalesced: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const previous = coalesced.at(-1);
    if (
      previous &&
      previous.role === message.role &&
      Array.isArray(previous.content) &&
      Array.isArray(message.content)
    ) {
      previous.content = [...previous.content, ...message.content];
      continue;
    }
    coalesced.push(message);
  }
  return coalesced;
}

function collectSystem(instructions: unknown, blocks: Array<Record<string, unknown>>): string | Array<Record<string, unknown>> | undefined {
  const systemBlocks = [...blocks];
  if (typeof instructions === "string" && instructions.length > 0) {
    systemBlocks.unshift({ type: "text", text: instructions });
  }
  if (systemBlocks.length === 0) return undefined;
  if (systemBlocks.length === 1 && typeof systemBlocks[0]?.text === "string") {
    return systemBlocks[0].text;
  }
  return systemBlocks;
}

function collectCompactInstructions(instructions: unknown): string {
  if (typeof instructions === "string" && instructions.length > 0) {
    return `${instructions}\n\n${COMPACT_INSTRUCTIONS}`;
  }
  return COMPACT_INSTRUCTIONS;
}

function convertResponsesTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) return [];

  const converted: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    const record = readRecord(tool);
    if (!record) continue;

    const name = readString(record.name);
    if (!name) continue;
    converted.push({
      name,
      description: readString(record.description),
      input_schema: readRecord(record.parameters) ?? readRecord(record.input_schema) ?? { type: "object" },
    });
  }
  return converted;
}

function convertResponsesToolChoice(choice: unknown): Record<string, unknown> | undefined {
  if (choice === "auto" || choice === undefined) return undefined;
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };

  const record = readRecord(choice);
  const name = readString(record?.name) ?? readString(readRecord(record?.function)?.name);
  return name ? { type: "tool", name } : undefined;
}

async function convertAnthropicResponseToCodexResponses(
  upstream: Response,
  request: { model: string; stream: boolean },
): Promise<Response> {
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok) return upstream;

  if (contentType.includes("text/event-stream")) {
    return convertAnthropicStreamToResponsesStream(upstream, request.model);
  }

  if (!contentType.includes("application/json")) return upstream;

  const payload = await upstream.clone().json().catch(() => undefined);
  const responsePayload = convertAnthropicMessageToResponsePayload(payload, request.model);
  if (request.stream) {
    return responsesEventStream([
      responsesEvent("response.created", { type: "response.created", response: responseShell(responsePayload) }),
      ...responsePayloadToEvents(responsePayload),
      responsesEvent("response.completed", { type: "response.completed", response: responsePayload }),
    ]);
  }
  return jsonResponse(responsePayload, { status: upstream.status });
}

function convertAnthropicStreamToResponsesStream(upstream: Response, model: string): Response {
  if (!upstream.body) return upstream;

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state: StreamState = {
    contentBlocks: new Map(),
    outputItems: [],
    outputText: "",
    response: createResponseShell(model),
  };
  let buffer = "";
  let started = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          buffer += decoder.decode();
          const finalEvents = drainAnthropicFrames(buffer, (frame) => convertAnthropicFrame(frame, state));
          for (const event of finalEvents.frames) controller.enqueue(encoder.encode(event));
          controller.enqueue(encoder.encode(responsesEvent("response.completed", {
            type: "response.completed",
            response: finalizeResponse(state),
          })));
          controller.close();
          return;
        }

        buffer += decoder.decode(next.value, { stream: true });
        const events = drainAnthropicFrames(buffer, (frame) => convertAnthropicFrame(frame, state));
        buffer = events.remainder;

        if (!started) {
          started = true;
          controller.enqueue(encoder.encode(responsesEvent("response.created", {
            type: "response.created",
            response: state.response,
          })));
        }
        for (const event of events.frames) {
          controller.enqueue(encoder.encode(event));
        }
        if (events.frames.length > 0) return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

function drainAnthropicFrames(
  buffer: string,
  convert: (frame: string) => string[],
): { frames: string[]; remainder: string } {
  const frames: string[] = [];
  let remainder = buffer;

  while (true) {
    const normalizedIndex = remainder.indexOf("\n\n");
    const windowsIndex = remainder.indexOf("\r\n\r\n");
    const indexes = [normalizedIndex, windowsIndex].filter((index) => index >= 0);
    if (indexes.length === 0) return { frames, remainder };

    const index = Math.min(...indexes);
    const separatorLength = remainder.startsWith("\r\n\r\n", index) ? 4 : 2;
    const frame = remainder.slice(0, index);
    remainder = remainder.slice(index + separatorLength);
    if (frame.trim()) frames.push(...convert(frame));
  }
}

function convertAnthropicFrame(frame: string, state: StreamState): string[] {
  const data = readSseData(frame);
  if (!data || data === "[DONE]") return [];

  const payload = readRecordFromJson(data);
  if (!payload) return [];

  const type = readString(payload.type);
  if (type === "message_start") {
    const message = readRecord(payload.message);
    state.response.id = readString(message?.id) ?? state.response.id;
    state.response.model = readString(message?.model) ?? state.response.model;
    return [];
  }
  if (type === "content_block_start") {
    const index = readNumber(payload.index) ?? state.contentBlocks.size;
    const block = readRecord(payload.content_block);
    return block ? startContentBlock(index, block, state) : [];
  }
  if (type === "content_block_delta") {
    const index = readNumber(payload.index);
    const delta = readRecord(payload.delta);
    return index === undefined || !delta ? [] : updateContentBlock(index, delta, state);
  }
  if (type === "content_block_stop") {
    const index = readNumber(payload.index);
    return index === undefined ? [] : stopContentBlock(index, state);
  }
  if (type === "error") {
    const error = readRecord(payload.error);
    return [responsesEvent("response.failed", {
      type: "response.failed",
      response: {
        ...finalizeResponse(state),
        status: "failed",
        error: {
          type: readString(error?.type) ?? "upstream_error",
          message: readString(error?.message) ?? "Claude bridge stream failed.",
        },
      },
    })];
  }
  return [];
}

function startContentBlock(
  index: number,
  block: Record<string, unknown>,
  state: StreamState,
): string[] {
  const type = readString(block.type);
  if (type === "tool_use") {
    const callId = readString(block.id) ?? `call_${randomUUID()}`;
    const name = readString(block.name) ?? "tool";
    const itemIndex = state.outputItems.length;
    const item = {
      id: callId,
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify(readRecord(block.input) ?? {}),
    };
    state.outputItems.push(item);
    state.contentBlocks.set(index, {
      argumentsText: typeof item.arguments === "string" ? item.arguments : "",
      callId,
      index,
      itemIndex,
      name,
      type: "tool_use",
    });
    return [responsesEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: itemIndex,
      item,
    })];
  }

  const itemIndex = ensureAssistantMessageItem(state);
  state.contentBlocks.set(index, {
    index,
    itemIndex,
    text: readString(block.text) ?? "",
    type: "text",
  });
  return [];
}

function updateContentBlock(
  index: number,
  delta: Record<string, unknown>,
  state: StreamState,
): string[] {
  const block = state.contentBlocks.get(index);
  if (!block) return [];

  const type = readString(delta.type);
  if (block.type === "text" && type === "text_delta") {
    const text = readString(delta.text) ?? "";
    block.text += text;
    state.outputText += text;
    appendAssistantText(state, text);
    return [responsesEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: block.itemIndex,
      content_index: 0,
      delta: text,
    })];
  }

  if (block.type === "tool_use" && type === "input_json_delta") {
    const deltaText = readString(delta.partial_json) ?? "";
    block.argumentsText += deltaText;
    return [responsesEvent("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      output_index: block.itemIndex,
      item_id: block.callId,
      call_id: block.callId,
      name: block.name,
      delta: deltaText,
    })];
  }
  return [];
}

function stopContentBlock(index: number, state: StreamState): string[] {
  const block = state.contentBlocks.get(index);
  if (!block) return [];

  state.contentBlocks.delete(index);
  if (block.type !== "tool_use") return [];

  const item = state.outputItems[block.itemIndex];
  if (item) item.arguments = block.argumentsText || "{}";
  return [
    responsesEvent("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      output_index: block.itemIndex,
      item_id: block.callId,
      call_id: block.callId,
      name: block.name,
      arguments: block.argumentsText || "{}",
    }),
    responsesEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: block.itemIndex,
      item,
    }),
  ];
}

function convertAnthropicMessageToResponsePayload(payload: unknown, model: string): Record<string, unknown> {
  const response = createResponseShell(model);
  const message = readRecord(payload);
  if (!message) return response;

  response.id = readString(message.id) ?? response.id;
  response.model = readString(message.model) ?? response.model;
  const state: StreamState = {
    contentBlocks: new Map(),
    outputItems: [],
    outputText: "",
    response,
  };

  const content = Array.isArray(message.content) ? message.content : [];
  for (const [index, part] of content.entries()) {
    const record = readRecord(part);
    if (!record) continue;
    startContentBlock(index, record, state);
    if (readString(record.type) === "text") {
      updateContentBlock(index, { type: "text_delta", text: readString(record.text) ?? "" }, state);
      stopContentBlock(index, state);
    }
  }

  return finalizeResponse(state);
}

function responsePayloadToEvents(payload: Record<string, unknown>): string[] {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const events: string[] = [];
  for (const [index, item] of output.entries()) {
    const record = readRecord(item);
    if (!record) continue;
    events.push(responsesEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: index,
      item: record,
    }));
    if (record.type === "message") {
      for (const content of Array.isArray(record.content) ? record.content : []) {
        const text = readString(readRecord(content)?.text);
        if (text) {
          events.push(responsesEvent("response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: index,
            content_index: 0,
            delta: text,
          }));
        }
      }
    }
    events.push(responsesEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: index,
      item: record,
    }));
  }
  return events;
}

function responseShell(response: Record<string, unknown>): Record<string, unknown> {
  return {
    ...response,
    output: [],
    output_text: "",
  };
}

function createResponseShell(model: string): Record<string, unknown> {
  return {
    id: `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "in_progress",
    output: [],
    output_text: "",
  };
}

function finalizeResponse(state: StreamState): Record<string, unknown> {
  return {
    ...state.response,
    status: "completed",
    output: state.outputItems,
    output_text: state.outputText,
  };
}

function ensureAssistantMessageItem(state: StreamState): number {
  const index = state.outputItems.findIndex((item) => item.type === "message");
  if (index >= 0) return index;

  const nextIndex = state.outputItems.length;
  state.outputItems.push({
    id: `msg_${randomUUID()}`,
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: [{ type: "output_text", text: "", annotations: [] }],
  });
  return nextIndex;
}

function appendAssistantText(state: StreamState, text: string): void {
  const itemIndex = ensureAssistantMessageItem(state);
  const item = state.outputItems[itemIndex];
  const content = Array.isArray(item?.content) ? item.content : [];
  const first = readRecord(content[0]);
  if (first) {
    first.text = `${readString(first.text) ?? ""}${text}`;
  }
  if (item) item.status = "completed";
}

function responsesEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responsesEventStream(events: string[]): Response {
  return new Response(events.join(""), {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

function readSseData(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data.length > 0 ? data : undefined;
}

function readRecordFromJson(value: string): Record<string, unknown> | undefined {
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "");
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return readRecord(value) ?? {};
  try {
    return readRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : undefined;
  return parsed && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
