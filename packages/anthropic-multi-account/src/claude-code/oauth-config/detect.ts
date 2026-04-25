import { createHash } from "node:crypto";
import { execFileSync as defaultExecFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import derivedDefaultsJson from "../../fixtures/defaults/cc-derived-defaults.json";
import { compareVersions } from "../fingerprint/capture";
import { getConfigDir } from "../../shared/utils";

export interface DetectedOAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  baseApiUrl: string;
  source: "detected" | "cached" | "fallback" | "override";
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
  existsSync?: (path: string) => boolean;
  execFileSync?: typeof defaultExecFileSync;
  pathEnv?: string;
  platform?: () => NodeJS.Platform;
}

const CONFIG_SCAN_WINDOW_CHARS = 4096;
const CONFIG_SCAN_LOOKBACK_CHARS = 512;
const KNOWN_PROD_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const POLLUTED_CACHED_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const SAFE_FALLBACK_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CACHE_FILE_NAME = "anthropic-oauth-config-cache.json";
const DEFAULT_OVERRIDE_FILE_NAME = "oauth-config.override.json";
const derivedDefaults = derivedDefaultsJson as {
  oauth?: {
    clientId?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    scopes?: string;
    baseApiUrl?: string;
  };
};

const fallbackPayload = normalizeDetectedOAuthConfigPayload({
  clientId: derivedDefaults.oauth?.clientId || KNOWN_PROD_CLIENT_ID,
  authorizeUrl: derivedDefaults.oauth?.authorizeUrl || "https://claude.ai/oauth/authorize",
  tokenUrl: derivedDefaults.oauth?.tokenUrl || "https://platform.claude.com/v1/oauth/token",
  scopes: derivedDefaults.oauth?.scopes || SAFE_FALLBACK_SCOPES,
  baseApiUrl: derivedDefaults.oauth?.baseApiUrl || "https://api.anthropic.com",
});

export const FALLBACK: DetectedOAuthConfig = {
  ...fallbackPayload,
  source: "fallback",
};

export const FALLBACK_FOR_DRIFT_CHECK = FALLBACK;

function hasPollutedCachedScope(scopes: string): boolean {
  const parsedScopes = scopes.split(/\s+/).filter(Boolean);
  return parsedScopes.includes(POLLUTED_CACHED_SCOPE) || !parsedScopes.includes("org:create_api_key");
}

export function filterScopesByBinaryPresence(buf: Buffer, expected: string[]): string[] {
  const verified: string[] = [];

  for (const scope of expected) {
    const needle = Buffer.from(`"${scope}"`);
    if (buf.includes(needle)) {
      verified.push(scope);
    }
  }

  return verified;
}

function getVerifiedCanonicalScopes(buf: Buffer, fallbackScopes: string): string | null {
  const expectedScopes = fallbackScopes.split(/\s+/).filter(Boolean);
  const verifiedScopes = filterScopesByBinaryPresence(buf, expectedScopes);

  return verifiedScopes.length === expectedScopes.length ? verifiedScopes.join(" ") : null;
}

export function normalizeAuthorizeUrl(url: string): string {
  if (url === "https://claude.com/cai/oauth/authorize") {
    return "https://claude.ai/oauth/authorize";
  }

  return url;
}

function normalizeDetectedOAuthConfigPayload(
  payload: DetectedOAuthConfigPayload,
): DetectedOAuthConfigPayload {
  return {
    ...payload,
    authorizeUrl: normalizeAuthorizeUrl(payload.authorizeUrl),
  };
}

function pickNearestScopes(block: string, centerIndex: number): string | null {
  return pickNearestValue(block, centerIndex, /SCOPES\s*:\s*"([^"]+)"/gi)
    || pickNearestValue(block, centerIndex, /scope[s]?\s*:\s*"([^"]+)"/gi)
    || null;
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
  const clientIdMatches = [...binaryText.matchAll(/CLIENT_ID\s*:\s*"([0-9a-f-]{36})"/gi)];

  for (const [index, currentMatch] of clientIdMatches.entries()) {
    const currentIndex = currentMatch.index ?? 0;
    const previousClientIdIndex = clientIdMatches[index - 1]?.index;
    const nextClientIdIndex = clientIdMatches[index + 1]?.index;
    const { start, end } = getCandidateBlockRange(
      currentIndex,
      previousClientIdIndex,
      nextClientIdIndex,
      binaryText.length,
    );
    const key = `${start}:${end}`;

    if (seenRanges.has(key)) {
      continue;
    }

    seenRanges.add(key);
    blocks.push(binaryText.slice(start, end));
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

function midpoint(left: number, right: number): number {
  return Math.floor((left + right) / 2);
}

function getCandidateBlockRange(
  currentIndex: number,
  previousClientIdIndex: number | undefined,
  nextClientIdIndex: number | undefined,
  textLength: number,
): { start: number; end: number } {
  const boundedLeftEdge = currentIndex - CONFIG_SCAN_LOOKBACK_CHARS;
  const boundedRightEdge = currentIndex + CONFIG_SCAN_WINDOW_CHARS;
  const leftBoundary = previousClientIdIndex === undefined
    ? boundedLeftEdge
    : Math.max(boundedLeftEdge, midpoint(previousClientIdIndex, currentIndex));
  const rightBoundary = nextClientIdIndex === undefined
    ? boundedRightEdge
    : Math.min(boundedRightEdge, midpoint(currentIndex, nextClientIdIndex));

  return {
    start: Math.max(0, leftBoundary),
    end: Math.min(textLength, Math.max(currentIndex + 1, rightBoundary)),
  };
}

function pickNearestValue(block: string, centerIndex: number, pattern: RegExp): string | undefined {
  let nearestValue: string | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const match of block.matchAll(pattern)) {
    const matchIndex = match.index ?? 0;
    const distance = Math.abs(matchIndex - centerIndex);

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestValue = match[1];
    }
  }

  return nearestValue;
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

  const clientIdIndex = clientIdMatch.index ?? 0;
  const authorizeUrl = pickNearestValue(block, clientIdIndex, /CLAUDE_AI_AUTHORIZE_URL\s*:\s*"([^"]+)"/gi);
  const baseApiUrl = pickNearestValue(block, clientIdIndex, /BASE_API_URL\s*:\s*"([^"]+)"/gi);
  const tokenUrl = pickNearestValue(block, clientIdIndex, /TOKEN_URL\s*:\s*"(https:\/\/[^\"]*\/oauth\/token[^\"]*)"/gi);
  const extractedScopes = pickNearestScopes(block, clientIdIndex);

  const payload: DetectedOAuthConfigPayload = {
    clientId: clientIdMatch[1],
    authorizeUrl: authorizeUrl || FALLBACK.authorizeUrl,
    tokenUrl: tokenUrl || FALLBACK.tokenUrl,
    scopes: extractedScopes || FALLBACK.scopes,
    baseApiUrl: baseApiUrl || FALLBACK.baseApiUrl,
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

function getPlatform(): NodeJS.Platform {
  return detectorTestOverrides.platform?.() ?? platform();
}

function fileExists(path: string): boolean {
  return (detectorTestOverrides.existsSync ?? existsSync)(path);
}

function candidatePaths(): string[] {
  const home = homedir();

  if (getPlatform() === "win32") {
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

export function enumerateCCCandidates(): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const currentPlatform = getPlatform();
  const pathDelimiter = currentPlatform === "win32" ? ";" : ":";
  const pathDirs = (detectorTestOverrides.pathEnv ?? process.env.PATH ?? "")
    .split(pathDelimiter)
    .filter(Boolean);
  const pathCandidateNames = currentPlatform === "win32"
    ? ["claude.exe", "claude.cmd", "claude"]
    : ["claude"];

  const addCandidate = (candidatePath: string): void => {
    const key = currentPlatform === "win32" ? candidatePath.toLowerCase() : candidatePath;
    if (seen.has(key) || !fileExists(candidatePath)) {
      return;
    }

    seen.add(key);
    candidates.push(candidatePath);
  };

  for (const dir of pathDirs) {
    for (const fileName of pathCandidateNames) {
      addCandidate(join(dir, fileName));
    }
  }

  for (const candidatePath of candidatePaths()) {
    addCandidate(candidatePath);
  }

  return candidates;
}

function probeOneVersion(binPath: string): string | null {
  const currentPlatform = getPlatform();

  if (currentPlatform === "win32" && /\.(cmd|bat)$/i.test(binPath) && /[&|><^"'%\r\n`$;(){}\[\]]/.test(binPath)) {
    return null;
  }

  try {
    const output = (detectorTestOverrides.execFileSync ?? defaultExecFileSync)(binPath, ["--version"], {
      timeout: 2_000,
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      shell: currentPlatform === "win32" && /\.(cmd|bat)$/i.test(binPath),
    });
    return output.match(/(\d+\.\d+\.\d+(?:[.\-][\w.\-]+)?)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function getCachePath(): string {
  return join(getConfigDir(), CACHE_FILE_NAME);
}

function getDefaultOverridePath(): string {
  return join(getConfigDir(), DEFAULT_OVERRIDE_FILE_NAME);
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

function buildResolvedConfig(
  payload: DetectedOAuthConfigPayload,
  source: DetectedOAuthConfig["source"],
  ccPath?: string,
  ccHash?: string,
): DetectedOAuthConfig {
  return {
    ...payload,
    source,
    ...(ccPath ? { ccPath } : {}),
    ...(ccHash ? { ccHash } : {}),
  };
}

function toFallbackConfig(ccPath?: string, ccHash?: string): DetectedOAuthConfig {
  return buildResolvedConfig(FALLBACK, "fallback", ccPath, ccHash);
}

function isOverrideDisabled(): boolean {
  return process.env.ANTHROPIC_MULTI_ACCOUNT_OAUTH_DISABLE_OVERRIDE === "1";
}

function readOverrideString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getOverridePath(): string {
  return readOverrideString(process.env.ANTHROPIC_MULTI_ACCOUNT_OAUTH_OVERRIDE_PATH) ?? getDefaultOverridePath();
}

function readOverrideRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readOverrideField(candidate: Record<string, unknown>, key: keyof DetectedOAuthConfigPayload): string | undefined {
  const value = candidate[key];
  return typeof value === "string" ? readOverrideString(value) : undefined;
}

function readOverrideUrl(
  candidate: Record<string, unknown>,
  key: "authorizeUrl" | "tokenUrl" | "baseApiUrl",
): string | undefined {
  const value = readOverrideField(candidate, key);
  return value && isValidUrl(value) ? value : undefined;
}

function normalizeOverride(value: unknown): Partial<DetectedOAuthConfigPayload> {
  const candidate = readOverrideRecord(value);
  if (!candidate) {
    return {};
  }

  const normalized: Partial<DetectedOAuthConfigPayload> = {};

  const clientId = readOverrideField(candidate, "clientId");
  if (clientId && UUID_PATTERN.test(clientId)) {
    normalized.clientId = clientId;
  }

  const authorizeUrl = readOverrideUrl(candidate, "authorizeUrl");
  if (authorizeUrl) {
    normalized.authorizeUrl = normalizeAuthorizeUrl(authorizeUrl);
  }

  const tokenUrl = readOverrideUrl(candidate, "tokenUrl");
  if (tokenUrl) {
    normalized.tokenUrl = tokenUrl;
  }

  const scopes = readOverrideField(candidate, "scopes");
  if (scopes) {
    normalized.scopes = scopes;
  }

  const baseApiUrl = readOverrideUrl(candidate, "baseApiUrl");
  if (baseApiUrl) {
    normalized.baseApiUrl = baseApiUrl;
  }

  return normalized;
}

async function loadManualOverride(): Promise<Partial<DetectedOAuthConfigPayload>> {
  if (isOverrideDisabled()) {
    return {};
  }

  const envOverride = normalizeOverride({
    clientId: process.env.ANTHROPIC_MULTI_ACCOUNT_OAUTH_CLIENT_ID,
    authorizeUrl: process.env.ANTHROPIC_MULTI_ACCOUNT_OAUTH_AUTHORIZE_URL,
    tokenUrl: process.env.ANTHROPIC_MULTI_ACCOUNT_OAUTH_TOKEN_URL,
    scopes: process.env.ANTHROPIC_MULTI_ACCOUNT_OAUTH_SCOPES,
  });
  if (Object.keys(envOverride).length > 0) {
    return envOverride;
  }

  try {
    const fileOverride = JSON.parse(await readFile(getOverridePath(), "utf-8")) as unknown;
    return normalizeOverride(fileOverride);
  } catch {
    return {};
  }
}

async function applyManualOverride(baseConfig: DetectedOAuthConfig): Promise<DetectedOAuthConfig> {
  const override = await loadManualOverride();
  if (Object.keys(override).length === 0) {
    return baseConfig;
  }

  return {
    ...baseConfig,
    ...override,
    source: "override",
  };
}

export function findCCBinary(): string | null {
  const override = process.env.ANTHROPIC_CC_PATH;
  if (override && fileExists(override)) {
    return override;
  }

  const candidates = enumerateCCCandidates();
  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0] ?? null;
  }

  const probedCandidates = candidates
    .map((candidatePath) => {
      const version = probeOneVersion(candidatePath);
      return version ? { path: candidatePath, version } : null;
    })
    .filter((candidate): candidate is { path: string; version: string } => candidate !== null)
    .sort((left, right) => (compareVersions(right.version, left.version) ?? 0));

  return probedCandidates[0]?.path ?? candidates[0] ?? null;
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
  const preferredCandidate = candidates.find((candidate) => candidate.payload.clientId === KNOWN_PROD_CLIENT_ID);

  return preferredCandidate?.payload ?? candidates[0]?.payload ?? null;
}

async function readRawCacheEntries(): Promise<Record<string, unknown>> {
  const raw = await readFile(getCachePath(), "utf-8");
  const parsed = JSON.parse(raw) as CacheFilePayload;

  if (typeof parsed !== "object" || parsed === null || typeof parsed.entries !== "object" || parsed.entries === null) {
    return {};
  }

  return parsed.entries;
}

export async function loadCache(): Promise<OAuthConfigCache> {
  try {
    const rawEntries = await readRawCacheEntries();
    const validEntries: OAuthConfigCache = {};

    for (const [hash, value] of Object.entries(rawEntries)) {
      if (isDetectedOAuthConfigPayload(value) && !hasPollutedCachedScope(value.scopes)) {
        validEntries[hash] = normalizeDetectedOAuthConfigPayload(value);
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
    const currentEntries: Record<string, unknown> = {};

    try {
      Object.assign(currentEntries, await readRawCacheEntries());
    } catch {
    }

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
      memoizedConfig = await applyManualOverride(FALLBACK);
      return memoizedConfig;
    }

    const ccHash = await fingerprintBinary(ccPath);
    const cachedEntries = await loadCache();
    const cachedConfig = cachedEntries[ccHash];

    if (cachedConfig) {
      memoizedConfig = await applyManualOverride(buildResolvedConfig(cachedConfig, "cached", ccPath, ccHash));
      return memoizedConfig;
    }

    const readBinaryFile = detectorTestOverrides.readBinaryFile || readFile;
    const binaryBuffer = await readBinaryFile(ccPath);
    const scannedConfig = scanBinaryForOAuthConfig(binaryBuffer);
    if (!scannedConfig) {
      memoizedConfig = await applyManualOverride(toFallbackConfig(ccPath, ccHash));
      return memoizedConfig;
    }

    const verifiedCanonicalScopes = getVerifiedCanonicalScopes(binaryBuffer, FALLBACK.scopes);
    if (verifiedCanonicalScopes) {
      scannedConfig.scopes = verifiedCanonicalScopes;
    }

    const runtimeDetectedConfig = normalizeDetectedOAuthConfigPayload(scannedConfig);

    await saveCache(ccHash, runtimeDetectedConfig);
    memoizedConfig = await applyManualOverride(buildResolvedConfig(runtimeDetectedConfig, "detected", ccPath, ccHash));
    return memoizedConfig;
  } catch {
    memoizedConfig = await applyManualOverride(FALLBACK);
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
