import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AccountSelectionStrategy = "sticky" | "round-robin" | "weighted";
export type LogLevel = "silent" | "info" | "debug";

export interface CliConfig {
  host?: string;
  port?: number;
  databasePath?: string;
  accountSelectionStrategy?: AccountSelectionStrategy;
  softQuotaThresholdPercent?: number;
  planWeights?: Record<string, number>;
  usageRefreshIntervalMs?: number;
  maxConcurrentRequests?: number;
  adminToken?: string;
  logLevel?: LogLevel;
}

export async function loadCliConfig(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliConfig> {
  const configPath = resolveConfigPath(argv, env);
  const fileConfig = await readConfigFile(configPath);
  const defaults = createDefaultCliConfig();

  return {
    host: env.KYOLI_HOST ?? fileConfig.host ?? defaults.host,
    port: readPortArg(argv) ?? readNumber(env.KYOLI_PORT) ?? fileConfig.port ?? defaults.port,
    databasePath: expandPath(
      env.KYOLI_DATABASE_PATH ?? fileConfig.databasePath ?? defaults.databasePath,
    ),
    accountSelectionStrategy:
      readSelectionStrategy(env.KYOLI_ACCOUNT_SELECTION_STRATEGY) ??
      fileConfig.accountSelectionStrategy ??
      defaults.accountSelectionStrategy,
    softQuotaThresholdPercent:
      readNumber(env.KYOLI_SOFT_QUOTA_THRESHOLD_PERCENT) ??
      fileConfig.softQuotaThresholdPercent ??
      defaults.softQuotaThresholdPercent,
    planWeights: readPlanWeightsEnv(env.KYOLI_PLAN_WEIGHTS) ?? fileConfig.planWeights ?? defaults.planWeights,
    usageRefreshIntervalMs:
      readNumber(env.KYOLI_USAGE_REFRESH_INTERVAL_MS) ??
      fileConfig.usageRefreshIntervalMs ??
      defaults.usageRefreshIntervalMs,
    maxConcurrentRequests:
      readInteger(env.KYOLI_MAX_CONCURRENT_REQUESTS) ??
      fileConfig.maxConcurrentRequests ??
      defaults.maxConcurrentRequests,
    adminToken: env.KYOLI_ADMIN_TOKEN ?? fileConfig.adminToken,
    logLevel: readLogLevel(env.KYOLI_LOG_LEVEL) ?? fileConfig.logLevel ?? defaults.logLevel,
  };
}

export function resolveConfigPath(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return expandPath(readStringArg(argv, "--config") ?? env.KYOLI_CONFIG_PATH ?? defaultConfigPath(env))!;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "kyoli-gam", "config.json");
}

export function createDefaultCliConfig(): Required<CliConfig> {
  return {
    host: "127.0.0.1",
    port: 2021,
    databasePath: join("~", ".local", "share", "kyoli-gam", "kyoli.db"),
    accountSelectionStrategy: "round-robin",
    softQuotaThresholdPercent: 100,
    planWeights: {
      max: 3,
      pro: 2,
      free: 1,
    },
    usageRefreshIntervalMs: 300_000,
    maxConcurrentRequests: 0,
    adminToken: "",
    logLevel: "info",
  };
}

export async function initCliConfig(
  path: string,
  options: { force?: boolean } = {},
): Promise<"created" | "overwritten" | "exists"> {
  const target = expandPath(path)!;
  const existed = await fileExists(target);
  if (existed && !options.force) return "exists";

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(createDefaultCliConfig(), null, 2)}\n`, "utf-8");
  return existed ? "overwritten" : "created";
}

async function readConfigFile(path: string): Promise<CliConfig> {
  try {
    const parsed = JSON.parse(await readFile(expandPath(path)!, "utf-8")) as unknown;
    return normalizeConfig(parsed);
  } catch {
    return {};
  }
}

function normalizeConfig(value: unknown): CliConfig {
  const record = readRecord(value);
  if (!record) return {};

  return {
    host: readString(record.host),
    port: readNumber(record.port),
    databasePath: expandPath(readString(record.databasePath)),
    accountSelectionStrategy: readSelectionStrategy(record.accountSelectionStrategy),
    softQuotaThresholdPercent: readNumber(record.softQuotaThresholdPercent),
    planWeights: readPlanWeightsObject(record.planWeights),
    usageRefreshIntervalMs: readNumber(record.usageRefreshIntervalMs),
    maxConcurrentRequests: readInteger(record.maxConcurrentRequests),
    adminToken: readString(record.adminToken),
    logLevel: readLogLevel(record.logLevel),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function readStringArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;

  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readPortArg(argv: string[]): number | undefined {
  const port = readStringArg(argv, "--port");
  return readNumber(port);
}

function readSelectionStrategy(value: unknown): AccountSelectionStrategy | undefined {
  if (value === "sticky" || value === "round-robin" || value === "weighted") {
    return value;
  }
  return undefined;
}

function readLogLevel(value: unknown): LogLevel | undefined {
  if (value === "silent" || value === "info" || value === "debug") {
    return value;
  }
  return undefined;
}

function readPlanWeightsEnv(value: string | undefined): Record<string, number> | undefined {
  if (!value) return undefined;

  const weights: Record<string, number> = {};
  for (const entry of value.split(",")) {
    const [plan, rawWeight] = entry.split("=");
    const weight = readNumber(rawWeight);
    if (plan && weight && weight > 0) {
      weights[plan.trim().toLowerCase()] = weight;
    }
  }

  return Object.keys(weights).length > 0 ? weights : undefined;
}

function readPlanWeightsObject(value: unknown): Record<string, number> | undefined {
  const record = readRecord(value);
  if (!record) return undefined;

  const weights: Record<string, number> = {};
  for (const [plan, rawWeight] of Object.entries(record)) {
    const weight = readNumber(rawWeight);
    if (weight && weight > 0) {
      weights[plan.trim().toLowerCase()] = weight;
    }
  }

  return Object.keys(weights).length > 0 ? weights : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function expandPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return undefined;

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readInteger(value: unknown): number | undefined {
  const parsed = readNumber(value);
  if (parsed === undefined) return undefined;
  return Math.max(0, Math.floor(parsed));
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
