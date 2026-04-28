import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { basename, dirname, join } from "node:path";
import {
  existsSync,
  readFileSync,
  renameSync,
} from "node:fs";
import {
  mkdir,
  rename,
  writeFile,
} from "node:fs/promises";
import bundledTemplateJson from "./data.json";
import { detectCliVersion } from "../cli-version";
import { findCCBinary } from "../oauth-config/detect";
import { scrubTemplate } from "../scrub-template";
import { getConfigDir } from "../../shared/utils";

const CURRENT_SCHEMA_VERSION = 1;
const LIVE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;
const CACHE_FILE_NAME = "fingerprint-cache.json";
const CORRUPT_SUFFIX = ".corrupt";
const LOOPBACK_HOST = "127.0.0.1";
const STATIC_HEADER_NAMES = [
  "accept",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-version",
  "content-type",
  "user-agent",
  "x-app",
  "x-stainless-timeout",
] as const;
const SUPPORTED_CC_RANGE = {
  min: "1.0.0",
  maxTested: "2.1.121",
} as const;

type TemplateSource = "bundled" | "cached" | "live";

type TemplateTool = {
  name: string;
  [key: string]: unknown;
};

export interface TemplateData {
  _version: number;
  _schemaVersion?: number;
  _captured: string;
  _source: TemplateSource;
  agent_identity: string;
  system_prompt: string;
  tools: TemplateTool[];
  tool_names: string[];
  anthropic_beta?: string;
  cc_version?: string;
  header_order?: string[];
  header_values?: Record<string, string>;
  body_field_order?: string[];
}

export interface CapturedRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  rawHeaders: string[];
}

export interface DriftResult {
  drifted: boolean;
  cachedVersion: string | null;
  installedVersion: string | null;
  message: string;
}

export interface CompatResult {
  status: "unknown" | "below-min" | "untested-above" | "ok";
  installedVersion: string | null;
  range: typeof SUPPORTED_CC_RANGE;
  message: string;
}

interface FingerprintCaptureTestOverrides {
  now?: () => number;
  getConfigDir?: () => string;
  findClaudeBinary?: () => string | null;
  runClaudeCapture?: (params: {
    binaryPath: string;
    baseUrl: string;
    timeoutMs: number;
  }) => Promise<void>;
  detectCliVersion?: () => string;
}

const bundledTemplate = bundledTemplateJson as TemplateData;

let fingerprintCaptureTestOverrides: FingerprintCaptureTestOverrides = {};

function now(): number {
  return fingerprintCaptureTestOverrides.now?.() ?? Date.now();
}

function getCachePath(): string {
  return join(fingerprintCaptureTestOverrides.getConfigDir?.() ?? getConfigDir(), CACHE_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTemplateTool(value: unknown): value is TemplateTool {
  return isRecord(value) && typeof value.name === "string" && value.name.length > 0;
}

function isTemplateData(value: unknown): value is TemplateData {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value._version === "number"
    && typeof value._captured === "string"
    && typeof value._source === "string"
    && typeof value.agent_identity === "string"
    && typeof value.system_prompt === "string"
    && Array.isArray(value.tools)
    && value.tools.every(isTemplateTool)
    && Array.isArray(value.tool_names)
    && value.tool_names.every((toolName) => typeof toolName === "string");
}

function hasUsableToolSchemas(template: TemplateData): boolean {
  return template.tools.length > 0
    && template.tools.every((tool) => tool.name.startsWith("mcp__") || isRecord(tool.input_schema));
}

function isUsableTemplate(template: TemplateData): boolean {
  return template._schemaVersion === CURRENT_SCHEMA_VERSION
    && hasUsableToolSchemas(template);
}

function cloneTemplate(template: TemplateData, sourceOverride?: TemplateSource): TemplateData {
  return {
    ...template,
    _source: sourceOverride ?? template._source,
    tools: template.tools.map((tool) => ({ ...tool })),
    tool_names: [...template.tool_names],
    header_order: template.header_order ? [...template.header_order] : undefined,
    header_values: template.header_values ? { ...template.header_values } : undefined,
    body_field_order: template.body_field_order ? [...template.body_field_order] : undefined,
  };
}

export function prepareBundledTemplate(template: TemplateData): TemplateData {
  const rest = cloneTemplate(template, "bundled");

  return {
    ...rest,
    _version: CURRENT_SCHEMA_VERSION,
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    _source: "bundled",
    tool_names: rest.tools.map((tool) => tool.name),
  };
}

export function matchesBundledClaudeCodeFingerprint(
  template: TemplateData,
  reference: TemplateData = bundledTemplate,
): boolean {
  const expectedToolNames = reference.tool_names;
  const actualToolNames = template.tools.map((tool) => tool.name);
  const matchesExpectedTools = actualToolNames.length === expectedToolNames.length
    && expectedToolNames.every((name, index) => actualToolNames[index] === name);

  return template.agent_identity === reference.agent_identity && matchesExpectedTools;
}

function loadBundledTemplate(): TemplateData {
  if (bundledTemplate._schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `bundled fingerprint schema version ${bundledTemplate._schemaVersion} does not match CURRENT_SCHEMA_VERSION ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  return prepareBundledTemplate(bundledTemplate);
}

function quarantineCache(cachePath: string, suffix: string): void {
  if (!existsSync(cachePath)) {
    return;
  }

  try {
    const quarantinedPath = `${cachePath}${suffix}-${now()}-${process.pid}`;
    renameSync(cachePath, quarantinedPath);
  } catch {
  }
}

function quarantineCorruptCache(cachePath: string): void {
  quarantineCache(cachePath, CORRUPT_SUFFIX);
}

function readLiveCacheSync(sourceOverride: TemplateSource = "cached"): TemplateData | null {
  const cachePath = getCachePath();

  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
    if (!isTemplateData(parsed)) {
      quarantineCorruptCache(cachePath);
      return null;
    }

    return cloneTemplate(parsed, sourceOverride);
  } catch (error) {
    if (existsSync(cachePath)) {
      const isMissingFileError = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isMissingFileError) {
        quarantineCorruptCache(cachePath);
      }
    }
    return null;
  }
}

function isFreshTemplate(template: TemplateData): boolean {
  const capturedAt = Date.parse(template._captured);
  return Number.isFinite(capturedAt) && (now() - capturedAt) < LIVE_TTL_MS;
}

async function atomicWriteJson(targetPath: string, payload: unknown): Promise<void> {
  const tmpPath = join(
    dirname(targetPath),
    `${basename(targetPath)}.${process.pid}.${now()}.tmp`,
  );

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmpPath, targetPath);
}

async function writeLiveCache(template: TemplateData): Promise<void> {
  await atomicWriteJson(getCachePath(), cloneTemplate(template, "live"));
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (isRecord(value) && typeof value.text === "string") {
    return value.text;
  }

  return null;
}

function pickTextBlock(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = toText(item);
      if (text) {
        return text;
      }
    }
    return null;
  }

  return toText(value);
}

function extractCCVersion(...sources: Array<string | undefined>): string | undefined {
  for (const source of sources) {
    if (!source) {
      continue;
    }

    const billingMatch = /cc_version=([0-9]+\.[0-9]+\.[0-9]+)/i.exec(source);
    if (billingMatch?.[1]) {
      return billingMatch[1];
    }

    const userAgentMatch = /(?:claude(?:-code)?[\s/]|v)([0-9]+\.[0-9]+\.[0-9]+)/i.exec(source);
    if (userAgentMatch?.[1]) {
      return userAgentMatch[1];
    }
  }

  return undefined;
}

function extractHeaderOrder(rawHeaders: string[]): string[] | undefined {
  if (rawHeaders.length === 0) {
    return undefined;
  }

  const seen = new Set<string>();
  const orderedHeaders: string[] = [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const headerName = rawHeaders[index];
    if (!headerName) {
      continue;
    }

    const key = headerName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    orderedHeaders.push(headerName);
  }

  return orderedHeaders.length > 0 ? orderedHeaders : undefined;
}

function extractStaticHeaderValues(headers: Record<string, string>): Record<string, string> | undefined {
  const values: Record<string, string> = {};

  for (const headerName of STATIC_HEADER_NAMES) {
    const value = headers[headerName];
    if (typeof value === "string" && value.length > 0) {
      values[headerName] = value;
    }
  }

  return Object.keys(values).length > 0 ? values : undefined;
}

function normalizeHeaders(req: IncomingMessage): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [headerName, headerValue] of Object.entries(req.headers)) {
    if (typeof headerValue === "string") {
      normalized[headerName] = headerValue;
      continue;
    }

    if (Array.isArray(headerValue)) {
      normalized[headerName] = headerValue.join(",");
    }
  }

  return normalized;
}

function createSseResponseBody(): string {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_capture","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[]}}\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1}}\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n',
  ].join("\n");
}

async function captureRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function runClaudeCapture(params: {
  binaryPath: string;
  baseUrl: string;
  timeoutMs: number;
}): Promise<void> {
  if (fingerprintCaptureTestOverrides.runClaudeCapture) {
    await fingerprintCaptureTestOverrides.runClaudeCapture(params);
    return;
  }

  const isNodeScript = /\.(?:cjs|mjs|js)$/.test(params.binaryPath);
  const command = isNodeScript ? process.execPath : params.binaryPath;
  const args = isNodeScript
    ? [params.binaryPath, "--print", "-p", "hi"]
    : ["--print", "-p", "hi"];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: params.baseUrl,
      },
      stdio: "ignore",
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("capture timed out"));
    }, params.timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function findClaudeBinary(): string | null {
  if (fingerprintCaptureTestOverrides.findClaudeBinary) {
    return fingerprintCaptureTestOverrides.findClaudeBinary();
  }

  return findCCBinary();
}

function probeInstalledCCVersion(): string | null {
  try {
    return fingerprintCaptureTestOverrides.detectCliVersion?.() ?? detectCliVersion();
  } catch {
    return null;
  }
}

export function loadTemplate(): TemplateData {
  const cached = readLiveCacheSync("cached");
  if (cached && isUsableTemplate(cached)) {
    return cached;
  }

  return loadBundledTemplate();
}

export function extractTemplate(captured: CapturedRequest): TemplateData | null {
  const systemBlocks = captured.body.system;
  const tools = captured.body.tools;

  if (!Array.isArray(systemBlocks) || systemBlocks.length !== 3 || !Array.isArray(tools) || tools.length === 0) {
    return null;
  }

  const billingHeader = pickTextBlock(systemBlocks[0]);
  const agentIdentity = pickTextBlock(systemBlocks[1]);
  const systemPrompt = pickTextBlock(systemBlocks[2]);
  const extractedTools = tools.filter(isTemplateTool).map((tool) => ({ ...tool }));

  if (!billingHeader || !agentIdentity || !systemPrompt || extractedTools.length === 0) {
    return null;
  }

  const toolNames = extractedTools.map((tool) => tool.name);
  const headerValues = extractStaticHeaderValues(captured.headers);
  const bodyFieldOrder = Object.keys(captured.body);

  return {
    _version: CURRENT_SCHEMA_VERSION,
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    _captured: new Date(now()).toISOString(),
    _source: "live",
    agent_identity: agentIdentity,
    system_prompt: systemPrompt,
    tools: extractedTools,
    tool_names: toolNames,
    anthropic_beta: captured.headers["anthropic-beta"],
    cc_version: extractCCVersion(billingHeader, captured.headers["user-agent"]),
    header_order: extractHeaderOrder(captured.rawHeaders),
    header_values: headerValues,
    body_field_order: bodyFieldOrder.length > 0 ? bodyFieldOrder : undefined,
  };
}

export async function captureLiveTemplateAsync(timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS): Promise<TemplateData | null> {
  const binaryPath = findClaudeBinary();
  if (!binaryPath) {
    return null;
  }

  let capturedRequest: CapturedRequest | null = null;
  const responseBody = createSseResponseBody();
  const server = createServer(async (req, res) => {
    try {
      const bodyText = await captureRequestBody(req);
      const parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
      capturedRequest = {
        body: parsedBody,
        headers: normalizeHeaders(req),
        rawHeaders: [...req.rawHeaders],
      };
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "anthropic-ratelimit-unified-status": "accepted",
      });
      res.end(responseBody);
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"capture_failed"}');
    }
  });

  try {
    const address = await new Promise<{ port: number }>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, LOOPBACK_HOST, () => {
        const resolvedAddress = server.address();
        if (resolvedAddress && typeof resolvedAddress === "object") {
          resolve({ port: resolvedAddress.port });
          return;
        }

        reject(new Error("capture server failed to bind"));
      });
    });

    const baseUrl = `http://${LOOPBACK_HOST}:${address.port}`;
    await runClaudeCapture({ binaryPath, baseUrl, timeoutMs });

    if (!capturedRequest) {
      return null;
    }

    return extractTemplate(capturedRequest);
  } catch {
    return null;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

export async function refreshLiveFingerprintAsync(options?: {
  force?: boolean;
  silent?: boolean;
  timeoutMs?: number;
}): Promise<TemplateData | null> {
  if (!options?.force) {
    const cached = readLiveCacheSync("cached");
    if (cached && isUsableTemplate(cached) && isFreshTemplate(cached)) {
      return cached;
    }
  }

  if (!findClaudeBinary()) {
    return null;
  }

  try {
    const live = await captureLiveTemplateAsync(options?.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS);
    if (!live) {
      return null;
    }

    const scrubbed = scrubTemplate(live, { dropMcpTools: false });
    const comparableTemplate = prepareBundledTemplate(scrubTemplate(live, { dropMcpTools: true }));
    if (!matchesBundledClaudeCodeFingerprint(comparableTemplate)) {
      return null;
    }

    await writeLiveCache(scrubbed);
    return scrubbed;
  } catch {
    return null;
  }
}

function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return null;
  }

  const [, major, minor, patch] = match;
  return [Number(major), Number(minor), Number(patch)];
}

export function compareVersions(left: string, right: string): number | null {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) {
    return null;
  }

  const [leftMajor, leftMinor, leftPatch] = leftParts;
  const [rightMajor, rightMinor, rightPatch] = rightParts;

  const majorDiff = leftMajor - rightMajor;
  if (majorDiff !== 0) {
    return majorDiff;
  }

  const minorDiff = leftMinor - rightMinor;
  if (minorDiff !== 0) {
    return minorDiff;
  }

  return leftPatch - rightPatch;
}

export function detectDrift(template: TemplateData, installedOverride?: string | null): DriftResult {
  const cachedVersion = template.cc_version ?? null;
  const installedVersion = installedOverride ?? probeInstalledCCVersion();

  if (!cachedVersion) {
    return {
      drifted: false,
      cachedVersion: null,
      installedVersion,
      message: "template version unavailable",
    };
  }

  if (!installedVersion) {
    return {
      drifted: false,
      cachedVersion,
      installedVersion: null,
      message: "probe failed",
    };
  }

  if (installedVersion === cachedVersion) {
    return {
      drifted: false,
      cachedVersion,
      installedVersion,
      message: `cache v${cachedVersion} matches installed v${installedVersion}`,
    };
  }

  return {
    drifted: true,
    cachedVersion,
    installedVersion,
    message: `cache v${cachedVersion} != installed v${installedVersion}`,
  };
}

export function checkCCCompat(installedOverride?: string | null): CompatResult {
  const installedVersion = installedOverride ?? probeInstalledCCVersion();
  if (!installedVersion) {
    return {
      status: "unknown",
      installedVersion: null,
      range: SUPPORTED_CC_RANGE,
      message: "installed Claude Code version is unknown",
    };
  }

  const minComparison = compareVersions(installedVersion, SUPPORTED_CC_RANGE.min);
  const maxComparison = compareVersions(installedVersion, SUPPORTED_CC_RANGE.maxTested);

  if (minComparison === null || maxComparison === null) {
    return {
      status: "unknown",
      installedVersion,
      range: SUPPORTED_CC_RANGE,
      message: `installed Claude Code version \"${installedVersion}\" is not a strict semver`,
    };
  }

  if (minComparison < 0) {
    return {
      status: "below-min",
      installedVersion,
      range: SUPPORTED_CC_RANGE,
      message: `installed Claude Code v${installedVersion} is below supported minimum v${SUPPORTED_CC_RANGE.min}`,
    };
  }

  if (maxComparison > 0) {
    return {
      status: "untested-above",
      installedVersion,
      range: SUPPORTED_CC_RANGE,
      message: `installed Claude Code v${installedVersion} is above max tested v${SUPPORTED_CC_RANGE.maxTested}`,
    };
  }

  return {
    status: "ok",
    installedVersion,
    range: SUPPORTED_CC_RANGE,
    message: `installed Claude Code v${installedVersion} is within supported range`,
  };
}

export function setFingerprintCaptureTestOverridesForTest(overrides: FingerprintCaptureTestOverrides | null): void {
  fingerprintCaptureTestOverrides = overrides ?? {};
}

export function resetFingerprintCaptureForTest(): void {
  fingerprintCaptureTestOverrides = {};
}

export {
  LIVE_TTL_MS,
  SUPPORTED_CC_RANGE,
};
