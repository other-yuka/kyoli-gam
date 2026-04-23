#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SUPPORTED_CC_RANGE } from "../dist/fingerprint-capture.js";

const PINNED_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
};

const CONFIG_SCAN_WINDOW_CHARS = 4096;
const CONFIG_SCAN_LOOKBACK_CHARS = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JS_CANDIDATES = ["cli.js", "cli.mjs", "dist/cli.js", "dist/cli.mjs"];
const NATIVE_SIZE_FLOOR_BYTES = 1_000_000;

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }

  return 0;
}

function isValidUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isLikelyLocalUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "127.0.0.1"
      || hostname === "0.0.0.0"
      || hostname.endsWith(".local");
  } catch {
    return false;
  }
}

function pickNearestValue(block, centerIndex, pattern) {
  let nearestValue;
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

function extractCandidateBlocks(binaryText) {
  const blocks = [];
  const seenRanges = new Set();
  const clientIdMatches = [...binaryText.matchAll(/CLIENT_ID\s*:\s*"([0-9a-f-]{36})"/gi)];

  for (const [index, currentMatch] of clientIdMatches.entries()) {
    const currentIndex = currentMatch.index ?? 0;
    const previousClientIdIndex = clientIdMatches[index - 1]?.index;
    const nextClientIdIndex = clientIdMatches[index + 1]?.index;
    const leftBoundary = previousClientIdIndex === undefined
      ? Math.max(0, currentIndex - CONFIG_SCAN_LOOKBACK_CHARS)
      : Math.floor((previousClientIdIndex + currentIndex) / 2);
    const rightBoundary = nextClientIdIndex === undefined
      ? Math.min(binaryText.length, currentIndex + CONFIG_SCAN_WINDOW_CHARS)
      : Math.floor((currentIndex + nextClientIdIndex) / 2);
    const start = Math.max(0, leftBoundary);
    const end = Math.min(binaryText.length, Math.max(currentIndex + 1, rightBoundary));
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

function scoreCandidate(candidate) {
  let score = 0;
  if (UUID_PATTERN.test(candidate.clientId)) score += 4;
  if (candidate.baseApiUrl.startsWith("https://")) score += 3;
  if (!isLikelyLocalUrl(candidate.baseApiUrl)) score += 5;
  if (!isLikelyLocalUrl(candidate.authorizeUrl)) score += 2;
  if (!isLikelyLocalUrl(candidate.tokenUrl)) score += 2;
  return score;
}

function scanBinaryForOAuthConfig(buf) {
  const binaryText = buf.toString("latin1");
  const candidates = [];

  for (const block of extractCandidateBlocks(binaryText)) {
    const clientIdMatch = /CLIENT_ID\s*:\s*"([0-9a-f-]{36})"/i.exec(block);
    if (!clientIdMatch?.[1]) {
      continue;
    }

    const clientIdIndex = clientIdMatch.index ?? 0;
    const payload = {
      clientId: clientIdMatch[1],
      authorizeUrl: pickNearestValue(block, clientIdIndex, /CLAUDE_AI_AUTHORIZE_URL\s*:\s*"([^"]+)"/gi) || "",
      tokenUrl: pickNearestValue(block, clientIdIndex, /TOKEN_URL\s*:\s*"(https:\/\/[^\"]*\/oauth\/token[^\"]*)"/gi) || "",
      baseApiUrl: pickNearestValue(block, clientIdIndex, /BASE_API_URL\s*:\s*"([^"]+)"/gi) || "",
    };

    if (!UUID_PATTERN.test(payload.clientId)) {
      continue;
    }

    if (!isValidUrl(payload.authorizeUrl) || !isValidUrl(payload.tokenUrl)) {
      continue;
    }

    candidates.push({ payload, score: scoreCandidate(payload) });
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.payload ?? null;
}

function projectRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function resolveNpmInvocation() {
  const nodeBinDir = dirname(process.execPath);
  const npmCliCandidates = [
    process.env.npm_execpath,
    join(nodeBinDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    join(nodeBinDir, "../node_modules/npm/bin/npm-cli.js"),
  ].filter(Boolean);

  for (const candidate of npmCliCandidates) {
    if (candidate && existsSync(candidate)) {
      return {
        command: process.execPath,
        args: [candidate],
      };
    }
  }

  const localName = process.platform === "win32" ? "npm.cmd" : "npm";
  const localPath = join(nodeBinDir, localName);
  return {
    command: existsSync(localPath) ? localPath : localName,
    args: [],
  };
}

function runPack(spec, cwd) {
  const npmInvocation = resolveNpmInvocation();
  const output = execFileSync(npmInvocation.command, [...npmInvocation.args, "pack", spec, "--silent"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: process.env.PATH || "/usr/bin:/bin",
    },
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

  const tarballName = output.split(/\r?\n/).at(-1)?.trim();
  if (!tarballName) {
    throw new Error(`npm pack produced no tarball name for ${spec}`);
  }

  return join(cwd, tarballName);
}

function extractTarball(tarballPath, cwd) {
  execFileSync("tar", ["-xf", tarballPath], {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function findLargestScannableFile(rootDir) {
  const stack = [rootDir];
  let largestPath = null;
  let largestSize = -1;

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      const size = statSync(entryPath).size;
      if (size > largestSize && size >= NATIVE_SIZE_FLOOR_BYTES) {
        largestSize = size;
        largestPath = entryPath;
      }
    }
  }

  return largestPath;
}

function defaultPlatformTarget() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "win32-x64";

  return "linux-x64";
}

function fetchNativeBinary(optionalDependencies, ccVersion, scratchRoot) {
  const preferredPlatform = process.env.ANTHROPIC_CC_PLATFORM || defaultPlatformTarget();
  const targetPackage = `@anthropic-ai/claude-code-${preferredPlatform}`;

  if (!optionalDependencies?.[targetPackage]) {
    return {
      binaryPath: null,
      targetPackage,
      preferredPlatform,
    };
  }

  const nativeDir = join(scratchRoot, "native");
  mkdirSync(nativeDir, { recursive: true });

  const tarballPath = runPack(`${targetPackage}@${ccVersion}`, nativeDir);
  extractTarball(tarballPath, nativeDir);

  const packageDir = join(nativeDir, "package");
  if (!existsSync(packageDir)) {
    return {
      binaryPath: null,
      targetPackage,
      preferredPlatform,
    };
  }

  return {
    binaryPath: findLargestScannableFile(packageDir),
    targetPackage,
    preferredPlatform,
  };
}

function buildReportItem(category, severity, message, extra = {}) {
  return {
    category,
    severity,
    message,
    ...extra,
  };
}

function main() {
  const scratchDir = join(tmpdir(), `cc-static-drift-${process.pid}-${Date.now()}`);
  mkdirSync(scratchDir, { recursive: true });

  const items = [];
  let ccVersion = null;
  let scanned = null;
  let scanTarget = null;

  try {
    const packageTarball = runPack("@anthropic-ai/claude-code@latest", scratchDir);
    extractTarball(packageTarball, scratchDir);

    const packageDir = join(scratchDir, "package");
    const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    ccVersion = typeof packageJson.version === "string" ? packageJson.version : null;

    let cliPath = null;
    for (const candidate of JS_CANDIDATES) {
      const candidatePath = join(packageDir, candidate);
      if (existsSync(candidatePath)) {
        cliPath = candidatePath;
        scanTarget = {
          package: "@anthropic-ai/claude-code",
          kind: "wrapper-js",
          path: candidate,
        };
        break;
      }
    }

    if (!cliPath && ccVersion) {
      const nativeResult = fetchNativeBinary(packageJson.optionalDependencies, ccVersion, scratchDir);
      cliPath = nativeResult.binaryPath;
      if (cliPath) {
        scanTarget = {
          package: nativeResult.targetPackage,
          kind: "native-package",
          path: cliPath.replace(`${scratchDir}/`, ""),
          platform: nativeResult.preferredPlatform,
        };
      } else {
        items.push(buildReportItem(
          "scanner.layout",
          "high",
          `No scannable CC binary found in wrapper package or optional dependency ${nativeResult.targetPackage}.`,
          { platform: nativeResult.preferredPlatform },
        ));
      }
    }

    if (cliPath) {
      scanned = scanBinaryForOAuthConfig(readFileSync(cliPath));
      if (!scanned) {
        items.push(buildReportItem(
          "scanner",
          "high",
          "scanner returned null — CLIENT_ID/TOKEN_URL regexes may need updates.",
        ));
      } else {
        if (scanned.clientId !== PINNED_OAUTH.clientId) {
          items.push(buildReportItem(
            "oauth.clientId",
            "high",
            `clientId drifted from ${PINNED_OAUTH.clientId} to ${scanned.clientId}.`,
          ));
        }

        if (scanned.authorizeUrl !== PINNED_OAUTH.authorizeUrl) {
          items.push(buildReportItem(
            "oauth.authorizeUrl",
            "high",
            `authorizeUrl drifted from ${PINNED_OAUTH.authorizeUrl} to ${scanned.authorizeUrl}.`,
          ));
        }

        if (scanned.tokenUrl !== PINNED_OAUTH.tokenUrl) {
          items.push(buildReportItem(
            "oauth.tokenUrl",
            "high",
            `tokenUrl drifted from ${PINNED_OAUTH.tokenUrl} to ${scanned.tokenUrl}.`,
          ));
        }
      }
    }

    if (ccVersion && compareVersions(ccVersion, SUPPORTED_CC_RANGE.maxTested) > 0) {
      items.push(buildReportItem(
        "compat.range",
        "medium",
        `CC v${ccVersion} is newer than maxTested v${SUPPORTED_CC_RANGE.maxTested}.`,
      ));
    }
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  const report = {
    drift: items.length > 0,
    checkedAt: new Date().toISOString(),
    ccVersion,
    pinned: {
      ...PINNED_OAUTH,
      maxTested: SUPPORTED_CC_RANGE.maxTested,
    },
    scanned,
    scanTarget,
    scriptPath: fileURLToPath(import.meta.url).replace(`${projectRoot()}/`, ""),
    items,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = items.length > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({
    drift: true,
    checkedAt: new Date().toISOString(),
    ccVersion: null,
    pinned: {
      ...PINNED_OAUTH,
      maxTested: SUPPORTED_CC_RANGE.maxTested,
    },
    scanned: null,
    scanTarget: null,
    scriptPath: fileURLToPath(import.meta.url).replace(`${projectRoot()}/`, ""),
    items: [buildReportItem("runner", "high", message)],
  }, null, 2)}\n`);
  process.exitCode = 1;
}
