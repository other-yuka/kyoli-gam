#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_COMMANDS = [
  ["pnpm", "--dir", "packages/cli", "run", "doctor", "claude", "--binary", "--json"],
  ["pnpm", "--dir", "packages/cli", "run", "doctor", "claude", "--template", "--json"],
  ["pnpm", "--dir", "packages/cli", "run", "doctor", "claude", "--wire", "--json"],
  ["pnpm", "--dir", "packages/cli", "run", "doctor", "claude", "--obedience", "--json"],
];

const CLASS_AB_FINGERPRINT_WARNINGS = new Set([
  "bundled template version",
  "bundled version",
  "system prompt",
  "tool names",
  "anthropic beta",
  "static header values",
  "user-agent",
  "anthropic-beta",
]);

function readCommands() {
  const raw = process.env.KYOLI_DOCTOR_COMMANDS_JSON;
  if (!raw) return DEFAULT_COMMANDS;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((command) => !Array.isArray(command) || command.some((part) => typeof part !== "string"))) {
    throw new Error("KYOLI_DOCTOR_COMMANDS_JSON must be an array of string arrays");
  }
  return parsed;
}

function extractJsonObject(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`doctor output did not contain JSON: ${output.slice(0, 200)}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

function runDoctor(command) {
  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: Number(process.env.KYOLI_DOCTOR_TIMEOUT_MS ?? "120000"),
    });
    return extractJsonObject(stdout);
  } catch (error) {
    const stdout = error?.stdout?.toString?.() ?? "";
    if (stdout.trim()) {
      return extractJsonObject(stdout);
    }
    throw error;
  }
}

export function collectActionableDoctorDrift(report) {
  const drift = [];
  for (const check of report.checks ?? []) {
    const delegatedToClassAB = check.status === "warn"
      && CLASS_AB_FINGERPRINT_WARNINGS.has(check.name);
    if (check.status === "fail" || (check.status === "warn" && !delegatedToClassAB)) {
      drift.push({ report: report.name, check: check.name, status: check.status, detail: check.detail });
    }
  }
  return drift;
}

function main() {
  const reports = readCommands().map(runDoctor);
  const drift = reports.flatMap(collectActionableDoctorDrift);
  const summary = reports.reduce((acc, report) => {
    acc.pass += report.summary?.pass ?? 0;
    acc.warn += report.summary?.warn ?? 0;
    acc.fail += report.summary?.fail ?? 0;
    return acc;
  }, { pass: 0, warn: 0, fail: 0 });

  const payload = {
    checkedAt: new Date().toISOString(),
    status: drift.length === 0 ? "clean" : "drift",
    summary,
    drift,
    reports,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(drift.length === 0 ? 0 : 1);
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`check-kyoli-doctor-drift: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(3);
  }
}
