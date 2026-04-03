import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import * as lockfile from "proper-lockfile";
import * as v from "valibot";
import { getConfigDir, getErrorCode } from "./utils";
import { PoolChainConfigSchema } from "./pool-types";
import type { PoolChainConfig } from "./pool-types";

const POOL_CONFIG_FILENAME = "multiauth-pools.json";
const FILE_MODE = 0o600;
const LOCK_OPTIONS = {
  stale: 10_000,
  retries: { retries: 10, minTimeout: 50, maxTimeout: 2000, factor: 2 },
};

function createEmptyConfig(): PoolChainConfig {
  return { pools: [], chains: [] };
}

function getGlobalConfigPath(): string {
  return join(getConfigDir(), POOL_CONFIG_FILENAME);
}

function buildTempPath(targetPath: string): string {
  return `${targetPath}.${randomBytes(8).toString("hex")}.tmp`;
}

async function resolveConfigPath(): Promise<string> {
  const projectPath = join(process.cwd(), ".opencode", POOL_CONFIG_FILENAME);
  try {
    await fs.access(projectPath);
    return projectPath;
  } catch {
  }
  return getGlobalConfigPath();
}

async function ensureConfigFileExists(targetPath: string): Promise<void> {
  await fs.mkdir(dirname(targetPath), { recursive: true });
  const emptyContent = `${JSON.stringify(createEmptyConfig(), null, 2)}\n`;
  try {
    await fs.writeFile(targetPath, emptyContent, { flag: "wx", mode: FILE_MODE });
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") throw error;
  }
}

async function writeAtomicText(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(dirname(targetPath), { recursive: true });
  const tempPath = buildTempPath(targetPath);
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: FILE_MODE });
    await fs.chmod(tempPath, FILE_MODE);
    await fs.rename(tempPath, targetPath);
    await fs.chmod(targetPath, FILE_MODE);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {}
    throw error;
  }
}

async function withConfigLock<T>(fn: (configPath: string) => Promise<T>): Promise<T> {
  const configPath = await resolveConfigPath();
  await ensureConfigFileExists(configPath);

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(configPath, LOCK_OPTIONS);
    return await fn(configPath);
  } finally {
    if (release) {
      try {
        await release();
      } catch {}
    }
  }
}

function parsePoolChainConfig(content: string): PoolChainConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  const validation = v.safeParse(PoolChainConfigSchema, parsed);
  return validation.success ? validation.output : null;
}

export async function loadPoolChainConfig(): Promise<PoolChainConfig> {
  const path = await resolveConfigPath();
  try {
    const content = await fs.readFile(path, "utf-8");
    return parsePoolChainConfig(content) ?? createEmptyConfig();
  } catch {
    return createEmptyConfig();
  }
}

export async function savePoolChainConfig(config: PoolChainConfig): Promise<void> {
  await withConfigLock(async (configPath) => {
    const validation = v.safeParse(PoolChainConfigSchema, config);
    if (!validation.success) {
      throw new Error("Invalid pool/chain config payload");
    }
    await writeAtomicText(configPath, `${JSON.stringify(validation.output, null, 2)}\n`);
  });
}
