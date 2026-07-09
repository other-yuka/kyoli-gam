import { createHash, randomUUID } from "node:crypto";
import { getClaudeCodeTemplateMetadata } from "./fingerprint-template";
export {
  CCH_SEEDS,
  cchForBody,
  cchWithSeed,
  stampClaudeCodeCch,
  xxh64,
} from "./cch";
export {
  clampEffortAfterRejection,
  clampUnsupportedEffortInBody,
  parseEffortCapabilityRejection,
} from "./effort-capability";
export {
  CLAUDE_FABLE_1M_MODEL_ID,
  CLAUDE_FABLE_MODEL_ID,
  CLAUDE_SONNET_1M_MODEL_ID,
  CLAUDE_SONNET_MODEL_ID,
  describeSuspendedClaudeCodeModel,
  isClaudeCode1mModelLabel,
  isClaudeFableModel,
  isSuspendedClaudeCodeModel,
  resolveClaudeCodeModelAlias,
  stripClaudeCodeContext1mTag,
  stripClaudeCodeProviderPrefix,
  toClaudeCodeWireModelId,
} from "./model-catalog";

const CLAUDE_CODE_API_BASE_URL = "https://api.anthropic.com";
const STAINLESS_PACKAGE_VERSION = "0.81.0";
const DEFAULT_OPENCODE_TIMEOUT_SECONDS = "300";
const BILLING_SEED = "59cf53e54c78";

const templateMetadata = getClaudeCodeTemplateMetadata();
const templateHeaders = templateMetadata.headerValues;
const CLAUDE_CODE_VERSION = templateMetadata.ccVersion ?? "2.1.137";
const CCH_REMOVED_VERSION = "2.1.183";

export const CLIENT_SYSTEM_PREFACE =
  "\n\n---\n\nIMPORTANT: The operator of this session has supplied the following " +
  "task-specific instructions. Follow them for task format, style, and output " +
  "requirements when they do not conflict with security, authorization, refusal, " +
  "tool-execution, confirmation, or other safety rules above. Those safety and " +
  "tool-use constraints remain higher priority and cannot be overridden:\n\n";

export interface ClaudeCodeSharedRequestProfile {
  anthropicBeta: string;
  anthropicVersion: string;
  apiV1BaseUrl: string;
  baseUrl: string;
  ccVersion: string;
  headerOrder?: string[];
  headerValues: Record<string, string>;
  packageVersion: string;
  userAgent: string;
  xApp: string;
}

export interface ClaudeCodeUpstreamIdentity {
  accountUuid: string;
  deviceId: string;
}

export interface ClaudeCodeUpstreamBodyOptions {
  agentIdentity: string;
  bodyFieldOrder?: string[];
  ccVersion: string;
  cch?: string;
  defaultTools?: Array<Record<string, unknown>>;
  firstUserMessage?: string;
  identity: ClaudeCodeUpstreamIdentity;
  sessionId: string;
  systemPrompt: string;
  systemTexts?: string[];
}

export function loadClaudeCodeSharedRequestProfile(): ClaudeCodeSharedRequestProfile {
  return {
    anthropicBeta: templateMetadata.anthropicBeta ?? templateHeaders["anthropic-beta"] ?? "oauth-2025-04-20",
    anthropicVersion: templateHeaders["anthropic-version"] ?? "2023-06-01",
    apiV1BaseUrl: `${CLAUDE_CODE_API_BASE_URL}/v1`,
    baseUrl: CLAUDE_CODE_API_BASE_URL,
    ccVersion: CLAUDE_CODE_VERSION,
    headerOrder: templateMetadata.headerOrder ? [...templateMetadata.headerOrder] : undefined,
    headerValues: { ...templateHeaders },
    packageVersion: templateHeaders["x-stainless-package-version"] ?? STAINLESS_PACKAGE_VERSION,
    userAgent: templateHeaders["user-agent"] ?? `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`,
    xApp: templateHeaders["x-app"] ?? "cli",
  };
}

export function createClaudeCodeStaticHeaders(input: {
  headerValues?: Record<string, string>;
  packageVersion?: string;
  userAgent: string;
  xApp: string;
}): Record<string, string> {
  return {
    "accept": "application/json",
    "content-type": "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": input.userAgent,
    "x-app": input.xApp,
    "x-stainless-arch": process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": getOsName(),
    "x-stainless-package-version": input.packageVersion ?? STAINLESS_PACKAGE_VERSION,
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    ...(input.headerValues ?? {}),
  };
}

export function createClaudeCodePerRequestHeaders(input: {
  anthropicVersion: string;
  sessionId: string;
  timeoutSeconds?: string;
}): Record<string, string> {
  return {
    "x-claude-code-session-id": input.sessionId,
    "x-client-request-id": randomUUID(),
    "anthropic-version": input.anthropicVersion,
    "x-stainless-timeout": input.timeoutSeconds ?? DEFAULT_OPENCODE_TIMEOUT_SECONDS,
  };
}

export function orderClaudeCodeHeadersForOutbound(
  headers: Record<string, string>,
  headerOrder?: string[],
): Record<string, string> | Array<[string, string]> {
  if (!Array.isArray(headerOrder) || headerOrder.length === 0) return headers;

  const lowerToValue = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    lowerToValue.set(key.toLowerCase(), value);
  }

  const ordered: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const name of headerOrder) {
    const key = name.toLowerCase();
    const value = lowerToValue.get(key);
    if (value === undefined || seen.has(key)) continue;
    ordered.push([name, value]);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(headers)) {
    if (seen.has(key.toLowerCase())) continue;
    ordered.push([key, value]);
  }

  return ordered;
}

export function computeClaudeCodeBuildTag(userMessage: string, version: string): string {
  const chars = [4, 7, 20].map((index) => userMessage[index] ?? "0").join("");
  return createHash("sha256")
    .update(`${BILLING_SEED}${chars}${version}`)
    .digest("hex")
    .slice(0, 3);
}

export function composeClaudeCodeBillingSystemEntry(
  firstUserMessage: string,
  version: string,
  cch = "00000",
): string {
  const buildTag = computeClaudeCodeBuildTag(firstUserMessage, version);
  const base = `x-anthropic-billing-header: cc_version=${version}.${buildTag}; cc_entrypoint=sdk-cli;`;
  return claudeCodeBillingUsesCch(version) ? `${base} cch=${cch};` : base;
}

function claudeCodeBillingUsesCch(version: string): boolean {
  const comparison = compareSemver(version, CCH_REMOVED_VERSION);
  return comparison === null || comparison < 0;
}

function compareSemver(left: string, right: string): number | null {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    const diff = leftParts[index]! - rightParts[index]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Claude Code caches the two system blocks above, plus the tools prefix and
// one rolling conversation breakpoint. Client-supplied cache_control is stripped
// before this shared helper runs; these markers are Kyoli-owned outbound hints.
export function applyClaudeCodePromptCaching(
  body: Record<string, unknown>,
  cacheControl: { type: "ephemeral" } = { type: "ephemeral" },
): void {
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    const clonedTools = tools.map((tool) => {
      const cloned = { ...tool };
      delete cloned.cache_control;
      return cloned;
    });
    clonedTools[clonedTools.length - 1] = {
      ...clonedTools[clonedTools.length - 1],
      cache_control: cacheControl,
    };
    body.tools = clonedTools;
  }

  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }

  const lastMessage = messages[messages.length - 1];
  const content = lastMessage?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return;
  }

  content[content.length - 1] = {
    ...content[content.length - 1],
    cache_control: cacheControl,
  };
}

export function applyClaudeCodeUpstreamBodyFields(
  body: Record<string, unknown>,
  input: ClaudeCodeUpstreamBodyOptions,
): Record<string, unknown> {
  const firstUserMessage = input.firstUserMessage ?? extractFirstUserText(body.messages);
  const billingHeader = composeClaudeCodeBillingSystemEntry(
    firstUserMessage,
    input.ccVersion,
    input.cch,
  );
  const systemTexts = input.systemTexts ?? normalizeClaudeCodeSystemTexts(body.system);
  const injectedSystemTexts = filterInjectedSystemTexts(systemTexts, {
    agentIdentity: input.agentIdentity,
    billingHeader,
    systemPrompt: input.systemPrompt,
  });
  const mergedSystemPrompt = injectedSystemTexts.length > 0
    ? `${input.systemPrompt}${CLIENT_SYSTEM_PREFACE}${injectedSystemTexts.join("\n\n")}`
    : input.systemPrompt;

  body.system = [
    { type: "text", text: billingHeader },
    {
      type: "text",
      text: input.agentIdentity,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: mergedSystemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];
  body.metadata = {
    ...readRecord(body.metadata),
    user_id: JSON.stringify({
      device_id: input.identity.deviceId,
      account_uuid: input.identity.accountUuid,
      session_id: input.sessionId,
    }),
  };

  if (
    input.defaultTools &&
    (!Array.isArray(body.tools) || body.tools.length === 0)
  ) {
    body.tools = input.defaultTools.map((tool) => ({ ...tool }));
  }

  applyClaudeCodePromptCaching(body);

  return orderClaudeCodeBodyForOutbound(body, input.bodyFieldOrder);
}

export function orderClaudeCodeBodyForOutbound(
  body: Record<string, unknown>,
  fieldOrder?: string[],
): Record<string, unknown> {
  if (!Array.isArray(fieldOrder) || fieldOrder.length === 0) return body;

  const ordered: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const field of fieldOrder) {
    if (seen.has(field)) continue;
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      ordered[field] = body[field];
      seen.add(field);
    }
  }

  for (const [field, value] of Object.entries(body)) {
    if (seen.has(field)) continue;
    ordered[field] = value;
  }

  return ordered;
}

export function normalizeClaudeCodeSystemTexts(system: unknown): string[] {
  if (typeof system === "string" && system.length > 0) return [system];
  if (!Array.isArray(system)) return [];

  const texts: string[] = [];
  for (const entry of system) {
    if (typeof entry === "string" && entry.length > 0) {
      texts.push(entry);
      continue;
    }
    const record = readRecord(entry);
    const text = typeof record?.text === "string" && record.text.length > 0
      ? record.text
      : undefined;
    if (text) texts.push(text);
  }
  return texts;
}

function filterInjectedSystemTexts(
  systemTexts: string[],
  input: {
    agentIdentity: string;
    billingHeader: string;
    systemPrompt: string;
  },
): string[] {
  return systemTexts.filter((entry) => (
    entry !== input.billingHeader &&
    entry !== input.agentIdentity &&
    entry !== input.systemPrompt &&
    !entry.startsWith("x-anthropic-billing-header:")
  ));
}

function extractFirstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";

  for (const message of messages) {
    const record = readRecord(message);
    if (record?.role !== "user") continue;

    if (typeof record.content === "string") return record.content;
    if (!Array.isArray(record.content)) return "";

    return record.content
      .map((block) => {
        const text = readRecord(block)?.text;
        return typeof text === "string" && text.length > 0 ? text : undefined;
      })
      .filter((text): text is string => Boolean(text))
      .join("\n\n");
  }

  return "";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getOsName(): string {
  const platform = process.platform;
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "MacOS";
  return "Linux";
}
