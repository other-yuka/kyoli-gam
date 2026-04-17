import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { getConfigDir } from "./utils";

export interface DetectedOAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  baseApiUrl: string;
  source: "detected" | "cached" | "fallback";
  ccPath?: string;
  ccHash?: string;
}

type DetectedOAuthConfigPayload = Omit<DetectedOAuthConfig, "source" | "ccPath" | "ccHash">;
type OAuthConfigCache = Record<string, DetectedOAuthConfigPayload>;

interface CacheFilePayload {
  entries?: Record<string, unknown>;
  savedAt?: number;
}

interface DetectorTestOverrides {
  findCCBinary?: () => string | null;
  readBinaryFile?: (path: string) => Promise<Buffer>;
}

const CONFIG_SCAN_WINDOW_CHARS = 4096;
const CONFIG_SCAN_LOOKBACK_CHARS = 512;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CACHE_FILE_NAME = "anthropic-oauth-config-cache.json";

export const FALLBACK: DetectedOAuthConfig = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  baseApiUrl: "https://api.anthropic.com",
  source: "fallback",
};

function extractScopes(block: string): string | null {
  const scopesMatch = /SCOPES\s*:\s*"([^"]+)"/i.exec(block)
    || /scope[s]?\s*:\s*"([^"]+)"/i.exec(block);

  return scopesMatch?.[1] || null;
}

function isLikelyLocalUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost"
      || host === "127.0.0.1"
      || host === "0.0.0.0"
      || host.endsWith(".local");
  } catch {
    return false;
  }
}

function extractCandidateBlocks(binaryText: string): string[] {
  const blocks: string[] = [];
  const seenRanges = new Set<string>();
  const patterns = [
    /BASE_API_URL\s*:\s*"/g,
    /CLIENT_ID\s*:\s*"/g,
    /TOKEN_URL\s*:\s*"/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;

    let match = pattern.exec(binaryText);
    while (match !== null) {
      const start = Math.max(0, match.index - CONFIG_SCAN_LOOKBACK_CHARS);
      const end = Math.min(binaryText.length, match.index + CONFIG_SCAN_WINDOW_CHARS);
      const key = `${start}:${end}`;
      if (seenRanges.has(key)) {
        continue;
      }

      seenRanges.add(key);
      blocks.push(binaryText.slice(start, end));
      match = pattern.exec(binaryText);
    }
  }

  if (blocks.length === 0 && binaryText.length > 0) {
    blocks.push(binaryText.slice(0, Math.min(binaryText.length, CONFIG_SCAN_WINDOW_CHARS)));
  }

  return blocks;
}

interface ScoredOAuthCandidate {
  payload: DetectedOAuthConfigPayload;
  score: number;
}

function scoreCandidate(candidate: DetectedOAuthConfigPayload, extractedScopes: string | null): number {
  let score = 0;

  if (UUID_PATTERN.test(candidate.clientId)) score += 4;
  if (candidate.baseApiUrl.startsWith("https://")) score += 3;
  if (!isLikelyLocalUrl(candidate.baseApiUrl)) score += 5;
  if (!isLikelyLocalUrl(candidate.authorizeUrl)) score += 2;
  if (!isLikelyLocalUrl(candidate.tokenUrl)) score += 2;
  if (extractedScopes) score += 2;
  if (candidate.scopes.includes("user:sessions:claude_code")) score += 1;

  return score;
}

function extractCandidateFromBlock(block: string): ScoredOAuthCandidate | null {
  const clientIdMatch = /CLIENT_ID\s*:\s*"([0-9a-f-]{36})"/i.exec(block);
  if (!clientIdMatch?.[1]) {
    return null;
  }

  const authorizeUrlMatch = /CLAUDE_AI_AUTHORIZE_URL\s*:\s*"([^"]+)"/.exec(block);
  const baseApiUrlMatch = /BASE_API_URL\s*:\s*"([^"]+)"/.exec(block);
  const tokenUrlMatch = /TOKEN_URL\s*:\s*"(https:\/\/[^\"]*\/oauth\/token[^\"]*)"/.exec(block);
  const extractedScopes = extractScopes(block);

  const payload: DetectedOAuthConfigPayload = {
    clientId: clientIdMatch[1],
    authorizeUrl: authorizeUrlMatch?.[1] || FALLBACK.authorizeUrl,
    tokenUrl: tokenUrlMatch?.[1] || FALLBACK.tokenUrl,
    scopes: extractedScopes || FALLBACK.scopes,
    baseApiUrl: baseApiUrlMatch?.[1] || FALLBACK.baseApiUrl,
  };

  if (!isDetectedOAuthConfigPayload(payload)) {
    return null;
  }

  return {
    payload,
    score: scoreCandidate(payload, extractedScopes),
  };
}

let memoizedConfig: DetectedOAuthConfig | null = null;
let detectorTestOverrides: DetectorTestOverrides = {};

function candidatePaths(): string[] {
  const home = homedir();

  if (platform() === "win32") {
    return [
      join(home, ".local", "bin", "claude.exe"),
      join(home, "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
      join(home, "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.mjs"),
      join(home, ".claude", "local", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
      join(home, ".claude", "local", "node_modules", "@anthropic-ai", "claude-code", "cli.mjs"),
    ];
  }

  return [
    join(home, ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.mjs",
    "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    join(home, ".claude", "local", "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    join(home, ".claude", "local", "node_modules", "@anthropic-ai", "claude-code", "cli.mjs"),
  ];
}

function getCachePath(): string {
  return join(getConfigDir(), CACHE_FILE_NAME);
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isDetectedOAuthConfigPayload(value: unknown): value is DetectedOAuthConfigPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<DetectedOAuthConfigPayload>;
  return typeof candidate.clientId === "string"
    && UUID_PATTERN.test(candidate.clientId)
    && typeof candidate.authorizeUrl === "string"
    && isValidUrl(candidate.authorizeUrl)
    && typeof candidate.tokenUrl === "string"
    && isValidUrl(candidate.tokenUrl)
    && typeof candidate.scopes === "string"
    && candidate.scopes.length > 0;
}

function toFallbackConfig(ccPath?: string, ccHash?: string): DetectedOAuthConfig {
  return {
    ...FALLBACK,
    ...(ccPath ? { ccPath } : {}),
    ...(ccHash ? { ccHash } : {}),
  };
}

export function findCCBinary(): string | null {
  const override = process.env.DARIO_CC_PATH;
  if (override && existsSync(override)) {
    return override;
  }

  for (const candidatePath of candidatePaths()) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

export async function fingerprintBinary(path: string): Promise<string> {
  const binaryContents = await readFile(path);
  return createHash("sha256").update(binaryContents).digest("hex").slice(0, 16);
}

export function scanBinaryForOAuthConfig(buf: Buffer): DetectedOAuthConfigPayload | null {
  const binaryText = buf.toString("latin1");
  const candidates = extractCandidateBlocks(binaryText)
    .map(extractCandidateFromBlock)
    .filter((candidate): candidate is ScoredOAuthCandidate => candidate !== null)
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.payload ?? null;
}

export async function loadCache(): Promise<OAuthConfigCache> {
  try {
    const raw = await readFile(getCachePath(), "utf-8");
    const parsed = JSON.parse(raw) as CacheFilePayload;

    if (typeof parsed !== "object" || parsed === null || typeof parsed.entries !== "object" || parsed.entries === null) {
      return {};
    }

    const validEntries: OAuthConfigCache = {};

    for (const [hash, value] of Object.entries(parsed.entries)) {
      if (isDetectedOAuthConfigPayload(value)) {
        validEntries[hash] = value;
      }
    }

    return validEntries;
  } catch {
    return {};
  }
}

export async function saveCache(hash: string, config: DetectedOAuthConfigPayload): Promise<void> {
  try {
    const cachePath = getCachePath();
    const currentEntries = await loadCache();
    currentEntries[hash] = config;

    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({ entries: currentEntries, savedAt: Date.now() }, null, 2),
      "utf-8",
    );
  } catch {
  }
}

export async function detectOAuthConfig(): Promise<DetectedOAuthConfig> {
  if (memoizedConfig) {
    return memoizedConfig;
  }

  try {
    const ccPath = (detectorTestOverrides.findCCBinary || findCCBinary)();
    if (!ccPath) {
      memoizedConfig = FALLBACK;
      return memoizedConfig;
    }

    const ccHash = await fingerprintBinary(ccPath);
    const cachedEntries = await loadCache();
    const cachedConfig = cachedEntries[ccHash];

    if (cachedConfig) {
      memoizedConfig = {
        ...cachedConfig,
        source: "cached",
        ccPath,
        ccHash,
      };
      return memoizedConfig;
    }

    const readBinaryFile = detectorTestOverrides.readBinaryFile || readFile;
    const scannedConfig = scanBinaryForOAuthConfig(await readBinaryFile(ccPath));
    if (!scannedConfig || !isDetectedOAuthConfigPayload(scannedConfig)) {
      memoizedConfig = toFallbackConfig(ccPath, ccHash);
      return memoizedConfig;
    }

    await saveCache(ccHash, scannedConfig);
    memoizedConfig = {
      ...scannedConfig,
      source: "detected",
      ccPath,
      ccHash,
    };
    return memoizedConfig;
  } catch {
    memoizedConfig = FALLBACK;
    return memoizedConfig;
  }
}

export function resetOAuthConfigDetectionForTest(): void {
  memoizedConfig = null;
  detectorTestOverrides = {};
}

export function setOAuthConfigDetectionOverridesForTest(overrides: DetectorTestOverrides | null): void {
  detectorTestOverrides = overrides ?? {};
}
