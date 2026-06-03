#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDir, "..");
const fingerprintPath = join(packageRoot, "src/claude-code/fingerprint/data.json");
const NPM_VIEW_ATTEMPTS = 3;

class InfraError extends Error {
  constructor(message) {
    super(message);
    this.name = "InfraError";
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function npmView(pkg, field) {
  let lastError;
  for (let attempt = 1; attempt <= NPM_VIEW_ATTEMPTS; attempt += 1) {
    try {
      const output = execFileSync("npm", ["view", pkg, field, "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      }).trim();
      if (!output) return undefined;
      return JSON.parse(output);
    } catch (error) {
      lastError = error;
      if (attempt < NPM_VIEW_ATTEMPTS) sleep(attempt * 1_000);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new InfraError(`npm view ${pkg} ${field} failed after ${NPM_VIEW_ATTEMPTS} attempts: ${detail}`);
}

function loadBundledFingerprint() {
  return JSON.parse(readFileSync(fingerprintPath, "utf8"));
}

function normalizeRange(range) {
  return typeof range === "string" ? range.replace(/^[\^~>=\s]+/, "") : null;
}

function main() {
  const bundled = loadBundledFingerprint();
  const bundledCcVersion = bundled.cc_version ?? null;
  const bundledStainless = bundled.header_values?.["x-stainless-package-version"] ?? null;
  const bundledUserAgent = bundled.header_values?.["user-agent"] ?? null;

  const agentSdkVersion = npmView("@anthropic-ai/claude-agent-sdk", "version") ?? null;
  const agentSdkDeps = npmView("@anthropic-ai/claude-agent-sdk", "dependencies");
  const upstreamStainless = normalizeRange(agentSdkDeps?.["@anthropic-ai/sdk"]);

  const drift = [];

  if (upstreamStainless && bundledStainless && upstreamStainless !== bundledStainless) {
    drift.push({
      field: "x-stainless-package-version",
      bundled: bundledStainless,
      upstream: upstreamStainless,
      source: `@anthropic-ai/claude-agent-sdk@${agentSdkVersion}.dependencies[@anthropic-ai/sdk]`,
    });
  }

  const report = {
    checkedAt: new Date().toISOString(),
    bundled: {
      cc_version: bundledCcVersion,
      stainless: bundledStainless,
      user_agent: bundledUserAgent,
    },
    upstream: {
      agent_sdk_version: agentSdkVersion,
      stainless_dep: upstreamStainless,
    },
    drift,
    status: drift.length === 0 ? "clean" : "drift",
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(drift.length === 0 ? 0 : 1);
}

try {
  main();
} catch (error) {
  if (error instanceof InfraError) {
    const report = {
      checkedAt: new Date().toISOString(),
      status: "infra_error",
      error: error.message,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(2);
  }

  process.stderr.write(`check-sdk-drift: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(3);
}
