import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliConfig } from "./config";

export interface CodexInstallOptions {
  configDir?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface CodexRestoreOptions {
  configDir?: string;
  backupPath?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface CodexInstallResult {
  configPath: string;
  backupPath?: string;
  dryRun: boolean;
  existed: boolean;
  changed: boolean;
  baseUrl: string;
  providerId: "kyoli";
  providerBaseUrl: string;
  warnings: string[];
  config: string;
}

export interface CodexRestoreResult {
  configPath: string;
  backupPath?: string;
  dryRun: boolean;
  restored: boolean;
  warnings: string[];
}

const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";
const DEFAULT_REASONING_EFFORT = "high";
const PROVIDER_ID = "kyoli";

export async function installCodexCli(
  config: CliConfig,
  options: CodexInstallOptions = {},
): Promise<CodexInstallResult> {
  const configPath = resolveCodexConfigPath(options);
  const baseUrl = normalizeServerBaseUrl(config);
  const providerBaseUrl = `${baseUrl}/backend-api/codex`;
  const existing = await readCodexConfig(configPath);
  const warnings: string[] = [];
  const nextConfig = patchCodexConfig(existing.config, {
    providerBaseUrl,
    warnings,
  });
  const changed = existing.config !== nextConfig;
  let backupPath: string | undefined;

  if (!options.dryRun && changed) {
    await mkdir(dirname(configPath), { recursive: true });
    if (existing.existed) {
      backupPath = `${configPath}.bak-${formatTimestamp(new Date())}`;
      await copyFile(configPath, backupPath);
    }
    await writeFile(configPath, nextConfig, "utf8");
  }

  return {
    configPath,
    backupPath,
    dryRun: Boolean(options.dryRun),
    existed: existing.existed,
    changed,
    baseUrl,
    providerId: PROVIDER_ID,
    providerBaseUrl,
    warnings,
    config: nextConfig,
  };
}

export async function restoreCodexCli(
  options: CodexRestoreOptions = {},
): Promise<CodexRestoreResult> {
  const configPath = resolveCodexConfigPath(options);
  const backupPath = options.backupPath
    ? expandPath(options.backupPath)
    : await findLatestBackupPath(configPath);

  if (!backupPath) {
    return {
      configPath,
      dryRun: Boolean(options.dryRun),
      restored: false,
      warnings: [`No backup found for ${configPath}. Pass --backup <path> to restore a specific file.`],
    };
  }

  if (!options.dryRun) {
    await mkdir(dirname(configPath), { recursive: true });
    await copyFile(backupPath, configPath);
  }

  return {
    configPath,
    backupPath,
    dryRun: Boolean(options.dryRun),
    restored: true,
    warnings: [],
  };
}

function patchCodexConfig(
  configText: string,
  input: {
    providerBaseUrl: string;
    warnings: string[];
  },
): string {
  let lines = configText.length > 0 ? configText.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.at(-1) === "") lines = lines.slice(0, -1);

  if (lines.some((line) => /^\s*chatgpt_base_url\s*=/.test(line))) {
    input.warnings.push("Removed global chatgpt_base_url override; Codex CLI now uses model_provider = \"kyoli\".");
  }
  lines = lines.filter((line) => !/^\s*chatgpt_base_url\s*=/.test(line));
  lines = removeSection(lines, "model_providers.kyoli");
  lines = setTopLevelTomlString(lines, "model", DEFAULT_CODEX_MODEL, { onlyIfMissing: true });
  lines = setTopLevelTomlString(lines, "model_provider", PROVIDER_ID);
  lines = setTopLevelTomlString(lines, "model_reasoning_effort", DEFAULT_REASONING_EFFORT, { onlyIfMissing: true });

  const section = [
    `[model_providers.${PROVIDER_ID}]`,
    `name = "OpenAI" # required by Codex CLI for remote /responses/compact`,
    `base_url = "${escapeTomlString(input.providerBaseUrl)}"`,
    `wire_api = "responses"`,
    `supports_websockets = true`,
    `requires_openai_auth = true`,
  ];
  lines = insertSectionAfterTopLevel(lines, section);

  return `${trimTrailingBlankLines(lines).join("\n")}\n`;
}

function setTopLevelTomlString(
  lines: string[],
  key: string,
  value: string,
  options: { onlyIfMissing?: boolean } = {},
): string[] {
  const tableIndex = firstTableIndex(lines);
  const searchEnd = tableIndex === -1 ? lines.length : tableIndex;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const existingIndex = lines.slice(0, searchEnd).findIndex((line) => pattern.test(line));
  if (existingIndex !== -1) {
    if (options.onlyIfMissing) return lines;
    const next = [...lines];
    next[existingIndex] = `${key} = "${escapeTomlString(value)}"`;
    return next;
  }

  const insertAt = findTopLevelInsertIndex(lines);
  const next = [...lines];
  next.splice(insertAt, 0, `${key} = "${escapeTomlString(value)}"`);
  return next;
}

function insertSectionAfterTopLevel(lines: string[], section: string[]): string[] {
  const insertAt = firstTableIndex(lines);
  const next = [...lines];
  const block = [...section, ""];
  if (insertAt === -1) {
    if (next.length > 0 && next.at(-1) !== "") next.push("");
    next.push(...section);
    return next;
  }

  if (insertAt > 0 && next[insertAt - 1] !== "") {
    block.unshift("");
  }
  next.splice(insertAt, 0, ...block);
  return next;
}

function removeSection(lines: string[], sectionName: string): string[] {
  const next: string[] = [];
  let removing = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1];
    if (header) {
      removing = header === sectionName || header.startsWith(`${sectionName}.`);
    }
    if (!removing) next.push(line);
  }
  return trimRepeatedBlankLines(next);
}

function findTopLevelInsertIndex(lines: string[]): number {
  const tableIndex = firstTableIndex(lines);
  const searchEnd = tableIndex === -1 ? lines.length : tableIndex;
  let insertAt = searchEnd;
  while (insertAt > 0 && lines[insertAt - 1] === "") insertAt -= 1;
  return insertAt;
}

function firstTableIndex(lines: string[]): number {
  return lines.findIndex((line) => /^\s*\[/.test(line));
}

async function readCodexConfig(path: string): Promise<{ existed: boolean; config: string }> {
  try {
    return { existed: true, config: await readFile(path, "utf8") };
  } catch (error) {
    if (isFileMissingError(error)) return { existed: false, config: "" };
    throw error;
  }
}

function resolveCodexConfigPath(options: CodexInstallOptions | CodexRestoreOptions): string {
  const env = options.env ?? process.env;
  const configDir = options.configDir ?? env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(expandPath(configDir), "config.toml");
}

function normalizeServerBaseUrl(config: CliConfig): string {
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 2021;
  return `http://${host}:${port}`.replace(/\/+$/, "");
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
  const [latest] = names
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();
  return latest ? join(dir, latest) : undefined;
}

function trimRepeatedBlankLines(lines: string[]): string[] {
  const next: string[] = [];
  for (const line of lines) {
    if (line === "" && next.at(-1) === "") continue;
    next.push(line);
  }
  return next;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const next = [...lines];
  while (next.at(-1) === "") next.pop();
  return next;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFileMissingError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}
