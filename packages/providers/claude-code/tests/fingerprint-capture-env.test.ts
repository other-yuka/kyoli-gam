import { readFileSync } from "node:fs";
import { mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { captureLiveTemplateAsync } from "../src/fingerprint-capture";
import {
  CLAUDE_CAPTURE_ALTERNATE_BACKEND_ENV_VARS,
  createClaudeCaptureEnv,
  createClaudeCaptureSettings,
  createClaudeCaptureSpawn,
  hasClaudeEndpointManagedSettings,
} from "../src/capture-environment";

/**
 * Regression guard for the fingerprint capture environment.
 *
 * The capture spawns Claude Code with ANTHROPIC_BASE_URL pointed at a local
 * capture server. That variable only redirects Claude Code's direct Anthropic
 * API path; under CLAUDE_CODE_USE_BEDROCK (or the Vertex, Foundry and gateway
 * equivalents) it is ignored, so the throwaway "hi" prompt reaches the real
 * backend and bills the user once per capture.
 *
 * Observed against 0.3.4: with CLAUDE_CODE_USE_BEDROCK=1 in
 * ~/.claude/settings.json, every session start spawned
 * `claude --print -p hi --model claude-opus-4-8` against AWS Bedrock. 127
 * captures over four days cost 9.79 USD, almost all of it prompt-cache writes,
 * because each capture is a fresh session.
 *
 * The regression exercises the real capture subprocess with a fake Claude
 * executable, so settings-file precedence and inherited environment handling
 * are checked together without contacting an upstream provider.
 */
describe("fingerprint capture environment", () => {
  const source = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../src/fingerprint-capture.ts",
    ),
    "utf8",
  );
  const environmentSource = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../src/capture-environment.ts",
    ),
    "utf8",
  );

  it("strips every alternate-backend switch from the capture child env", () => {
    const parentEnv = Object.fromEntries(
      CLAUDE_CAPTURE_ALTERNATE_BACKEND_ENV_VARS.map((variable) => [variable, "1"]),
    );
    parentEnv.claude_code_use_bedrock = "1";
    parentEnv["unrelated"] = "preserved";
    const childEnv = createClaudeCaptureEnv("http://127.0.0.1:1234/capture", parentEnv);

    for (const variable of CLAUDE_CAPTURE_ALTERNATE_BACKEND_ENV_VARS) {
      expect(
        childEnv[variable],
        `${variable} must be removed from the capture environment`,
      ).toBeUndefined();
    }
    expect(childEnv.claude_code_use_bedrock).toBeUndefined();
    expect(childEnv.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1234/capture");
    expect(childEnv["unrelated"]).toBe("preserved");
    expect(parentEnv.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });

  it("overrides settings-file routing at Claude Code CLI precedence", () => {
    const settings = JSON.parse(createClaudeCaptureSettings("http://127.0.0.1:1234/capture")) as {
      env: Record<string, string>;
    };

    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1234/capture");
    for (const variable of CLAUDE_CAPTURE_ALTERNATE_BACKEND_ENV_VARS) {
      expect(settings.env[variable], `${variable} must be explicitly disabled`).toBe("");
      expect(settings.env[variable.toLowerCase()], `${variable} lowercase alias must be disabled`).toBe("");
    }
  });

  it("passes cmd.exe arguments without shell command concatenation", () => {
    const invocation = createClaudeCaptureSpawn(
      "C:\\Users\\Name With Space\\claude.cmd",
      "C:\\Users\\Name With Space\\claude.cmd",
      ["--print", "-p", "hi", "--settings", "C:\\Temp\\settings.json"],
      {
        platform: "win32",
        comSpec: "C:\\Windows\\System32\\cmd.exe",
      },
    );

    expect(invocation).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/c",
        "C:\\Users\\Name With Space\\claude.cmd",
        "--print",
        "-p",
        "hi",
        "--settings",
        "C:\\Temp\\settings.json",
      ],
    });
    expect(() => createClaudeCaptureSpawn(
      "C:\\Users\\Name&Other\\claude.cmd",
      "C:\\Users\\Name&Other\\claude.cmd",
      [],
      { platform: "win32" },
    )).toThrow(/unsupported Windows shell characters/);
  });

  it("keeps the capture paths on the shared environment boundary", () => {
    expect(source).toContain("createClaudeCaptureEnv");
    expect(source).toContain("withClaudeCaptureSettings");
    expect(source).toContain("createClaudeCaptureSpawn");
    expect(source).toContain("--setting-sources");
    expect(environmentSource).toContain("delete captureEnv[variable]");
    expect(source).not.toContain("delete process.env.CLAUDE_CODE_USE_BEDROCK");
  });

  it("fails closed when endpoint-managed settings can override capture routing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "kyoli-claude-managed-settings-"));
    const dropInDir = join(tempDir, "managed-settings.d");
    const commandCalls: Array<{ command: string; args: string[] }> = [];
    const commandProbe = (command: string, args: string[]): boolean => {
      commandCalls.push({ command, args });
      return true;
    };

    try {
      expect(await hasClaudeEndpointManagedSettings({
        platform: "linux",
        managedSettingsDir: tempDir,
      })).toBe(false);

      await writeFile(join(tempDir, "managed-settings.json"), "{}", "utf8");
      expect(await hasClaudeEndpointManagedSettings({
        platform: "linux",
        managedSettingsDir: tempDir,
      })).toBe(true);
      await rm(join(tempDir, "managed-settings.json"));

      expect(await hasClaudeEndpointManagedSettings({
        platform: "linux",
        managedSettingsDir: join(tempDir, "missing-wsl"),
        wslProbe: async () => true,
      })).toBe(true);

      await mkdir(dropInDir);
      await writeFile(join(dropInDir, ".ignored.json"), "{}", "utf8");
      expect(await hasClaudeEndpointManagedSettings({
        platform: "linux",
        managedSettingsDir: tempDir,
      })).toBe(false);
      await writeFile(join(dropInDir, "10-policy.json"), "{}", "utf8");
      expect(await hasClaudeEndpointManagedSettings({
        platform: "linux",
        managedSettingsDir: tempDir,
      })).toBe(true);

      expect(await hasClaudeEndpointManagedSettings({
        platform: "darwin",
        managedSettingsDir: join(tempDir, "missing"),
        commandProbe,
      })).toBe(true);
      expect(commandCalls).toEqual([{
        command: "/usr/bin/defaults",
        args: ["read", "com.anthropic.claudecode"],
      }]);

      const windowsCalls: Array<{ command: string; args: string[] }> = [];
      const windowsProbe = (command: string, args: string[]): boolean => {
        windowsCalls.push({ command, args });
        return false;
      };
      expect(await hasClaudeEndpointManagedSettings({
        platform: "win32",
        managedSettingsDir: join(tempDir, "missing-windows"),
        commandProbe: windowsProbe,
      })).toBe(false);
      expect(windowsCalls).toHaveLength(2);
      expect(windowsCalls.every(({ command }) => (
        /[\\/]System32[\\/]reg\.exe$/iu.test(command)
        && command !== "reg.exe"
      ))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("wins over alternate-backend settings when spawning the fingerprint CLI", async () => {
    const alternateBackendVars = [...CLAUDE_CAPTURE_ALTERNATE_BACKEND_ENV_VARS];
    const previousEnv = Object.fromEntries([
      ["KYOLI_CLAUDE_CODE_PATH", process.env.KYOLI_CLAUDE_CODE_PATH],
      ["CLAUDE_CONFIG_DIR", process.env.CLAUDE_CONFIG_DIR],
      ["ANTHROPIC_BASE_URL", process.env.ANTHROPIC_BASE_URL],
      ["CAPTURE_ENV_PROBE_LOG", process.env.CAPTURE_ENV_PROBE_LOG],
      ...alternateBackendVars.map((variable) => [variable, process.env[variable]]),
    ]);
    const tempDir = await mkdtemp(join(tmpdir(), "kyoli-claude-capture-env-"));
    const configDir = join(tempDir, "config");
    const fakeClaudePath = join(tempDir, "claude.mjs");
    const probePath = join(tempDir, "probe.json");

    await mkdir(configDir);
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://settings.invalid",
          claude_code_use_bedrock: "1",
          ...Object.fromEntries(alternateBackendVars.map((variable) => [variable, "1"])),
        },
      }),
      "utf8",
    );
    await writeFile(
      fakeClaudePath,
      `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const variables = ${JSON.stringify(alternateBackendVars)};
const settings = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
const settingsIndex = process.argv.indexOf("--settings");
const cliSettings = settingsIndex >= 0
  ? JSON.parse(readFileSync(process.argv[settingsIndex + 1], "utf8"))
  : {};
const effectiveEnv = { ...(settings.env ?? {}), ...(cliSettings.env ?? {}) };
const safe = variables.every((variable) => !effectiveEnv[variable])
  && effectiveEnv.ANTHROPIC_BASE_URL === process.env.ANTHROPIC_BASE_URL
  && process.env.ANTHROPIC_BASE_URL.startsWith("http://127.0.0.1:");
writeFileSync(process.env.CAPTURE_ENV_PROBE_LOG, JSON.stringify({
  safe,
  effectiveEnv,
  inheritedSelectors: Object.fromEntries(variables.map((variable) => [variable, process.env[variable]])),
}));
process.exit(safe ? 0 : 9);
`,
      "utf8",
    );

    process.env.KYOLI_CLAUDE_CODE_PATH = fakeClaudePath;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.ANTHROPIC_BASE_URL = "https://parent.invalid";
    process.env.CAPTURE_ENV_PROBE_LOG = probePath;
    for (const variable of alternateBackendVars) {
      process.env[variable] = "1";
    }

    try {
      expect(await captureLiveTemplateAsync(2_000)).toBeNull();
      const probe = JSON.parse(await readFile(probePath, "utf8")) as {
        safe: boolean;
        effectiveEnv: Record<string, string>;
        inheritedSelectors: Record<string, string | undefined>;
      };
      expect(probe.safe).toBe(true);
      expect(probe.effectiveEnv.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
      for (const variable of alternateBackendVars) {
        expect(probe.effectiveEnv[variable]).toBe("");
        expect(probe.inheritedSelectors[variable]).toBeUndefined();
      }
    } finally {
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
