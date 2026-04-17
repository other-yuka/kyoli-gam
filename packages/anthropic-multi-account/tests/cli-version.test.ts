import { afterAll, afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test";

const execFileSyncMock = vi.fn();

mock.module("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

const cliVersionModule = await import("../src/cli-version");

const { detectCliVersion, resetDetectedVersionForTest } = cliVersionModule;

const originalCliVersion = process.env.ANTHROPIC_CLI_VERSION;

function restoreCliVersionEnv(): void {
  if (originalCliVersion === undefined) {
    delete process.env.ANTHROPIC_CLI_VERSION;
    return;
  }

  process.env.ANTHROPIC_CLI_VERSION = originalCliVersion;
}

beforeEach(() => {
  resetDetectedVersionForTest();
  execFileSyncMock.mockReset();
  restoreCliVersionEnv();
});

afterEach(() => {
  resetDetectedVersionForTest();
  execFileSyncMock.mockReset();
  restoreCliVersionEnv();
});

afterAll(() => {
  restoreCliVersionEnv();
});

describe("detectCliVersion", () => {
  test("returns parsed semver when the Claude binary is available", () => {
    execFileSyncMock.mockReturnValue("claude v2.3.5\n");

    const version = detectCliVersion();

    expect(version).toBe("2.3.5");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock).toHaveBeenCalledWith("claude", ["--version"], {
      encoding: "utf8",
      timeout: 3_000,
    });
  });

  test("falls back when the Claude binary is missing", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("missing");
    });

    expect(detectCliVersion()).toBe("2.1.100");
  });

  test("falls back when the version output does not contain a strict semver", () => {
    execFileSyncMock.mockReturnValue("claude dev-build\n");

    expect(detectCliVersion()).toBe("2.1.100");
  });

  test("uses the env override before probing the binary", () => {
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9";

    expect(detectCliVersion()).toBe("9.9.9");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  test("memoizes the detected version until reset", () => {
    execFileSyncMock.mockReturnValue("claude v2.3.5\n");

    expect(detectCliVersion()).toBe("2.3.5");

    execFileSyncMock.mockReturnValue("claude v2.4.0\n");

    expect(detectCliVersion()).toBe("2.3.5");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  test("resetDetectedVersionForTest clears the memoized value", () => {
    execFileSyncMock.mockReturnValueOnce("claude v2.3.5\n").mockReturnValueOnce("claude v2.4.0\n");

    expect(detectCliVersion()).toBe("2.3.5");

    resetDetectedVersionForTest();

    expect(detectCliVersion()).toBe("2.4.0");
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });
});
