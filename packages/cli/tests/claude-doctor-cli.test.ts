import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsxLoaderPath = fileURLToPath(import.meta.resolve("tsx"));

describe("doctor claude CLI", () => {
  it("accepts Kyoli-owned cache markers after filtering caller cache policy", () => {
    const report = runClaudeDoctor();

    expect(findCheck(report, "caller cache_control filtered")).toMatchObject({ status: "pass" });
    expect(findCheck(report, "Kyoli cache_control applied")).toMatchObject({ status: "pass" });
    expect(findCheck(report, "tool template")).toMatchObject({ status: "pass" });
    expect(findCheck(report, "runtime/tls/node-only")).toMatchObject({ status: "warn" });
  });

  it.each([
    ["1.3.8", "warn"],
    ["canary", "warn"],
    ["1.3.14", "pass"],
  ])("classifies Bun %s TLS evidence as %s", (bunVersion, expectedStatus) => {
    const check = findCheck(runClaudeDoctor(bunVersion), "runtime/tls");

    expect(check).toMatchObject({ status: expectedStatus });
    expect(check.detail).toContain(`Bun ${bunVersion}`);
    expect(check.detail).toContain("1.3.14");
  });
});

function runClaudeDoctor(bunVersion?: string): DoctorReport {
  const bunShim = bunVersion
    ? `--import=data:text/javascript,Object.defineProperty(process.versions,%22bun%22,{value:%22${bunVersion}%22})`
    : undefined;
  const nodeOptions = [process.env.NODE_OPTIONS, bunShim].filter(Boolean).join(" ");
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoaderPath, cliPath, "doctor", "claude", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
      },
      timeout: 30_000,
    },
  );

  if (!result.stdout.trim()) {
    throw new Error(result.stderr || `doctor exited without output (${result.status ?? "unknown"})`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `doctor exited with status ${result.status ?? "unknown"}`);
  }

  return JSON.parse(result.stdout) as DoctorReport;
}

function findCheck(report: DoctorReport, name: string): DoctorCheck {
  const check = report.checks.find((candidate) => candidate.name === name);
  if (!check) throw new Error(`missing doctor check: ${name}`);
  return check;
}

interface DoctorReport {
  checks: DoctorCheck[];
}

interface DoctorCheck {
  detail: string;
  name: string;
  status: "pass" | "warn" | "fail";
}
