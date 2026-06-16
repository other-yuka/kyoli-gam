import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export interface ClaudeCodeOAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  baseApiUrl: string;
  source: "detected" | "cached" | "fallback" | "override";
  ccPath?: string;
  ccHash?: string;
}

type ClaudeCodeOAuthConfigPayload = Omit<
  ClaudeCodeOAuthConfig,
  "source" | "ccPath" | "ccHash"
>;

const CONFIG_SCAN_WINDOW_CHARS = 4096;
const CONFIG_SCAN_LOOKBACK_CHARS = 2048;
const CACHE_FILE_NAME = "claude-code-oauth-config-cache.json";
const KNOWN_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLIENT_ID_ASSIGNMENT_PATTERN = /\b(?:CLIENT_ID|[A-Z_]+CLIENT_ID)\s*:\s*"([0-9a-f-]{36})"/gi;
const SAFE_FALLBACK_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const fallbackPayload: ClaudeCodeOAuthConfigPayload = {
  clientId: KNOWN_CLIENT_ID,
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  scopes: SAFE_FALLBACK_SCOPES,
  baseApiUrl: "https://api.anthropic.com",
};

const fallbackConfig: ClaudeCodeOAuthConfig = {
  ...fallbackPayload,
  source: "fallback",
};

let memoizedConfig: ClaudeCodeOAuthConfig | null = null;

export async function detectClaudeCodeOAuthConfig(): Promise<ClaudeCodeOAuthConfig> {
  if (memoizedConfig) return memoizedConfig;

  try {
    const ccPath = findClaudeCodeBinary();
    if (!ccPath) {
      memoizedConfig = applyEnvOverride(fallbackConfig);
      return memoizedConfig;
    }

    const ccHash = await fingerprintFile(ccPath);
    const cachedConfig = await loadCachedConfig(ccHash);
    if (cachedConfig) {
      memoizedConfig = applyEnvOverride({
        ...cachedConfig,
        source: "cached",
        ccPath,
        ccHash,
      });
      return memoizedConfig;
    }

    const binary = await readFile(ccPath);
    const scannedConfig = scanBinaryForOAuthConfig(binary);
    if (!scannedConfig) {
      memoizedConfig = applyEnvOverride({
        ...fallbackPayload,
        source: "fallback",
        ccPath,
        ccHash,
      });
      return memoizedConfig;
    }

    await saveCachedConfig(ccHash, scannedConfig);
    memoizedConfig = applyEnvOverride({
      ...scannedConfig,
      source: "detected",
      ccPath,
      ccHash,
    });
    return memoizedConfig;
  } catch {
    memoizedConfig = applyEnvOverride(fallbackConfig);
    return memoizedConfig;
  }
}

export function resetClaudeCodeOAuthConfigForTest(): void {
  memoizedConfig = null;
}

export function findClaudeCodeBinary(): string | undefined {
  const override = process.env.KYOLI_CLAUDE_CODE_PATH;
  if (override && existsSync(override)) return override;

  const currentPlatform = platform();
  const delimiter = currentPlatform === "win32" ? ";" : ":";
  const binaryNames = currentPlatform === "win32"
    ? ["claude.exe", "claude.cmd", "claude"]
    : ["claude"];
  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) => binaryNames.map((name) => join(dir, name)));

  const home = homedir();
  const knownCandidates = currentPlatform === "win32"
    ? [
        join(home, ".local", "bin", "claude.exe"),
        join(home, "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
        join(home, ".claude", "local", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
      ]
    : [
        join(home, ".local", "bin", "claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
        "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
        join(home, ".claude", "local", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
        join(home, ".claude", "local", "node_modules", "@anthropic-ai", "claude-code", "cli.mjs"),
      ];

  const candidates = [...pathCandidates, ...knownCandidates].filter((candidate, index, all) =>
    all.indexOf(candidate) === index && existsSync(candidate)
  );

  if (candidates.length <= 1) return candidates[0];

  return candidates
    .map((candidate) => ({ path: candidate, version: probeClaudeVersion(candidate) }))
    .filter((candidate) => candidate.version)
    .sort((left, right) => compareVersionStrings(right.version, left.version))[0]?.path
    ?? candidates[0];
}

export function probeClaudeVersion(path: string): string | undefined {
  try {
    const output = execFileSync(path, ["--version"], {
      timeout: 2000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: platform() === "win32" && /\.(cmd|bat)$/i.test(path),
    });
    return output.match(/(\d+\.\d+\.\d+(?:[.-][\w.-]+)?)/)?.[1];
  } catch {
    return undefined;
  }
}

function compareVersionStrings(left: string | undefined, right: string | undefined): number {
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fingerprintFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex").slice(0, 16);
}

function scanBinaryForOAuthConfig(buffer: Buffer): ClaudeCodeOAuthConfigPayload | undefined {
  const text = buffer.toString("latin1");
  const matches = [...text.matchAll(CLIENT_ID_ASSIGNMENT_PATTERN)];

  const candidates = matches
    .map((match) => {
      const index = match.index ?? 0;
      const block = text.slice(
        Math.max(0, index - CONFIG_SCAN_LOOKBACK_CHARS),
        Math.min(text.length, index + CONFIG_SCAN_WINDOW_CHARS),
      );
      const payload = normalizePayload({
        clientId: match[1] ?? fallbackPayload.clientId,
        authorizeUrl:
          pickNearestValue(block, index, /CLAUDE_AI_AUTHORIZE_URL\s*:\s*"(https?:\/\/[^\"]*\/oauth\/authorize[^\"]*)"/gi)
          ?? fallbackPayload.authorizeUrl,
        tokenUrl:
          pickNearestValue(block, index, /TOKEN_URL\s*:\s*"(https:\/\/[^"]*\/oauth\/token[^"]*)"/gi)
          ?? fallbackPayload.tokenUrl,
        scopes:
          pickNearestValue(block, index, /SCOPES\s*:\s*"([^"]+)"/gi)
          ?? pickNearestValue(block, index, /scope[s]?\s*:\s*"([^"]+)"/gi)
          ?? fallbackPayload.scopes,
        baseApiUrl:
          pickNearestValue(block, index, /BASE_API_URL\s*:\s*"(https?:\/\/[^\"]+)"/gi)
          ?? fallbackPayload.baseApiUrl,
      });

      return isValidPayload(payload)
        ? { payload, score: scorePayload(payload) }
        : undefined;
    })
    .filter((candidate): candidate is { payload: ClaudeCodeOAuthConfigPayload; score: number } =>
      candidate !== undefined
    )
    .sort((left, right) => right.score - left.score);

  return candidates.find((candidate) => candidate.payload.clientId === KNOWN_CLIENT_ID)?.payload
    ?? candidates[0]?.payload;
}

function pickNearestValue(block: string, centerIndex: number, pattern: RegExp): string | undefined {
  let nearest: string | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const match of block.matchAll(pattern)) {
    const distance = Math.abs((match.index ?? 0) - centerIndex);
    if (distance < nearestDistance) {
      nearest = match[1];
      nearestDistance = distance;
    }
  }

  return nearest;
}

function scorePayload(payload: ClaudeCodeOAuthConfigPayload): number {
  let score = 0;
  if (payload.clientId === KNOWN_CLIENT_ID) score += 4;
  if (payload.baseApiUrl.startsWith("https://")) score += 3;
  if (payload.authorizeUrl.startsWith("https://")) score += 2;
  if (payload.tokenUrl.startsWith("https://")) score += 2;
  if (payload.scopes.includes("user:sessions:claude_code")) score += 1;
  return score;
}

function normalizePayload(payload: ClaudeCodeOAuthConfigPayload): ClaudeCodeOAuthConfigPayload {
  return {
    ...payload,
    authorizeUrl:
      payload.authorizeUrl === "https://claude.com/cai/oauth/authorize"
        ? "https://claude.ai/oauth/authorize"
        : payload.authorizeUrl,
  };
}

function isValidPayload(value: ClaudeCodeOAuthConfigPayload): boolean {
  return isUuid(value.clientId)
    && isUrl(value.authorizeUrl)
    && isUrl(value.tokenUrl)
    && isUrl(value.baseApiUrl)
    && value.scopes.length > 0;
}

function applyEnvOverride(config: ClaudeCodeOAuthConfig): ClaudeCodeOAuthConfig {
  const override = normalizePayload({
    clientId: readEnv("KYOLI_CLAUDE_OAUTH_CLIENT_ID") ?? config.clientId,
    authorizeUrl: readEnv("KYOLI_CLAUDE_OAUTH_AUTHORIZE_URL") ?? config.authorizeUrl,
    tokenUrl: readEnv("KYOLI_CLAUDE_OAUTH_TOKEN_URL") ?? config.tokenUrl,
    scopes: readEnv("KYOLI_CLAUDE_OAUTH_SCOPES") ?? config.scopes,
    baseApiUrl: readEnv("KYOLI_CLAUDE_API_BASE_URL") ?? config.baseApiUrl,
  });

  if (!isValidPayload(override)) return config;

  return {
    ...config,
    ...override,
    source:
      Object.entries(override).some(([key, value]) => value !== config[key as keyof typeof override])
        ? "override"
        : config.source,
  };
}

async function loadCachedConfig(hash: string): Promise<ClaudeCodeOAuthConfigPayload | undefined> {
  try {
    const parsed = JSON.parse(await readFile(getCachePath(), "utf-8")) as {
      entries?: Record<string, unknown>;
    };
    const value = parsed.entries?.[hash];
    if (!value || typeof value !== "object") return undefined;
    const payload = normalizePayload(value as ClaudeCodeOAuthConfigPayload);
    return isValidPayload(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

async function saveCachedConfig(hash: string, payload: ClaudeCodeOAuthConfigPayload): Promise<void> {
  try {
    const path = getCachePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ entries: { [hash]: payload }, savedAt: Date.now() }, null, 2));
  } catch {
  }
}

function getCachePath(): string {
  return process.env.KYOLI_CLAUDE_OAUTH_CONFIG_CACHE
    ?? join(homedir(), ".cache", "kyoli-gam", CACHE_FILE_NAME);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
