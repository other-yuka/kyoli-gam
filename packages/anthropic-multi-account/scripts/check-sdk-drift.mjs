#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDir, "..");
const fingerprintPath = join(packageRoot, "src/claude-code/fingerprint/data.json");

function npmView(pkg, field) {
  const output = execFileSync("npm", ["view", pkg, field, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
  if (!output) return undefined;
  return JSON.parse(output);
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
  const upstreamCcVersion = npmView("@anthropic-ai/claude-code", "version") ?? null;

  const drift = [];
  if (upstreamCcVersion && bundledCcVersion && upstreamCcVersion !== bundledCcVersion) {
    drift.push({
      field: "cc_version",
      bundled: bundledCcVersion,
      upstream: upstreamCcVersion,
      source: "@anthropic-ai/claude-code@latest",
    });
  }

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
      cc_version: upstreamCcVersion,
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
  process.stderr.write(`check-sdk-drift: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(3);
}
