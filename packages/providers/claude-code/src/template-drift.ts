import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { platform } from "node:os";
import {
  findClaudeCodeBinary,
  probeClaudeVersion,
} from "./oauth-config";
import {
  getClaudeCodeTemplateMetadata,
  getClaudeCodeTemplateTools,
} from "./fingerprint-template";
import { scrubSystemPrompt, scrubText } from "./scrub-template";

export interface ClaudeCodeTemplateDriftReport {
  binaryPath?: string;
  bundledVersion?: string;
  capturedVersion?: string;
  captured: boolean;
  checks: ClaudeCodeTemplateDriftCheck[];
  drifted: boolean;
}

export interface ClaudeCodeTemplateDriftCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ClaudeCodeCapturedRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  rawHeaders: string[];
}

export interface ClaudeCodeWireCapture {
  binaryPath?: string;
  capturedVersion?: string;
  request?: ClaudeCodeCapturedRequest;
}

interface CapturedTemplate {
  agentIdentity: string;
  anthropicBeta?: string;
  bodyFieldOrder: string[];
  ccVersion?: string;
  headerOrder: string[];
  headerValues: Record<string, string>;
  systemPrompt: string;
  toolNames: string[];
}

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

const INTERACTIVE_ONLY_TOOL_NAMES = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

export async function checkClaudeCodeTemplateDrift(options: {
  timeoutMs?: number;
} = {}): Promise<ClaudeCodeTemplateDriftReport> {
  const bundled = readBundledTemplate();
  const capture = await captureClaudeCodeWireRequest(options);
  if (!capture.binaryPath) {
    return {
      bundledVersion: bundled.ccVersion,
      captured: false,
      checks: [
        {
          name: "claude binary",
          ok: false,
          detail: "Claude Code CLI binary was not found",
        },
      ],
      drifted: true,
    };
  }

  const captured = capture.request ? extractCapturedTemplate(capture.request) : undefined;
  const capturedVersion = captured?.ccVersion ?? capture.capturedVersion;
  const checks: ClaudeCodeTemplateDriftCheck[] = [
    {
      name: "claude binary",
      ok: true,
      detail: capture.binaryPath,
    },
    {
      name: "capture",
      ok: Boolean(captured),
      detail: captured ? "Captured local Claude Code request through loopback" : "Failed to capture a Claude Code request through loopback",
    },
  ];

  if (captured) {
    checks.push(
      compare("agent identity", bundled.agentIdentity, captured.agentIdentity),
      compare("system prompt", bundled.systemPrompt, captured.systemPrompt),
      compareToolNames(bundled.toolNames, captured.toolNames),
      compare("anthropic beta", bundled.anthropicBeta ?? "", captured.anthropicBeta ?? ""),
      compare("body field order", bundled.bodyFieldOrder.join(","), captured.bodyFieldOrder.join(",")),
      compareHeaderValues(bundled.headerValues, captured.headerValues),
      compareHeaderOrder(bundled.headerOrder, captured.headerOrder),
    );
  }

  return {
    binaryPath: capture.binaryPath,
    bundledVersion: bundled.ccVersion,
    capturedVersion,
    captured: Boolean(captured),
    checks,
    drifted: checks.some((check) => !check.ok),
  };
}

export async function captureClaudeCodeWireRequest(options: {
  timeoutMs?: number;
} = {}): Promise<ClaudeCodeWireCapture> {
  const binaryPath = findClaudeCodeBinary();
  if (!binaryPath) return {};

  const request = await captureClaudeCodeRequest(binaryPath, options.timeoutMs ?? 10_000);
  return {
    binaryPath,
    capturedVersion: request
      ? extractCCVersion(readTextBlock(readSystemBlocks(request.body)[0]), request.headers["user-agent"])
      : probeClaudeVersion(binaryPath),
    request,
  };
}

function readBundledTemplate(): CapturedTemplate {
  const metadata = getClaudeCodeTemplateMetadata();
  return {
    agentIdentity: metadata.agentIdentity ?? "",
    anthropicBeta: metadata.anthropicBeta,
    bodyFieldOrder: metadata.bodyFieldOrder ?? [],
    ccVersion: metadata.ccVersion,
    headerOrder: metadata.headerOrder ?? [],
    headerValues: metadata.headerValues,
    systemPrompt: metadata.systemPrompt ?? "",
    toolNames: metadata.toolNames.length > 0
      ? metadata.toolNames
      : getClaudeCodeTemplateTools().map((tool) => tool.name),
  };
}

async function captureClaudeCodeRequest(
  binaryPath: string,
  timeoutMs: number,
): Promise<ClaudeCodeCapturedRequest | undefined> {
  let capturedRequest: ClaudeCodeCapturedRequest | undefined;
  const server = createServer(async (request, response) => {
    try {
      const bodyText = await readRequestBody(request);
      capturedRequest = {
        body: JSON.parse(bodyText) as Record<string, unknown>,
        headers: normalizeHeaders(request),
        rawHeaders: [...request.rawHeaders],
      };
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "anthropic-ratelimit-unified-status": "accepted",
      });
      response.end(createSseResponseBody());
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"capture_failed"}');
    }
  });

  try {
    const port = await listen(server);
    await runClaudeCapture(binaryPath, `http://${LOOPBACK_HOST}:${port}`, timeoutMs);
    return capturedRequest;
  } catch {
    return undefined;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(address.port);
        return;
      }
      reject(new Error("capture server failed to bind"));
    });
  });
}

async function runClaudeCapture(
  binaryPath: string,
  baseUrl: string,
  timeoutMs: number,
): Promise<void> {
  const isNodeScript = /\.(?:cjs|mjs|js)$/.test(binaryPath);
  const command = isNodeScript ? process.execPath : binaryPath;
  const args = isNodeScript
    ? [binaryPath, "--print", "-p", "hi"]
    : ["--print", "-p", "hi"];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: baseUrl,
      },
      stdio: "ignore",
      windowsHide: true,
      shell: platform() === "win32" && /\.(?:cmd|bat)$/i.test(binaryPath),
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("capture timed out"));
    }, timeoutMs);

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

function extractCapturedTemplate(captured: ClaudeCodeCapturedRequest): CapturedTemplate | undefined {
  const system = readSystemBlocks(captured.body);
  const tools = captured.body.tools;
  if (system.length < 3 || !Array.isArray(tools)) return undefined;

  const agentIdentity = readTextBlock(system[1]);
  const systemPrompt = readTextBlock(system[2]);
  const toolNames = tools
    .map((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
      const name = (tool as Record<string, unknown>).name;
      return typeof name === "string" ? name : undefined;
    })
    .filter((name): name is string => Boolean(name));

  if (!agentIdentity || !systemPrompt || toolNames.length === 0) return undefined;

  return {
    agentIdentity: scrubText(agentIdentity),
    anthropicBeta: captured.headers["anthropic-beta"],
    bodyFieldOrder: Object.keys(captured.body),
    ccVersion: extractCCVersion(readTextBlock(system[0]), captured.headers["user-agent"]),
    headerOrder: extractHeaderOrder(captured.rawHeaders),
    headerValues: extractStaticHeaderValues(captured.headers),
    systemPrompt: scrubSystemPrompt(systemPrompt),
    toolNames,
  };
}

function readSystemBlocks(body: Record<string, unknown>): unknown[] {
  return Array.isArray(body.system) ? body.system : [];
}

function readTextBlock(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const text = (value as Record<string, unknown>).text;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function normalizeHeaders(request: IncomingMessage): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") normalized[key] = value;
    if (Array.isArray(value)) normalized[key] = value.join(",");
  }
  return normalized;
}

function extractStaticHeaderValues(headers: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const headerName of STATIC_HEADER_NAMES) {
    const value = headers[headerName];
    if (value) values[headerName] = value;
  }
  return values;
}

function extractHeaderOrder(rawHeaders: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const headerName = rawHeaders[index];
    if (!headerName) continue;
    const key = headerName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(headerName);
  }
  return ordered;
}

function extractCCVersion(...sources: Array<string | undefined>): string | undefined {
  for (const source of sources) {
    if (!source) continue;
    const billingMatch = /cc_version=([0-9]+\.[0-9]+\.[0-9]+)/i.exec(source);
    if (billingMatch?.[1]) return billingMatch[1];
    const userAgentMatch = /(?:claude(?:-code)?[\s/]|v)([0-9]+\.[0-9]+\.[0-9]+)/i.exec(source);
    if (userAgentMatch?.[1]) return userAgentMatch[1];
  }
  return undefined;
}

function compare(
  name: string,
  expected: string,
  actual: string,
  detail?: string,
): ClaudeCodeTemplateDriftCheck {
  return {
    name,
    ok: expected === actual,
    detail: detail ?? (expected === actual ? "matches bundled template" : describeMismatch(expected, actual)),
  };
}

function comparableHeadlessToolNames(toolNames: string[]): string[] {
  return toolNames.filter((toolName) => !INTERACTIVE_ONLY_TOOL_NAMES.has(toolName));
}

function compareToolNames(
  expected: string[],
  actual: string[],
): ClaudeCodeTemplateDriftCheck {
  const comparableExpected = comparableHeadlessToolNames(expected);
  const comparableActual = comparableHeadlessToolNames(actual);
  const preservedCount = expected.length - comparableExpected.length;
  const ok = comparableExpected.join("\n") === comparableActual.join("\n");

  return {
    name: "tool names",
    ok,
    detail: ok
      ? `${actual.length} captured tools; ${preservedCount} interactive-only bundled tool(s) allowed outside headless capture`
      : describeMismatch(comparableExpected.join("\n"), comparableActual.join("\n")),
  };
}

function compareHeaderValues(
  expected: Record<string, string>,
  actual: Record<string, string>,
): ClaudeCodeTemplateDriftCheck {
  const keys = Object.keys(expected).sort();
  const mismatches = keys.filter((key) => expected[key] !== actual[key]);
  return {
    name: "static header values",
    ok: mismatches.length === 0,
    detail: mismatches.length === 0
      ? `${keys.length} static headers match`
      : `mismatched headers: ${mismatches.join(", ")}`,
  };
}

function compareHeaderOrder(
  expected: string[],
  actual: string[],
): ClaudeCodeTemplateDriftCheck {
  if (expected.length === 0) {
    return {
      name: "header order",
      ok: true,
      detail: "bundled template has no pinned header order",
    };
  }

  const expectedLower = expected.map((key) => key.toLowerCase()).join(",");
  const actualLower = actual.map((key) => key.toLowerCase()).join(",");
  return {
    name: "header order",
    ok: expectedLower === actualLower,
    detail: expectedLower === actualLower
      ? `${actual.length} captured headers match bundled order`
      : describeMismatch(expectedLower, actualLower),
  };
}

function describeMismatch(expected: string, actual: string): string {
  return `expected ${expected.length} chars, captured ${actual.length} chars`;
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
