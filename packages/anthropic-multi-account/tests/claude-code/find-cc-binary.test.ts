import { afterEach, describe, expect, test, vi } from "bun:test";
import {
  enumerateCCCandidates,
  findCCBinary,
  resetOAuthConfigDetectionForTest,
  setOAuthConfigDetectionOverridesForTest,
} from "../../src/claude-code/oauth-config/detect";

const originalAnthropicCcPath = process.env.ANTHROPIC_CC_PATH;
const originalPath = process.env.PATH;

function restoreEnv(): void {
  if (originalAnthropicCcPath === undefined) {
    delete process.env.ANTHROPIC_CC_PATH;
  } else {
    process.env.ANTHROPIC_CC_PATH = originalAnthropicCcPath;
  }

  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
}

function createExistsSync(paths: string[]): (path: string) => boolean {
  const knownPaths = new Set(paths.map((path) => path.toLowerCase()));
  return (path) => knownPaths.has(path.toLowerCase());
}

afterEach(() => {
  resetOAuthConfigDetectionForTest();
  restoreEnv();
  vi.restoreAllMocks();
});

describe("findCCBinary", () => {
  test("returns null when PATH is empty and no candidates exist", () => {
    setOAuthConfigDetectionOverridesForTest({
      existsSync: () => false,
      pathEnv: "",
      platform: () => "darwin",
    });

    expect(enumerateCCCandidates()).toEqual([]);
    expect(findCCBinary()).toBeNull();
  });

  test("fast-path returns a single unix candidate without probing", () => {
    const execFileSync = vi.fn();
    const candidate = "/tmp/claude-a/claude";

    setOAuthConfigDetectionOverridesForTest({
      existsSync: createExistsSync([candidate]),
      execFileSync: execFileSync as unknown as typeof import("node:child_process").execFileSync,
      pathEnv: "/tmp/claude-a",
      platform: () => "darwin",
    });

    expect(enumerateCCCandidates()).toEqual([candidate]);
    expect(findCCBinary()).toBe(candidate);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  test("returns the absolute path for a single candidate", () => {
    const candidate = "/tmp/claude-b/claude";

    setOAuthConfigDetectionOverridesForTest({
      existsSync: createExistsSync([candidate]),
      pathEnv: "/tmp/claude-b",
      platform: () => "darwin",
    });

    expect(findCCBinary()).toBe(candidate);
  });

  test("preserves PATH order when multiple unix candidates exist", () => {
    const first = "/tmp/claude-c/claude";
    const second = "/tmp/claude-d/claude";

    setOAuthConfigDetectionOverridesForTest({
      existsSync: createExistsSync([first, second]),
      pathEnv: "/tmp/claude-c:/tmp/claude-d",
      platform: () => "darwin",
    });

    expect(enumerateCCCandidates()).toEqual([first, second]);
  });

  test("deduplicates duplicate PATH entries", () => {
    const candidate = "/tmp/claude-e/claude";

    setOAuthConfigDetectionOverridesForTest({
      existsSync: createExistsSync([candidate]),
      pathEnv: "/tmp/claude-e:/tmp/claude-e",
      platform: () => "darwin",
    });

    expect(enumerateCCCandidates()).toEqual([candidate]);
  });

  test("orders windows same-dir candidates with .exe before .cmd", () => {
    const exe = "C:/tools/claude.exe";
    const cmd = "C:/tools/claude.cmd";

    setOAuthConfigDetectionOverridesForTest({
      existsSync: createExistsSync([exe, cmd]),
      pathEnv: "C:/tools",
      platform: () => "win32",
    });

    expect(enumerateCCCandidates()).toEqual([exe, cmd]);
  });

  test("picks the newest candidate across windows PATH entries", () => {
    const oldCmd = "C:/old/claude.cmd";
    const newExe = "C:/new/claude.exe";
    const execFileSync = vi.fn((binPath: string) => {
      if (binPath === oldCmd) {
        return "claude 2.1.117\n";
      }
      if (binPath === newExe) {
        return "claude 2.1.118\n";
      }
      throw new Error(`unexpected binary ${binPath}`);
    });

    setOAuthConfigDetectionOverridesForTest({
      existsSync: createExistsSync([oldCmd, newExe]),
      execFileSync: execFileSync as unknown as typeof import("node:child_process").execFileSync,
      pathEnv: "C:/old;C:/new",
      platform: () => "win32",
    });

    expect(findCCBinary()).toBe(newExe);
  });

  test("prefers ANTHROPIC_CC_PATH override without probing or enumeration", () => {
    const overridePath = "/tmp/override/claude";
    const execFileSync = vi.fn();
    process.env.ANTHROPIC_CC_PATH = overridePath;

    setOAuthConfigDetectionOverridesForTest({
      existsSync: createExistsSync([overridePath]),
      execFileSync: execFileSync as unknown as typeof import("node:child_process").execFileSync,
      pathEnv: "/tmp/ignored",
      platform: () => "darwin",
    });

    expect(findCCBinary()).toBe(overridePath);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
