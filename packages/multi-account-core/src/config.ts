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

export interface ConfigLoader {
  getConfig(): PluginConfig;
  loadConfig(): Promise<PluginConfig>;
  resetConfigCache(): void;
  updateConfigField<K extends keyof PluginConfig>(key: K, value: PluginConfig[K]): Promise<void>;
}

function getConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR
    || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

function parseConfig(raw: unknown): PluginConfig {
  const result = v.safeParse(PluginConfigSchema, raw);
  return result.success ? result.output : DEFAULT_CONFIG;
}

export function createConfigLoader(filename: string = DEFAULT_CONFIG_FILENAME): ConfigLoader {
  let cachedConfig: PluginConfig | null = null;

  function getConfigPath(): string {
    return join(getConfigDir(), filename);
  }

  async function loadConfig(): Promise<PluginConfig> {
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

  function getConfig(): PluginConfig {
    return cachedConfig ?? DEFAULT_CONFIG;
  }

  function resetConfigCache(): void {
    cachedConfig = null;
  }

  async function updateConfigField<K extends keyof PluginConfig>(
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

    resetConfigCache();
    await loadConfig();
  }

  return {
    getConfig,
    loadConfig,
    resetConfigCache,
    updateConfigField,
  };
}

let defaultLoader = createConfigLoader();

export function initCoreConfig(filename: string): void {
  defaultLoader = createConfigLoader(filename);
}

export async function loadConfig(): Promise<PluginConfig> {
  return defaultLoader.loadConfig();
}

export function getConfig(): PluginConfig {
  return defaultLoader.getConfig();
}

export function resetConfigCache(): void {
  defaultLoader.resetConfigCache();
}

/**
 * @deprecated Provider-scoped config should use createConfigLoader() instead.
 * Kept as a no-op for backward compatibility with external consumers.
 */
export function setConfigGetter(_getter: () => PluginConfig): void {
}

export async function updateConfigField<K extends keyof PluginConfig>(
  key: K,
  value: PluginConfig[K],
): Promise<void> {
  await defaultLoader.updateConfigField(key, value);
}
