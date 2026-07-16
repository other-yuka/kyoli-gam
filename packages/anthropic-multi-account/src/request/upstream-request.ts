import { randomUUID } from "node:crypto";
import {
  applyClaudeCodeUpstreamBodyFields,
  composeClaudeCodeBillingSystemEntry,
  computeClaudeCodeBuildTag,
  isClaudeFableModel,
  orderClaudeCodeBodyForOutbound,
  resolveClaudeCodeCacheControl,
  resolveClaudeCodeModelAlias,
  stampClaudeCodeCch,
  toClaudeCodeWireModelId,
} from "@kyoli-gam/provider-claude-code/opencode";
import { claudeCodeIntegration, type ClaudeIdentity, type TemplateData } from "../claude-code";
import { getRuntimeModelCapability } from "../model/capabilities";
import {
  MAX_TOOL_RESULT_TEXT_LENGTH,
  TRUNCATION_SUFFIX,
  normalizeAnthropicClientRequest,
  sanitizeMessages,
  scrubFrameworkIdentifiers,
  type JsonRecord,
  type Message,
} from "./client-adapter";
import { selectOpenCodeNativeTools, type ToolDefinition } from "./tool-adapter";

const BILLING_SEED = "59cf53e54c78";
const SESSION_IDLE_ROTATE_MS = 15 * 60 * 1000;
const DEFAULT_CONTEXT_MANAGEMENT = {};
const DEFAULT_OUTPUT_EFFORT = "high";
const VALID_OUTPUT_EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "ultracode", "max", "client"]);

export const OPENCODE_OUTPUT_EFFORT_HEADER = "x-kyoli-opencode-effort";

export type OutputEffortValue = "low" | "medium" | "high" | "xhigh" | "ultracode" | "max" | "client";

type ReverseLookup = Map<string, string> | Record<string, string> | undefined;

interface UpstreamRequestTestOverrides {
  now?: () => number;
  createSessionId?: () => string;
  outputEffort?: OutputEffortValue;
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


function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readOutputEffortValue(value: unknown): OutputEffortValue | undefined {
  const normalized = readString(value)?.toLowerCase();
  return normalized && VALID_OUTPUT_EFFORT_VALUES.has(normalized)
    ? normalized as OutputEffortValue
    : undefined;
}

export function readOpenCodeVariantEffort(value: unknown): OutputEffortValue | undefined {
  const normalized = readString(value)?.toLowerCase();
  if (normalized === "minimal") return "low";
  return readOutputEffortValue(normalized);
}

function normalizeEffortForWire(effort: OutputEffortValue): string {
  return effort === "ultracode" ? "xhigh" : effort;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function effortFromThinkingBudget(thinking: JsonRecord | undefined): OutputEffortValue | undefined {
  const budgetTokens = readPositiveNumber(thinking?.budget_tokens) ?? readPositiveNumber(thinking?.budgetTokens);
  if (budgetTokens === undefined) return undefined;
  if (budgetTokens >= 31_999) return "max";
  if (budgetTokens >= 16_000) return "high";
  if (budgetTokens >= 8_000) return "medium";
  return "low";
}

function getConfiguredOutputEffort(): OutputEffortValue | undefined {
  return upstreamRequestTestOverrides.outputEffort
    ?? readOutputEffortValue(process.env.CLAUDE_MULTI_ACCOUNT_EFFORT)
    ?? readOutputEffortValue(process.env.ANTHROPIC_MULTI_ACCOUNT_EFFORT);
}

export function getClientOutputEffort(inputBody: Record<string, unknown>): OutputEffortValue | undefined {
  const outputConfig = isRecord(inputBody.output_config) ? inputBody.output_config : undefined;
  const reasoning = isRecord(inputBody.reasoning) ? inputBody.reasoning : undefined;
  const thinking = isRecord(inputBody.thinking) ? inputBody.thinking : undefined;

  return readOutputEffortValue(outputConfig?.effort)
    ?? readOutputEffortValue(inputBody.effort)
    ?? readOutputEffortValue(reasoning?.effort)
    ?? readOutputEffortValue(inputBody.reasoning_effort)
    ?? readOutputEffortValue(inputBody.reasoningEffort)
    ?? readOutputEffortValue(thinking?.effort)
    ?? effortFromThinkingBudget(thinking);
}

export function resolveOutputEffort(
  inputBody: Record<string, unknown>,
  configuredEffort = getConfiguredOutputEffort(),
  modelId?: string,
): string {
  if (configuredEffort && configuredEffort !== "client") {
    return normalizeEffortForWire(configuredEffort);
  }

  const clientEffort = getClientOutputEffort(inputBody);
  return normalizeEffortForWire(clientEffort ?? DEFAULT_OUTPUT_EFFORT);
}

function isHaikuModel(modelId: string): boolean {
  return resolveClaudeCodeModelAlias(modelId).toLowerCase().includes("haiku");
}

function getSystemPromptForModel(template: TemplateData, modelId: string): string {
  return modelId.toLowerCase().includes("fable") && template.system_prompt_fable
    ? template.system_prompt_fable
    : template.system_prompt;
}

function collectToolUseIds(message: Message): string[] {
  if (!Array.isArray(message.content)) {
    return [];
  }

  return message.content
    .filter((block) => isRecord(block) && block.type === "tool_use" && typeof block.id === "string")
    .map((block) => String(block.id));
}

function collectToolResultIds(message: Message): Set<string> {
  if (!Array.isArray(message.content)) {
    return new Set();
  }

  return new Set(
    message.content
      .filter((block) => isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string")
      .map((block) => String(block.tool_use_id)),
  );
}

export function getDanglingToolUseError(messages: Message[]): string | null {
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    if (!current || current.role !== "assistant") {
      continue;
    }

    const toolUseIds = collectToolUseIds(current);
    if (toolUseIds.length === 0) {
      continue;
    }

    const next = messages[index + 1];
    if (!next || next.role !== "user") {
      return `Dangling tool_use after assistant turn ${index}: ${toolUseIds.join(", ")}`;
    }

    const toolResultIds = collectToolResultIds(next);
    const missing = toolUseIds.filter((toolUseId) => !toolResultIds.has(toolUseId));
    if (missing.length > 0) {
      return `Missing tool_result for assistant turn ${index}: ${missing.join(", ")}`;
    }
  }

  return null;
}

const ADAPTIVE_THINKING_MODEL_MATCHERS = [
  (modelId: string) => /claude-sonnet-(?:[5-9]|\d{2,})(?:[-._]\d+)?(?:\[1m\])?$/.test(modelId),
  (modelId: string) => modelId.includes("claude-sonnet-4-6") || modelId.includes("claude-sonnet-4.6"),
  (modelId: string) => modelId.includes("claude-opus-4-6") || modelId.includes("claude-opus-4.6"),
  (modelId: string) => /claude-opus-4[-._]([7-9]|\d{2,})/.test(modelId),
  (modelId: string) => /claude-fable-(?:[5-9]|\d{2,})(?:[-._]\d+)?(?:\[1m\])?$/.test(modelId),
];
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

function supportsAdaptiveThinking(modelId: string): boolean {
  const runtimeCapability = getRuntimeModelCapability(modelId);
  if (typeof runtimeCapability?.supportsThinking === "boolean") {
    return runtimeCapability.supportsThinking;
  }

  const normalized = resolveClaudeCodeModelAlias(modelId).toLowerCase();
  if (normalized.includes("haiku")) {
    return false;
  }

  return ADAPTIVE_THINKING_MODEL_MATCHERS.some((matches) => matches(normalized));
}

export function resolveMaxTokens(requestedMaxTokens: unknown): number {
  if (typeof requestedMaxTokens !== "number" || !Number.isFinite(requestedMaxTokens)) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }

  const normalized = Math.floor(requestedMaxTokens);
  if (normalized <= 0) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }

  return Math.min(normalized, DEFAULT_MAX_OUTPUT_TOKENS);
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

export function getCcVersion(template?: TemplateData): string {
  return template?.cc_version ?? claudeCodeIntegration.detectCliVersion();
}

export { stampClaudeCodeCch };

function buildBillingHeader(firstUserMessage: string, template: TemplateData): string {
  const version = getCcVersion(template);
  return composeClaudeCodeBillingSystemEntry(firstUserMessage, version);
}

function getReverseName(name: string, reverseLookup: ReverseLookup): string {
  if (!reverseLookup) {
    return name;
  }

  if (reverseLookup instanceof Map) {
    return reverseLookup.get(name) ?? name;
  }

  return typeof reverseLookup[name] === "string" ? reverseLookup[name] : name;
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

export function computeBuildTag(userMessage: string, version: string): string {
  return computeClaudeCodeBuildTag(userMessage, version);
}

export function buildUpstreamRequest(
  inputBody: Record<string, unknown>,
  identity: ClaudeIdentity,
  template: TemplateData,
  options?: { sessionId?: string; outputEffort?: OutputEffortValue },
): Record<string, unknown> {
  const cacheControl = resolveClaudeCodeCacheControl(inputBody);
  const { body, firstUserMessage, systemTexts } = normalizeAnthropicClientRequest(inputBody);
  const activeSessionId = options?.sessionId ?? getActiveSessionId();
  const configuredEffort = getConfiguredOutputEffort() ?? options?.outputEffort;

  const incomingTools = Array.isArray(body.tools) ? body.tools as ToolDefinition[] : [];
  const selectedTools = selectOpenCodeNativeTools({
    incomingTools,
    templateTools: template.tools,
  });
  body.tools = selectedTools.tools;
  const modelId = typeof body.model === "string" ? resolveClaudeCodeModelAlias(body.model) : "";
  if (typeof body.model === "string") {
    body.model = toClaudeCodeWireModelId(body.model);
  }
  if (isClaudeFableModel(modelId) && incomingTools.length === 0 && selectedTools.tools.length > 0) {
    body.tool_choice = { type: "none" };
  }
  if (supportsAdaptiveThinking(modelId)) {
    body.thinking = { type: "adaptive", display: "omitted" };
    body.context_management = DEFAULT_CONTEXT_MANAGEMENT;
  }
  if (modelId && !isHaikuModel(modelId)) {
    body.output_config = { effort: resolveOutputEffort(inputBody, configuredEffort, modelId) };
  }
  body.max_tokens = resolveMaxTokens(body.max_tokens);

  return applyClaudeCodeUpstreamBodyFields(body, {
    agentIdentity: template.agent_identity,
    bodyFieldOrder: template.body_field_order,
    cacheControl,
    ccVersion: getCcVersion(template),
    firstUserMessage,
    identity: {
      accountUuid: identity.accountUuid,
      deviceId: identity.deviceId,
    },
    sessionId: activeSessionId,
    systemPrompt: getSystemPromptForModel(template, modelId),
    systemTexts: filterInjectedSystemTexts(
      systemTexts,
      template,
      buildBillingHeader(firstUserMessage, template),
    ),
  });
}

export function orderBodyForOutbound(
  body: Record<string, unknown>,
  overrideOrder?: string[],
): Record<string, unknown> {
  return orderClaudeCodeBodyForOutbound(body, overrideOrder);
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
  sanitizeMessages,
  scrubFrameworkIdentifiers,
  TRUNCATION_SUFFIX,
};
