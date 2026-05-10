import type { AccountExecutionTraceEvent, AccountRecord, AccountStore } from "@kyoli-gam/core";
import { StickyAccountPool, stripProviderPrefix } from "@kyoli-gam/core";
import { createGateway, serveGateway } from "@kyoli-gam/gateway";
import { createCodexChatGPTProvider } from "@kyoli-gam/provider-codex-chatgpt";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { CliConfig } from "./config";

export interface CodexSmokeOptions {
  route?: "/backend-api/codex/responses" | "/v1/responses" | "/v1/chat/completions";
  model?: string;
  expectedText?: string;
  sessionId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface CodexFileSmokeOptions {
  fileName?: string;
  fileContent?: string;
  sessionId?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface CodexE2EOptions {
  model?: string;
  expectedText?: string;
  sessionId?: string;
  timeoutMs?: number;
  port?: number;
  fetch?: typeof fetch;
  clientFetch?: typeof fetch;
  includeOpenCode?: boolean;
  openCodeCommand?: string;
  includeCodexCli?: boolean;
  codexCliCommand?: string;
  keepTemp?: boolean;
}

export interface CodexLoadOptions {
  route?: "/backend-api/codex/responses" | "/v1/responses" | "/v1/chat/completions";
  model?: string;
  requests?: number;
  concurrency?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface CodexSmokeReport {
  name: string;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  checks: Array<{
    name: string;
    status: "pass" | "warn" | "fail";
    detail: string;
  }>;
}

const FALLBACK_CODEX_MODEL = "openai/gpt-5.3-codex";
const DEFAULT_EXPECTED_TEXT = "smoke-ok";
const DEFAULT_TIMEOUT_MS = 120_000;

export async function runCodexSmokeDoctor(
  store: AccountStore,
  config: CliConfig,
  options: CodexSmokeOptions = {},
): Promise<CodexSmokeReport> {
  const route = options.route ?? "/backend-api/codex/responses";
  const expectedText = options.expectedText ?? DEFAULT_EXPECTED_TEXT;
  const sessionId = options.sessionId ?? `codex-smoke-${Date.now()}`;
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 2021;
  const beforeAccounts = await store.listByProvider("codex");
  const enabledAccounts = beforeAccounts.filter(isReadyOAuthAccount);
  const trace: AccountExecutionTraceEvent[] = [];
  const checks: CodexSmokeReport["checks"] = [
    check(
      "codex account inventory",
      enabledAccounts.length > 0,
      `${enabledAccounts.length} ready codex/oauth account(s)`,
    ),
  ];

  const accountPool = new StickyAccountPool(store, {
    strategy: config.accountSelectionStrategy,
    softQuotaThresholdPercent: config.softQuotaThresholdPercent,
    planWeights: config.planWeights,
  });
  const gateway = createGateway({
    config: {
      host,
      port,
    },
    accounts: store,
    providers: [
      createCodexChatGPTProvider({
        accounts: accountPool,
        fetch: withTimeout(options.fetch ?? fetch, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        onTrace: (event) => trace.push(event),
      }),
    ],
  });

  const healthResponse = await gateway.fetch(new Request(`http://${host}:${port}/health`));
  checks.push(
    check("gateway health", healthResponse.ok, `${healthResponse.status} ${healthResponse.statusText}`),
  );

  const modelsResponse = await gateway.fetch(new Request(`http://${host}:${port}/v1/models`));
  const modelsBody = await readJsonRecord(modelsResponse);
  const model = options.model ?? selectDefaultCodexModel(modelsBody);
  checks.push(
    check(
      "codex model registry",
      modelsResponse.ok && modelListIncludes(modelsBody, model),
      modelsResponse.ok ? `${model} is available` : `${modelsResponse.status} ${modelsResponse.statusText}`,
    ),
  );

  if (enabledAccounts.length === 0) {
    return report("codex-smoke", checks);
  }

  const startedAt = Date.now();
  const smokeBody =
    route === "/v1/chat/completions"
      ? createCodexChatSmokeBody(model, expectedText)
      : createCodexSmokeBody(model, expectedText);
  const smokeResponse = await gateway.fetch(
    new Request(`http://${host}:${port}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kyoli-session-id": sessionId,
      },
      body: JSON.stringify(smokeBody),
    }),
  );
  const smokeText = await smokeResponse.text();
  const decodedSmokeText = extractSmokeOutputText(smokeText);
  const normalizedSmokeText = `${decodedSmokeText} ${smokeText}`.replace(/\s+/g, " ");
  const afterAccounts = await store.listByProvider("codex");
  const usedAccount = findRecentlyUsedAccount(beforeAccounts, afterAccounts, startedAt);

  checks.push(
    check(
      "codex upstream response",
      smokeResponse.ok,
      smokeResponse.ok
        ? `${smokeResponse.status} ${smokeResponse.statusText}`
        : `${smokeResponse.status} ${smokeResponse.statusText}: ${excerpt(smokeText)}`,
    ),
  );
  checks.push(
    check(
      "account execution trace",
      trace.some((event) => event.type === "response" && event.status === smokeResponse.status),
      summarizeTrace(trace),
    ),
  );
  checks.push(
    check(
      "codex response text",
      normalizedSmokeText.includes(expectedText),
      normalizedSmokeText.includes(expectedText)
        ? `saw ${expectedText}`
        : `missing ${expectedText}: ${excerpt(smokeText)}`,
    ),
  );
  checks.push(
    check(
      "account success recorded",
      Boolean(usedAccount),
      usedAccount ? `account ${usedAccount.id}` : "no account lastUsedAt changed",
    ),
  );

  return report("codex-smoke", checks);
}

export async function runCodexFileSmokeDoctor(
  store: AccountStore,
  config: CliConfig,
  options: CodexFileSmokeOptions = {},
): Promise<CodexSmokeReport> {
  const fileContent = options.fileContent ?? "file-smoke\n";
  const fileName = options.fileName ?? "file-smoke.txt";
  const sessionId = options.sessionId ?? `file-smoke-${Date.now()}`;
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 2021;
  const beforeAccounts = await store.listByProvider("codex");
  const enabledAccounts = beforeAccounts.filter(isReadyOAuthAccount);
  const trace: AccountExecutionTraceEvent[] = [];
  const fetchImpl = withTimeout(options.fetch ?? fetch, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const checks: CodexSmokeReport["checks"] = [
    check(
      "codex account inventory",
      enabledAccounts.length > 0,
      `${enabledAccounts.length} ready codex/oauth account(s)`,
    ),
  ];

  const accountPool = new StickyAccountPool(store, {
    strategy: config.accountSelectionStrategy,
    softQuotaThresholdPercent: config.softQuotaThresholdPercent,
    planWeights: config.planWeights,
  });
  const gateway = createGateway({
    config: { host, port },
    accounts: store,
    providers: [
      createCodexChatGPTProvider({
        accounts: accountPool,
        fetch: fetchImpl,
        onTrace: (event) => trace.push(event),
      }),
    ],
  });

  const healthResponse = await gateway.fetch(new Request(`http://${host}:${port}/health`));
  checks.push(
    check("gateway health", healthResponse.ok, `${healthResponse.status} ${healthResponse.statusText}`),
  );

  if (enabledAccounts.length === 0) {
    return report("codex-file-smoke", checks);
  }

  const startedAt = Date.now();
  const createResponse = await gateway.fetch(
    new Request(`http://${host}:${port}/backend-api/files`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kyoli-session-id": sessionId,
      },
      body: JSON.stringify({
        file_name: fileName,
        file_size: new TextEncoder().encode(fileContent).byteLength,
        use_case: "codex",
      }),
    }),
  );
  const createBody = await readJsonRecord(createResponse);
  const fileId = readString(createBody?.file_id) ?? readString(createBody?.id);
  const uploadUrl = readString(createBody?.upload_url);

  checks.push(
    check(
      "codex file create",
      createResponse.ok && Boolean(fileId && uploadUrl),
      createResponse.ok
        ? `file_id=${fileId ?? "-"} upload_url=${uploadUrl ? "present" : "missing"}`
        : `${createResponse.status} ${createResponse.statusText}: ${excerpt(await createResponse.clone().text())}`,
    ),
  );

  let uploadResponse: Response | undefined;
  if (uploadUrl) {
    uploadResponse = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-ms-blob-type": "BlockBlob",
      },
      body: fileContent,
    });
    checks.push(
      check(
        "codex direct file upload",
        uploadResponse.ok,
        `${uploadResponse.status} ${uploadResponse.statusText}`,
      ),
    );
  } else {
    checks.push(check("codex direct file upload", false, "upload_url missing"));
  }

  let finalizeResponse: Response | undefined;
  if (fileId && uploadResponse?.ok) {
    finalizeResponse = await gateway.fetch(
      new Request(`http://${host}:${port}/backend-api/files/${encodeURIComponent(fileId)}/uploaded`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kyoli-session-id": sessionId,
        },
        body: JSON.stringify({}),
      }),
    );
    checks.push(
      check(
        "codex file finalize",
        finalizeResponse.ok,
        finalizeResponse.ok
          ? `${finalizeResponse.status} ${finalizeResponse.statusText}`
          : `${finalizeResponse.status} ${finalizeResponse.statusText}: ${excerpt(await finalizeResponse.clone().text())}`,
      ),
    );
  } else {
    checks.push(check("codex file finalize", false, "file_id missing or upload failed"));
  }

  const afterAccounts = await store.listByProvider("codex");
  const usedAccount = findRecentlyUsedAccount(beforeAccounts, afterAccounts, startedAt);
  checks.push(
    check(
      "account execution trace",
      trace.some((event) => event.type === "response" && event.status >= 200 && event.status < 300),
      summarizeTrace(trace),
    ),
  );
  checks.push(
    check(
      "account success recorded",
      Boolean(usedAccount),
      usedAccount ? `account ${usedAccount.id}` : "no account lastUsedAt changed",
    ),
  );

  return report("codex-file-smoke", checks);
}

export async function runCodexE2EDoctor(
  store: AccountStore,
  config: CliConfig,
  options: CodexE2EOptions = {},
): Promise<CodexSmokeReport> {
  const expectedText = options.expectedText ?? DEFAULT_EXPECTED_TEXT;
  const sessionId = options.sessionId ?? `codex-e2e-${Date.now()}`;
  const host = config.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const beforeAccounts = await store.listByProvider("codex");
  const enabledAccounts = beforeAccounts.filter(isReadyOAuthAccount);
  const trace: AccountExecutionTraceEvent[] = [];
  const checks: CodexSmokeReport["checks"] = [
    check(
      "codex account inventory",
      enabledAccounts.length > 0,
      `${enabledAccounts.length} ready codex/oauth account(s)`,
    ),
  ];

  const accountPool = new StickyAccountPool(store, {
    strategy: config.accountSelectionStrategy,
    softQuotaThresholdPercent: config.softQuotaThresholdPercent,
    planWeights: config.planWeights,
  });
  const server = await serveGateway({
    config: { host, port },
    accounts: store,
    stickySessions: accountPool,
    providers: [
      createCodexChatGPTProvider({
        accounts: accountPool,
        fetch: withTimeout(options.fetch ?? fetch, timeoutMs),
        onTrace: (event) => trace.push(event),
      }),
    ],
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  const clientFetch = withTimeout(options.clientFetch ?? fetch, timeoutMs);

  try {
    const healthResponse = await clientFetch(`${baseUrl}/health`);
    checks.push(
      check("server health over HTTP", healthResponse.ok, `${healthResponse.status} ${healthResponse.statusText}`),
    );

    const modelsResponse = await clientFetch(`${baseUrl}/v1/models`);
    const modelsBody = await readJsonRecord(modelsResponse);
    const model = options.model ?? selectDefaultCodexModel(modelsBody);
    checks.push(
      check(
        "OpenAI-compatible models over HTTP",
        modelsResponse.ok && modelListIncludes(modelsBody, model),
        modelsResponse.ok ? `${model} is available at ${baseUrl}/v1/models` : `${modelsResponse.status} ${modelsResponse.statusText}`,
      ),
    );

    if (enabledAccounts.length === 0) return report("codex-e2e", checks);

    const responsesText = await postResponsesE2E(clientFetch, baseUrl, model, expectedText, sessionId);
    checks.push(
      check(
        "OpenAI Responses HTTP client",
        responsesText.includes(expectedText),
        responsesText.includes(expectedText) ? `saw ${expectedText}` : `missing ${expectedText}: ${excerpt(responsesText)}`,
      ),
    );

    const chatText = await postChatCompletionsE2E(clientFetch, baseUrl, model, expectedText, sessionId);
    checks.push(
      check(
        "Generic Chat Completions bridge HTTP client",
        chatText.includes(expectedText),
        chatText.includes(expectedText) ? `saw ${expectedText}` : `missing ${expectedText}: ${excerpt(chatText)}`,
      ),
    );

    if (options.includeOpenCode) {
      const result = await runOpenCodeE2E({
        baseUrl,
        model,
        expectedText,
        command: options.openCodeCommand,
        timeoutMs,
        keepTemp: options.keepTemp,
      });
      checks.push(
        check(
          "OpenCode CLI openai Responses provider",
          result.ok,
          result.ok ? `saw ${expectedText}` : result.detail,
        ),
      );
    }

    if (options.includeCodexCli) {
      const result = await runCodexCliE2E({
        baseUrl,
        model,
        expectedText,
        command: options.codexCliCommand,
        timeoutMs,
        keepTemp: options.keepTemp,
      });
      checks.push(
        check(
          "Codex CLI backend-api Responses client",
          result.ok,
          result.ok ? `saw ${expectedText}` : result.detail,
        ),
      );
    }

    const responseEvents = trace.filter((event) => event.type === "response");
    checks.push(
      check(
        "account execution trace",
        responseEvents.some((event) => event.status >= 200 && event.status < 300),
        summarizeTrace(trace),
      ),
    );

    return report("codex-e2e", checks);
  } finally {
    server.stop(true);
  }
}

export async function runCodexLoadDoctor(
  store: AccountStore,
  config: CliConfig,
  options: CodexLoadOptions = {},
): Promise<CodexSmokeReport> {
  const route = options.route ?? "/v1/responses";
  const requests = Math.max(1, Math.floor(options.requests ?? 8));
  const concurrency = Math.max(1, Math.min(requests, Math.floor(options.concurrency ?? 2)));
  const beforeAccounts = await store.listByProvider("codex");
  const enabledAccounts = beforeAccounts.filter(isReadyOAuthAccount);
  const trace: AccountExecutionTraceEvent[] = [];
  const checks: CodexSmokeReport["checks"] = [
    check(
      "codex account inventory",
      enabledAccounts.length > 0,
      `${enabledAccounts.length} ready codex/oauth account(s)`,
    ),
  ];
  if (enabledAccounts.length === 0) return report("codex-load", checks);

  const accountPool = new StickyAccountPool(store, {
    strategy: config.accountSelectionStrategy,
    softQuotaThresholdPercent: config.softQuotaThresholdPercent,
    planWeights: config.planWeights,
  });
  const gateway = createGateway({
    config: {
      host: config.host ?? "127.0.0.1",
      port: config.port ?? 2021,
    },
    accounts: store,
    providers: [
      createCodexChatGPTProvider({
        accounts: accountPool,
        fetch: withTimeout(options.fetch ?? fetch, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        onTrace: (event) => trace.push(event),
      }),
    ],
  });
  const modelsResponse = await gateway.fetch(new Request(`http://${gateway.config.host}:${gateway.config.port}/v1/models`));
  const modelsBody = await readJsonRecord(modelsResponse);
  const model = options.model ?? selectDefaultCodexModel(modelsBody);
  checks.push(
    check(
      "codex model registry",
      modelsResponse.ok && modelListIncludes(modelsBody, model),
      modelsResponse.ok ? `${model} is available` : `${modelsResponse.status} ${modelsResponse.statusText}`,
    ),
  );

  const results = await runPool(requests, concurrency, async (index) => {
    const expectedText = `request-ok-${index}`;
    const body = route === "/v1/chat/completions"
      ? createCodexChatSmokeBody(model, expectedText)
      : createCodexSmokeBody(model, expectedText);
    const response = await gateway.fetch(
      new Request(`http://${gateway.config.host}:${gateway.config.port}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kyoli-session-id": `load-${index}`,
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    return {
      ok: response.ok && `${extractSmokeOutputText(text)} ${text}`.includes(expectedText),
      status: response.status,
      text,
    };
  });

  const failures = results.filter((result) => !result.ok);
  const selectedAccounts = new Set(
    trace
      .filter((event) => event.type === "selected")
      .map((event) => event.accountId)
      .filter(Boolean),
  );
  const rateLimits = trace.filter((event) => event.type === "response" && event.status === 429).length;

  checks.push(
    check(
      "completed requests",
      failures.length === 0,
      `${results.length - failures.length}/${requests} completed; statuses=${summarizeStatuses(results.map((result) => result.status))}`,
    ),
  );
  checks.push(
    warnCheck(
      "account distribution",
      enabledAccounts.length === 1 || selectedAccounts.size > 1,
      `${selectedAccounts.size} account(s) selected for ${requests} request(s)`,
    ),
  );
  checks.push(
    warnCheck(
      "rate-limit observation",
      rateLimits === 0,
      rateLimits === 0 ? "no 429 responses observed" : `${rateLimits} 429 response(s) observed and recorded`,
    ),
  );

  return report("codex-load", checks);
}

function createCodexSmokeBody(model: string, expectedText: string): Record<string, unknown> {
  return {
    model,
    instructions: `Reply with exactly: ${expectedText}`,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Reply with exactly: ${expectedText}`,
          },
        ],
      },
    ],
    store: false,
    stream: true,
  };
}

function createCodexChatSmokeBody(model: string, expectedText: string): Record<string, unknown> {
  return {
    model,
    messages: [
      {
        role: "user",
        content: `Reply with exactly: ${expectedText}`,
      },
    ],
    stream: true,
  };
}

async function postResponsesE2E(
  fetchImpl: typeof fetch,
  baseUrl: string,
  model: string,
  expectedText: string,
  sessionId: string,
): Promise<string> {
  const response = await fetchImpl(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kyoli-session-id": `${sessionId}:responses`,
    },
    body: JSON.stringify(createCodexSmokeBody(model, expectedText)),
  });
  const text = await response.text();
  return `${extractSmokeOutputText(text)} ${text}`;
}

async function postChatCompletionsE2E(
  fetchImpl: typeof fetch,
  baseUrl: string,
  model: string,
  expectedText: string,
  sessionId: string,
): Promise<string> {
  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-kyoli-session-id": `${sessionId}:chat`,
    },
    body: JSON.stringify(createCodexChatSmokeBody(model, expectedText)),
  });
  const text = await response.text();
  return `${extractSmokeOutputText(text)} ${text}`;
}

async function runOpenCodeE2E(input: {
  baseUrl: string;
  model: string;
  expectedText: string;
  command?: string;
  timeoutMs: number;
  keepTemp?: boolean;
}): Promise<{ ok: boolean; detail: string }> {
  const root = await mkdtemp(join(tmpdir(), "kyoli-opencode-e2e-"));
  const configHome = join(root, "config");
  const dataHome = join(tmpdir(), "kyoli-opencode-e2e-data");
  const projectDir = join(root, "project");
  const configDir = join(configHome, "opencode");
  const command = input.command ?? process.env.OPENCODE_BIN ?? "opencode";
  const modelId = stripProviderPrefix(input.model);

  try {
    await mkdir(configDir, { recursive: true });
    await mkdir(join(dataHome, "opencode"), { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(configDir, "opencode.json"),
      JSON.stringify(createOpenCodeE2EConfig(`${input.baseUrl}/v1`, modelId), null, 2),
    );
    const args = [
      "run",
      "--pure",
      "--model",
      `openai/${modelId}`,
      "--format",
      "json",
      `Reply exactly: ${input.expectedText}`,
    ];
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
    };
    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileWithTimeout(command, args, {
        cwd: projectDir,
        timeout: input.timeoutMs,
        env,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const firstOutput = readExecErrorOutput(error) ?? "";
      if (!firstOutput.includes("Database migration complete")) throw error;
      const result = await execFileWithTimeout(command, args, {
        cwd: projectDir,
        timeout: input.timeoutMs,
        env,
      });
      stdout = `${firstOutput}\n${result.stdout}`;
      stderr = result.stderr;
    }
    const output = `${stdout}\n${stderr}`;
    return {
      ok: output.includes(input.expectedText),
      detail: output.includes(input.expectedText)
        ? `saw ${input.expectedText}`
        : `missing ${input.expectedText}: ${excerpt(output)}`,
    };
  } catch (error) {
    const output = readExecErrorOutput(error);
    return {
      ok: false,
      detail: output ? excerpt(output) : error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (!input.keepTemp) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

export function createOpenCodeE2EConfig(baseURL: string, modelId: string): Record<string, unknown> {
  return {
    "$schema": "https://opencode.ai/config.json",
    share: "disabled",
    model: `openai/${modelId}`,
    provider: {
      openai: {
        options: {
          baseURL,
          apiKey: "kyoli-local-e2e",
        },
        models: {
          [modelId]: {
            name: `${modelId} via kyoli-gam`,
            reasoning: true,
            tool_call: true,
            provider: {
              npm: "@ai-sdk/openai",
            },
            limit: {
              context: 272000,
              output: 65536,
            },
          },
        },
      },
    },
    permission: {
      read: { "*": "allow" },
      edit: { "*": "allow" },
      bash: "allow",
    },
  };
}

async function runCodexCliE2E(input: {
  baseUrl: string;
  model: string;
  expectedText: string;
  command?: string;
  timeoutMs: number;
  keepTemp?: boolean;
}): Promise<{ ok: boolean; detail: string }> {
  const root = await mkdtemp(join(tmpdir(), "kyoli-codex-cli-e2e-"));
  const projectDir = join(root, "project");
  const command = input.command ?? process.env.CODEX_BIN ?? "codex";
  const modelId = stripProviderPrefix(input.model);

  try {
    await mkdir(projectDir, { recursive: true });
    const result = await execFileWithTimeout(command, createCodexCliE2EArgs({
      backendApiBaseUrl: `${input.baseUrl}/backend-api`,
      modelId,
      expectedText: input.expectedText,
      projectDir,
    }), {
      cwd: projectDir,
      timeout: input.timeoutMs,
      env: process.env,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const agentText = extractCodexCliAgentText(output);
    const haystack = `${agentText}\n${output}`;
    return {
      ok: haystack.includes(input.expectedText),
      detail: haystack.includes(input.expectedText)
        ? `saw ${input.expectedText}`
        : `missing ${input.expectedText}: ${excerpt(output)}`,
    };
  } catch (error) {
    const output = readExecErrorOutput(error);
    return {
      ok: false,
      detail: output ? excerpt(output) : error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (!input.keepTemp) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

export function createCodexCliE2EArgs(input: {
  backendApiBaseUrl: string;
  modelId: string;
  expectedText: string;
  projectDir: string;
}): string[] {
  return [
    "-a",
    "never",
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "-s",
    "read-only",
    "-C",
    input.projectDir,
    "-m",
    input.modelId,
    "-c",
    `chatgpt_base_url="${input.backendApiBaseUrl}"`,
    `Reply exactly: ${input.expectedText}`,
  ];
}

function execFileWithTimeout(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let closed = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 1000).unref();
      reject(new ExecFileError(`Command timed out after ${options.timeout}ms: ${command} ${args.join(" ")}`, stdout, stderr));
    }, options.timeout);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ExecFileError(error.message, stdout, stderr));
    });
    child.on("close", (code, signal) => {
      closed = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new ExecFileError(
        `Command failed with ${signal ? `signal ${signal}` : `code ${code}`}: ${command} ${args.join(" ")}`,
        stdout,
        stderr,
      ));
    });
  });
}

class ExecFileError extends Error {
  constructor(message: string, readonly stdout: string, readonly stderr: string) {
    super(message);
    this.name = "ExecFileError";
  }
}

function readExecErrorOutput(error: unknown): string | undefined {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const stdout = typeof record?.stdout === "string" ? record.stdout : "";
  const stderr = typeof record?.stderr === "string" ? record.stderr : "";
  const message = error instanceof Error ? error.message : "";
  const output = [message, stdout, stderr].filter(Boolean).join("\n");
  return output || undefined;
}

function extractCodexCliAgentText(output: string): string {
  const texts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = event.item && typeof event.item === "object"
        ? (event.item as Record<string, unknown>)
        : undefined;
      if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        texts.push(item.text);
      }
    } catch {
      // Ignore non-JSON diagnostic lines from the CLI.
    }
  }
  return texts.join("\n");
}

async function runPool<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      results[index] = await task(index);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarizeStatuses(statuses: number[]): string {
  const counts = new Map<number, number>();
  for (const status of statuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([status, count]) => `${status}:${count}`)
    .join(",");
}

function withTimeout(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) return fetchImpl(input, init);
    return fetchImpl(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }) as typeof fetch;
}

function isReadyOAuthAccount(account: AccountRecord): boolean {
  return Boolean(
    account.enabled &&
      account.kind === "oauth" &&
      !account.reauthRequiredReason &&
      (!account.rateLimitResetAt || new Date(account.rateLimitResetAt).getTime() <= Date.now()) &&
      (readString(account.credentials.accessToken) || readString(account.credentials.refreshToken)),
  );
}

function findRecentlyUsedAccount(
  before: AccountRecord[],
  after: AccountRecord[],
  startedAt: number,
): AccountRecord | undefined {
  const beforeLastUsed = new Map(before.map((account) => [account.id, account.lastUsedAt]));
  return after.find((account) => {
    if (!account.lastUsedAt || account.lastUsedAt === beforeLastUsed.get(account.id)) {
      return false;
    }

    return new Date(account.lastUsedAt).getTime() >= startedAt - 1000;
  });
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await response.clone().json();
    return readRecord(parsed);
  } catch {
    return undefined;
  }
}

function modelListIncludes(body: Record<string, unknown> | undefined, model: string): boolean {
  const data = body?.data;
  if (!Array.isArray(data)) return false;
  return data.some((item) => {
    const record = readRecord(item);
    const kyoli = readRecord(record?.kyoli);
    return record?.id === model ||
      kyoli?.upstream_id === model ||
      (Array.isArray(kyoli?.aliases) && kyoli.aliases.includes(model));
  });
}

export function selectDefaultCodexModel(body: Record<string, unknown> | undefined): string {
  const data = body?.data;
  if (!Array.isArray(data)) return FALLBACK_CODEX_MODEL;

  const candidates = data
    .map(readModelListItem)
    .filter((model): model is ModelListItem => Boolean(model))
    .filter((model) => model.provider === "codex")
    .filter((model) => model.capabilities.includes("codex") || model.searchText.includes("codex"));

  candidates.sort((left, right) => scoreCodexModel(right) - scoreCodexModel(left));
  return candidates[0]?.id ?? FALLBACK_CODEX_MODEL;
}

interface ModelListItem {
  id: string;
  provider: string;
  upstreamId: string;
  aliases: string[];
  capabilities: string[];
  searchText: string;
}

function readModelListItem(item: unknown): ModelListItem | undefined {
  const record = readRecord(item);
  const kyoli = readRecord(record?.kyoli);
  const id = readString(record?.id);
  const provider = readString(kyoli?.provider) ?? readString(record?.owned_by);
  const upstreamId = readString(kyoli?.upstream_id) ?? id;
  if (!id || !provider || !upstreamId) return undefined;

  const aliases = Array.isArray(kyoli?.aliases)
    ? kyoli.aliases.filter((alias): alias is string => typeof alias === "string")
    : [];
  const capabilities = Array.isArray(kyoli?.capabilities)
    ? kyoli.capabilities.filter((capability): capability is string => typeof capability === "string")
    : [];
  const displayName = readString(kyoli?.display_name) ?? "";
  return {
    id,
    provider,
    upstreamId,
    aliases,
    capabilities,
    searchText: [id, upstreamId, displayName, ...aliases, ...capabilities].join(" ").toLowerCase(),
  };
}

function scoreCodexModel(model: ModelListItem): number {
  const modelId = model.upstreamId || model.id;
  const version = modelId.match(/gpt-(\d+)(?:\.(\d+))?(?:\.(\d+))?-codex/i);
  const major = Number.parseInt(version?.[1] ?? "0", 10);
  const minor = Number.parseInt(version?.[2] ?? "0", 10);
  const patch = Number.parseInt(version?.[3] ?? "0", 10);
  const normalized = modelId.toLowerCase();
  const variantPenalty =
    normalized.includes("mini") ? 30 :
    normalized.includes("spark") ? 20 :
    normalized.includes("max") ? 10 :
    0;
  const codexBonus = model.capabilities.includes("codex") ? 100 : 0;
  return major * 1_000_000 + minor * 1_000 + patch + codexBonus - variantPenalty;
}

function summarizeTrace(trace: AccountExecutionTraceEvent[]): string {
  const responses = trace.filter((event) => event.type === "response");
  if (responses.length === 0) return "no account response events";

  return responses
    .map((event) => {
      const account = event.accountId ? event.accountId.slice(0, 8) : "configured";
      return `#${event.attempt}:${account}:${event.status}${event.retryable ? ":retry" : ""}`;
    })
    .join(" -> ");
}

function check(
  name: string,
  ok: boolean,
  detail: string,
): CodexSmokeReport["checks"][number] {
  return {
    name,
    status: ok ? "pass" : "fail",
    detail,
  };
}

function warnCheck(
  name: string,
  ok: boolean,
  detail: string,
): CodexSmokeReport["checks"][number] {
  return {
    name,
    status: ok ? "pass" : "warn",
    detail,
  };
}

function report(name: string, checks: CodexSmokeReport["checks"]): CodexSmokeReport {
  return {
    name,
    summary: {
      pass: checks.filter((check) => check.status === "pass").length,
      warn: checks.filter((check) => check.status === "warn").length,
      fail: checks.filter((check) => check.status === "fail").length,
    },
    checks,
  };
}

function excerpt(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
}

function extractSmokeOutputText(value: string): string {
  const pieces: string[] = [];
  for (const data of readSseDataFrames(value)) {
    if (data === "[DONE]") continue;
    try {
      collectOutputText(JSON.parse(data), pieces);
    } catch {
      // Non-SSE JSON or plain text responses are covered by the raw text fallback.
    }
  }
  return pieces.join("");
}

function readSseDataFrames(value: string): string[] {
  return value
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      return data ? [data] : [];
    });
}

function collectOutputText(value: unknown, pieces: string[]): void {
  const record = readRecord(value);
  if (!record) return;

  const delta = readString(record.delta);
  if (delta) pieces.push(delta);

  const outputText = readString(record.output_text);
  if (outputText) pieces.push(outputText);

  const responseOutputText = readString(readRecord(record.response)?.output_text);
  if (responseOutputText) pieces.push(responseOutputText);

  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      const choiceRecord = readRecord(choice);
      const deltaContent = readString(readRecord(choiceRecord?.delta)?.content);
      if (deltaContent) pieces.push(deltaContent);

      const messageContent = readString(readRecord(choiceRecord?.message)?.content);
      if (messageContent) pieces.push(messageContent);
    }
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
