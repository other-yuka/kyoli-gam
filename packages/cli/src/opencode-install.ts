import type { ModelInfo } from "@kyoli-gam/core";
import { stripProviderPrefix } from "@kyoli-gam/core";
import { ModelRegistry } from "@kyoli-gam/core";
import { createClaudeCodeProvider } from "@kyoli-gam/provider-claude-code";
import { createCodexChatGPTProvider } from "@kyoli-gam/provider-codex-chatgpt";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CliConfig } from "./config";

export interface OpenCodeInstallOptions {
  configDir?: string;
  dryRun?: boolean;
  force?: boolean;
  includeModels?: boolean;
  allModels?: boolean;
  preserveOpenAI?: boolean;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface OpenCodeRunOptions extends OpenCodeInstallOptions {
  command?: string;
  expectedText?: string;
  model?: string;
  timeoutMs?: number;
  keepTemp?: boolean;
}

export interface OpenCodeRunResult {
  ok: boolean;
  detail: string;
  configPath: string;
  model: string;
  rootDir?: string;
}

export interface OpenCodeRestoreOptions {
  configDir?: string;
  backupPath?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface OpenCodeRestoreResult {
  configPath: string;
  backupPath?: string;
  authPath?: string;
  authBackupPath?: string;
  dryRun: boolean;
  restored: boolean;
  authRestored: boolean;
  warnings: string[];
}

export interface OpenCodeInstallResult {
  configPath: string;
  backupPath?: string;
  authPath?: string;
  authBackupPath?: string;
  authChanged: boolean;
  dryRun: boolean;
  existed: boolean;
  changed: boolean;
  baseUrl: string;
  modelSource: "gateway" | "registry" | "none";
  providers: Array<{
    id: "openai" | "anthropic";
    modelCount: number;
    baseURL: string;
    modelIds: string[];
  }>;
  diagnostics: OpenCodeDiagnostics;
  warnings: string[];
  config: Record<string, unknown>;
}

export interface OpenCodeDiagnostics {
  mode: "server" | "plugin" | "mixed" | "unconfigured";
  pluginPackages: string[];
  serverProviders: string[];
  openAIAuth: "kyoli-local" | "oauth" | "api" | "missing" | "other";
  selectedModels: string[];
}

interface OpenCodeModelInfo {
  id: string;
  provider: "openai" | "anthropic";
  upstreamId: string;
  displayName?: string;
  capabilities: string[];
}

const KYOLI_LOCAL_API_KEY = "kyoli-local";

export async function installOpenCode(
  config: CliConfig,
  options: OpenCodeInstallOptions = {},
): Promise<OpenCodeInstallResult> {
  const includeModels = options.includeModels !== false;
  const configPath = resolveOpenCodeConfigPath(options);
  const baseUrl = normalizeServerBaseUrl(config);
  const providerBaseUrl = `${baseUrl}/v1`;
  const existing = await readOpenCodeConfig(configPath);
  const warnings: string[] = [];
  const nextConfig = cloneRecord(existing.config);
  const diagnostics = await inspectOpenCodeDiagnostics(existing.config, baseUrl, options);
  const providers: OpenCodeInstallResult["providers"] = [];
  let authPath: string | undefined;
  let authBackupPath: string | undefined;
  let authChanged = false;

  let modelSource: OpenCodeInstallResult["modelSource"] = "none";
  let models: OpenCodeModelInfo[] = [];
  if (includeModels) {
    const loaded = await loadOpenCodeModels(baseUrl, options);
    modelSource = loaded.source;
    models = options.allModels ? loaded.models : selectDefaultOpenCodeModels(loaded.models);
    warnings.push(...loaded.warnings);
  }

  ensureSchema(nextConfig);
  const grouped = groupModels(models);

  if (options.preserveOpenAI) {
    warnings.push("Preserved existing provider.openai settings; Codex/OpenAI routing was not installed.");
    providers.push({
      id: "openai",
      modelCount: 0,
      baseURL: readProviderBaseURL(nextConfig, "openai") ?? "(not installed)",
      modelIds: [],
    });
  } else {
    const openaiProvider = patchProvider(nextConfig, "openai", {
      baseURL: providerBaseUrl,
      npm: "@ai-sdk/openai",
      models: grouped.openai,
      force: Boolean(options.force),
      warnings,
    });
    providers.push({
      id: "openai",
      modelCount: openaiProvider.modelCount,
      baseURL: providerBaseUrl,
      modelIds: grouped.openai.map((model) => model.upstreamId),
    });
  }

  if (!options.preserveOpenAI) {
    const auth = await installOpenCodeOpenAIAuth(options, warnings);
    authPath = auth.authPath;
    authBackupPath = auth.authBackupPath;
    authChanged = auth.changed;
  } else {
    warnings.push("Preserved existing OpenCode auth.openai credentials; OpenAI OAuth may bypass kyoli.");
  }

  const anthropicProvider = patchProvider(nextConfig, "anthropic", {
    baseURL: providerBaseUrl,
    npm: "@ai-sdk/anthropic",
    models: grouped.anthropic,
    force: Boolean(options.force),
    warnings,
  });
  providers.push({
    id: "anthropic",
    modelCount: anthropicProvider.modelCount,
    baseURL: providerBaseUrl,
    modelIds: grouped.anthropic.map((model) => model.upstreamId),
  });

  const changed = JSON.stringify(existing.config) !== JSON.stringify(nextConfig);
  let backupPath: string | undefined;

  if (!options.dryRun && changed) {
    await mkdir(dirname(configPath), { recursive: true });
    if (existing.existed) {
      backupPath = `${configPath}.bak-${formatTimestamp(new Date())}`;
      await copyFile(configPath, backupPath);
    }
    await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  }

  return {
    configPath,
    backupPath,
    authPath,
    authBackupPath,
    authChanged,
    dryRun: Boolean(options.dryRun),
    existed: existing.existed,
    changed,
    baseUrl,
    modelSource,
    providers,
    diagnostics: {
      ...diagnostics,
      selectedModels: providers.flatMap((provider) => provider.modelIds.map((model) => `${provider.id}/${model}`)),
    },
    warnings,
    config: nextConfig,
  };
}

export async function restoreOpenCode(
  options: OpenCodeRestoreOptions = {},
): Promise<OpenCodeRestoreResult> {
  const configPath = resolveOpenCodeConfigPath(options);
  const warnings: string[] = [];
  const backupPath = options.backupPath
    ? expandPath(options.backupPath)
    : await findLatestBackupPath(configPath);
  const authPath = resolveOpenCodeAuthPath(options);
  const authBackupPath = await findLatestBackupPath(authPath);

  if (!backupPath) {
    return {
      configPath,
      authPath,
      authBackupPath,
      dryRun: Boolean(options.dryRun),
      restored: false,
      authRestored: false,
      warnings: [`No backup found for ${configPath}. Pass --backup <path> to restore a specific file.`],
    };
  }

  if (!authBackupPath) {
    warnings.push(`No auth backup found for ${authPath}; only opencode.json will be restored.`);
  }

  if (!options.dryRun) {
    await mkdir(dirname(configPath), { recursive: true });
    await copyFile(backupPath, configPath);
    if (authBackupPath) {
      await mkdir(dirname(authPath), { recursive: true });
      await copyFile(authBackupPath, authPath);
    }
  }

  return {
    configPath,
    backupPath,
    authPath,
    authBackupPath,
    dryRun: Boolean(options.dryRun),
    restored: true,
    authRestored: Boolean(authBackupPath),
    warnings,
  };
}

export async function runInstalledOpenCode(
  config: CliConfig,
  options: OpenCodeRunOptions = {},
): Promise<OpenCodeRunResult> {
  const root = await mkdtemp(join(tmpdir(), "kyoli-opencode-run-"));
  const configHome = join(root, "config");
  const dataHome = join(root, "data");
  const projectDir = join(root, "project");
  const configDir = options.configDir ?? join(configHome, "opencode");
  const expectedText = options.expectedText ?? "smoke-ok";
  const timeoutMs = options.timeoutMs ?? 120_000;
  const command = options.command ?? options.env?.OPENCODE_BIN ?? process.env.OPENCODE_BIN ?? "opencode";

  try {
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(dataHome, "opencode"), { recursive: true });
    const installEnv = {
      ...(options.env ?? {}),
      XDG_DATA_HOME: dataHome,
    };
    const install = await installOpenCode(config, {
      ...options,
      configDir,
      dryRun: false,
      force: true,
      includeModels: options.includeModels !== false,
      env: installEnv,
    });
    const model = options.model ?? selectRunnableOpenCodeModel(install.config);
    if (!model) {
      return {
        ok: false,
        detail: "No OpenAI/Codex model was generated for OpenCode.",
        configPath: install.configPath,
        model: "",
        rootDir: options.keepTemp ? root : undefined,
      };
    }

    const args = [
      "run",
      "--pure",
      "--model",
      model.includes("/") ? model : `openai/${model}`,
      "--format",
      "json",
      `Reply exactly: ${expectedText}`,
    ];
    const env = {
      ...process.env,
      ...(options.env ?? {}),
      XDG_CONFIG_HOME: dirname(configDir),
      XDG_DATA_HOME: dataHome,
    };
    let output = "";
    try {
      const result = await execFileWithTimeout(command, args, {
        cwd: projectDir,
        timeout: timeoutMs,
        env,
      });
      output = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      const firstOutput = readExecErrorOutput(error) ?? "";
      if (!firstOutput.includes("Database migration complete")) throw error;
      const result = await execFileWithTimeout(command, args, {
        cwd: projectDir,
        timeout: timeoutMs,
        env,
      });
      output = `${firstOutput}\n${result.stdout}\n${result.stderr}`;
    }

    const ok = output.includes(expectedText);
    return {
      ok,
      detail: ok ? `saw ${expectedText}` : `missing ${expectedText}: ${excerpt(output)}`,
      configPath: install.configPath,
      model: model.includes("/") ? model : `openai/${model}`,
      rootDir: options.keepTemp ? root : undefined,
    };
  } catch (error) {
    const output = readExecErrorOutput(error);
    return {
      ok: false,
      detail: output ? excerpt(output) : error instanceof Error ? error.message : String(error),
      configPath: join(configDir, "opencode.json"),
      model: options.model ?? "",
      rootDir: options.keepTemp ? root : undefined,
    };
  } finally {
    if (!options.keepTemp) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function resolveOpenCodeConfigPath(options: OpenCodeInstallOptions): string {
  const env = options.env ?? process.env;
  const configDir =
    options.configDir ??
    env.OPENCODE_CONFIG_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
  return join(expandPath(configDir), "opencode.json");
}

function resolveOpenCodeAuthPath(options: OpenCodeInstallOptions): string {
  const env = options.env ?? process.env;
  const dataDir = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(expandPath(dataDir), "opencode", "auth.json");
}

function normalizeServerBaseUrl(config: CliConfig): string {
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 2021;
  return `http://${host}:${port}`.replace(/\/+$/, "");
}

async function readOpenCodeConfig(path: string): Promise<{
  existed: boolean;
  config: Record<string, unknown>;
}> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`OpenCode config must be a JSON object: ${path}`);
    }
    return { existed: true, config: parsed };
  } catch (error) {
    if (isFileMissingError(error)) return { existed: false, config: {} };
    throw error;
  }
}

async function installOpenCodeOpenAIAuth(
  options: OpenCodeInstallOptions,
  warnings: string[],
): Promise<{
  authPath: string;
  authBackupPath?: string;
  changed: boolean;
}> {
  const authPath = resolveOpenCodeAuthPath(options);
  const existing = await readJsonRecordFile(authPath);
  const next = cloneRecord(existing.record);
  const currentOpenAI = isRecord(next.openai) ? next.openai : undefined;
  const changed = !(
    currentOpenAI?.type === "api" &&
    currentOpenAI?.key === KYOLI_LOCAL_API_KEY
  );

  if (!changed) return { authPath, changed: false };

  if (currentOpenAI?.type === "oauth") {
    warnings.push(
      "OpenCode auth.openai OAuth will be replaced with kyoli-local API auth so built-in OpenAI requests go through kyoli.",
    );
  }

  next.openai = {
    type: "api",
    key: KYOLI_LOCAL_API_KEY,
  };

  let authBackupPath: string | undefined;
  if (!options.dryRun) {
    await mkdir(dirname(authPath), { recursive: true });
    if (existing.existed) {
      authBackupPath = `${authPath}.bak-${formatTimestamp(new Date())}`;
      await copyFile(authPath, authBackupPath);
    }
    await writeFile(authPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return { authPath, authBackupPath, changed: true };
}

async function readJsonRecordFile(path: string): Promise<{
  existed: boolean;
  record: Record<string, unknown>;
}> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`JSON file must be an object: ${path}`);
    }
    return { existed: true, record: parsed };
  } catch (error) {
    if (isFileMissingError(error)) return { existed: false, record: {} };
    throw error;
  }
}


async function inspectOpenCodeDiagnostics(
  config: Record<string, unknown>,
  baseUrl: string,
  options: OpenCodeInstallOptions,
): Promise<OpenCodeDiagnostics> {
  const providerBaseUrl = `${baseUrl}/v1`;
  const pluginPackages = readOpenCodePluginPackages(config);
  const serverProviders = (["openai", "anthropic"] as const)
    .filter((provider) => readProviderBaseURL(config, provider) === providerBaseUrl);
  const auth = await readJsonRecordFile(resolveOpenCodeAuthPath(options));
  const openAIAuth = readOpenAIAuthStatus(auth.record.openai);
  const hasPlugin = pluginPackages.length > 0;
  const hasServer = serverProviders.length > 0 || openAIAuth === "kyoli-local";

  return {
    mode: hasPlugin && hasServer ? "mixed" : hasServer ? "server" : hasPlugin ? "plugin" : "unconfigured",
    pluginPackages,
    serverProviders,
    openAIAuth,
    selectedModels: [],
  };
}

function readOpenAIAuthStatus(value: unknown): OpenCodeDiagnostics["openAIAuth"] {
  if (!isRecord(value)) return "missing";
  if (value.type === "api" && value.key === KYOLI_LOCAL_API_KEY) return "kyoli-local";
  if (value.type === "oauth") return "oauth";
  if (value.type === "api") return "api";
  return "other";
}

function readOpenCodePluginPackages(config: Record<string, unknown>): string[] {
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  return plugins
    .map((plugin) => {
      if (typeof plugin === "string") return plugin;
      if (Array.isArray(plugin) && typeof plugin[0] === "string") return plugin[0];
      return undefined;
    })
    .filter((plugin): plugin is string => Boolean(plugin?.startsWith("opencode-") && plugin.includes("multi-account")));
}

async function loadOpenCodeModels(
  baseUrl: string,
  options: OpenCodeInstallOptions,
): Promise<{
  source: "gateway" | "registry";
  models: OpenCodeModelInfo[];
  warnings: string[];
}> {
  const fromGateway = await loadModelsFromGateway(baseUrl, options.fetch ?? fetch);
  if (fromGateway.models.length > 0) return { source: "gateway", ...fromGateway };

  const registry = new ModelRegistry([createCodexChatGPTProvider(), createClaudeCodeProvider()]);
  const registryModels = await registry.listModels();
  return {
    source: "registry",
    models: registryModels.map(toOpenCodeModelInfo).filter(isSupportedOpenCodeModel),
    warnings: fromGateway.warnings,
  };
}

async function loadModelsFromGateway(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ models: OpenCodeModelInfo[]; warnings: string[] }> {
  try {
    const response = await fetchImpl(`${baseUrl}/v1/models`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return {
        models: [],
        warnings: [`Could not read ${baseUrl}/v1/models (${response.status}); using local registry fallback.`],
      };
    }
    const body = await response.json() as unknown;
    return {
      models: readGatewayModels(body).filter(isSupportedOpenCodeModel),
      warnings: [],
    };
  } catch (error) {
    return {
      models: [],
      warnings: [
        `Could not reach kyoli server at ${baseUrl}; using local registry fallback.`,
        error instanceof Error ? error.message : String(error),
      ],
    };
  }
}

function readGatewayModels(value: unknown): OpenCodeModelInfo[] {
  const record = isRecord(value) ? value : {};
  const data = Array.isArray(record.data) ? record.data : [];
  return data
    .map((entry): OpenCodeModelInfo | undefined => {
      if (!isRecord(entry) || typeof entry.id !== "string") return undefined;
      const kyoli = isRecord(entry.kyoli) ? entry.kyoli : {};
      const publicProvider = readPublicProvider(entry.id);
      if (!publicProvider) return undefined;
      const upstreamId =
        typeof kyoli.upstream_id === "string"
          ? kyoli.upstream_id
          : stripProviderPrefix(entry.id);
      const capabilities = Array.isArray(kyoli.capabilities)
        ? kyoli.capabilities.filter((capability): capability is string => typeof capability === "string")
        : [];
      return {
        id: entry.id,
        provider: publicProvider,
        upstreamId,
        displayName: typeof kyoli.display_name === "string" ? kyoli.display_name : undefined,
        capabilities,
      };
    })
    .filter((model): model is OpenCodeModelInfo => Boolean(model));
}

function toOpenCodeModelInfo(model: ModelInfo): OpenCodeModelInfo {
  return {
    id: model.id,
    provider: readPublicProvider(model.id) ?? (model.provider === "codex" ? "openai" : "anthropic"),
    upstreamId: model.upstreamId,
    displayName: model.displayName,
    capabilities: model.capabilities,
  };
}

function isSupportedOpenCodeModel(model: OpenCodeModelInfo): boolean {
  if (model.provider === "openai") {
    return model.capabilities.includes("codex") || model.upstreamId.includes("codex");
  }
  return model.provider === "anthropic" && model.capabilities.includes("messages");
}

function selectDefaultOpenCodeModels(models: OpenCodeModelInfo[]): OpenCodeModelInfo[] {
  const selected: OpenCodeModelInfo[] = [];
  const openai = models.filter((model) => model.provider === "openai");
  const anthropic = models.filter((model) => model.provider === "anthropic");
  const preferredOpenAI =
    findByUpstream(openai, "gpt-5.3-codex") ??
    findByUpstream(openai, "gpt-5.3-codex-spark") ??
    openai.find((model) => model.upstreamId.includes("codex"));
  const preferredAnthropic =
    findByUpstream(anthropic, "claude-sonnet-5") ??
    findByUpstream(anthropic, "claude-sonnet-4-5") ??
    anthropic.find((model) => model.upstreamId.includes("sonnet")) ??
    anthropic[0];
  if (preferredOpenAI) selected.push(preferredOpenAI);
  if (preferredAnthropic) selected.push(preferredAnthropic);
  return selected;
}

function findByUpstream(
  models: OpenCodeModelInfo[],
  upstreamId: string,
): OpenCodeModelInfo | undefined {
  return models.find((model) => model.upstreamId === upstreamId);
}

function groupModels(models: OpenCodeModelInfo[]): Record<"openai" | "anthropic", OpenCodeModelInfo[]> {
  return {
    openai: dedupeByUpstreamId(models.filter((model) => model.provider === "openai")),
    anthropic: dedupeByUpstreamId(models.filter((model) => model.provider === "anthropic")),
  };
}

function patchProvider(
  config: Record<string, unknown>,
  providerId: "openai" | "anthropic",
  input: {
    baseURL: string;
    npm: string;
    models: OpenCodeModelInfo[];
    force: boolean;
    warnings: string[];
  },
): { modelCount: number } {
  const providerRoot = ensureRecord(config, "provider");
  const provider = ensureRecord(providerRoot, providerId);
  const options = ensureRecord(provider, "options");
  const previousBaseUrl = typeof options.baseURL === "string" ? options.baseURL : undefined;
  if (previousBaseUrl && previousBaseUrl !== input.baseURL) {
    input.warnings.push(
      `provider.${providerId}.options.baseURL will change from ${previousBaseUrl} to ${input.baseURL}. Existing direct ${providerId} API traffic in OpenCode will go through kyoli after install. A backup is written before applying changes.`,
    );
  }

  provider.npm ??= input.npm;
  provider.name = providerId === "openai" ? "OpenAI via kyoli-gam" : "Anthropic via kyoli-gam";
  options.baseURL = input.baseURL;
  options.apiKey = typeof options.apiKey === "string" && options.apiKey.length > 0
    ? options.apiKey
    : KYOLI_LOCAL_API_KEY;

  const modelConfig = ensureRecord(provider, "models");
  let modelCount = 0;
  for (const model of input.models) {
    const key = model.upstreamId;
    const existing = modelConfig[key];
    if (existing && !input.force && !isKyoliManagedModel(existing)) {
      input.warnings.push(`provider.${providerId}.models.${key} already exists; preserved existing model config.`);
      continue;
    }
    modelConfig[key] = toOpenCodeModelConfig(model, providerId);
    modelCount += 1;
  }

  return { modelCount };
}

function readProviderBaseURL(
  config: Record<string, unknown>,
  providerId: "openai" | "anthropic",
): string | undefined {
  const providerRoot = isRecord(config.provider) ? config.provider : {};
  const provider = isRecord(providerRoot[providerId]) ? providerRoot[providerId] : {};
  const options = isRecord(provider.options) ? provider.options : {};
  return typeof options.baseURL === "string" ? options.baseURL : undefined;
}

function toOpenCodeModelConfig(
  model: OpenCodeModelInfo,
  providerId: "openai" | "anthropic",
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: `${model.displayName ?? model.upstreamId} via kyoli-gam`,
    limit: defaultLimit(model),
    modalities: {
      input: ["text", "image"],
      output: ["text"],
    },
  };
  if (model.capabilities.includes("tools")) config.tool_call = true;
  if (model.capabilities.includes("reasoning")) config.reasoning = true;
  if (providerId === "openai") {
    config.provider = { npm: "@ai-sdk/openai" };
  }
  return config;
}

function defaultLimit(model: OpenCodeModelInfo): { context: number; output: number } {
  if (model.provider === "anthropic") return { context: 200000, output: 64000 };
  if (model.upstreamId.includes("gpt-5.4")) return { context: 1050000, output: 128000 };
  return { context: 272000, output: 65536 };
}

function isKyoliManagedModel(value: unknown): boolean {
  return isRecord(value) && typeof value.name === "string" && value.name.includes("via kyoli-gam");
}

function ensureSchema(config: Record<string, unknown>): void {
  config.$schema ??= "https://opencode.ai/config.json";
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function readPublicProvider(modelId: string): "openai" | "anthropic" | undefined {
  const [provider] = modelId.split("/", 1);
  return provider === "openai" || provider === "anthropic" ? provider : undefined;
}

function dedupeByUpstreamId(models: OpenCodeModelInfo[]): OpenCodeModelInfo[] {
  const byId = new Map<string, OpenCodeModelInfo>();
  for (const model of models) byId.set(model.upstreamId, model);
  return [...byId.values()].sort((a, b) => a.upstreamId.localeCompare(b.upstreamId));
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFileMissingError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function expandPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

async function findLatestBackupPath(configPath: string): Promise<string | undefined> {
  const dir = dirname(configPath);
  const base = configPath.slice(dir.length + 1);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const prefix = `${base}.bak-`;
  const backups = names
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();
  const [latest] = backups;
  return latest ? join(dir, latest) : undefined;
}

function selectRunnableOpenCodeModel(config: Record<string, unknown>): string | undefined {
  const provider = isRecord(config.provider) ? config.provider : {};
  const openai = isRecord(provider.openai) ? provider.openai : {};
  const models = isRecord(openai.models) ? Object.keys(openai.models) : [];
  return models.find((model) => model === "gpt-5.3-codex") ??
    models.find((model) => model.includes("codex")) ??
    models[0];
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

function excerpt(text: string, maxLength = 1200): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...`;
}
