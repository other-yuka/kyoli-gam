import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import * as v from "valibot";
import { PluginConfigSchema } from "./types";
import type { PluginConfig } from "./types";

export type CoreConfig = Pick<PluginConfig, "quiet_mode" | "debug">;

const DEFAULT_CONFIG_FILENAME = "multiauth-config.json";
const DEFAULT_CONFIG: PluginConfig = v.parse(PluginConfigSchema, {});

let configFilename = DEFAULT_CONFIG_FILENAME;
let cachedConfig: PluginConfig | null = null;
let externalConfigGetter: (() => PluginConfig) | null = null;

function getConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR
    || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

function getConfigPath(): string {
  return join(getConfigDir(), configFilename);
}

function parseConfig(raw: unknown): PluginConfig {
  const result = v.safeParse(PluginConfigSchema, raw);
  return result.success ? result.output : DEFAULT_CONFIG;
}

export function initCoreConfig(filename: string): void {
  configFilename = filename || DEFAULT_CONFIG_FILENAME;
  cachedConfig = null;
}

export async function loadConfig(): Promise<PluginConfig> {
  if (cachedConfig) return cachedConfig;

  const path = getConfigPath();
  try {
    const content = await fs.readFile(path, "utf-8");
    cachedConfig = parseConfig(JSON.parse(content));
  } catch {
    cachedConfig = DEFAULT_CONFIG;
  }

  return cachedConfig;
}

export function getConfig(): PluginConfig {
  if (cachedConfig) return cachedConfig;

  if (externalConfigGetter && externalConfigGetter !== getConfig) {
    try {
      return parseConfig(externalConfigGetter());
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  return DEFAULT_CONFIG;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

export function setConfigGetter(getter: () => PluginConfig): void {
  if (getter === getConfig) {
    return;
  }
  externalConfigGetter = getter;
}

export async function updateConfigField<K extends keyof PluginConfig>(
  key: K,
  value: PluginConfig[K],
): Promise<void> {
  const path = getConfigPath();

  let existing: Record<string, unknown> = {};
  try {
    const content = await fs.readFile(path, "utf-8");
    existing = JSON.parse(content) as Record<string, unknown>;
  } catch {}

  existing[key] = value;

  await fs.mkdir(dirname(path), { recursive: true });
  const content = `${JSON.stringify(existing, null, 2)}\n`;
  const tempPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, path);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {}
    throw error;
  }

  cachedConfig = null;
  await loadConfig();
}
