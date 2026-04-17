import { afterAll, beforeEach, describe, expect, mock, test, vi } from "bun:test";
import { join } from "node:path";

const originalFsModule = await import("node:fs");
const originalOsModule = await import("node:os");

const readFileSyncMock = vi.fn();
const readdirSyncMock = vi.fn();
const homedirMock = vi.fn();

mock.module("node:fs", () => ({
  ...originalFsModule,
  readFileSync: readFileSyncMock,
  readdirSync: readdirSyncMock,
}));

mock.module("node:os", () => ({
  ...originalOsModule,
  homedir: homedirMock,
}));

const { loadClaudeIdentity } = await import("../src/claude-identity");

describe("loadClaudeIdentity", () => {
  beforeEach(() => {
    homedirMock.mockReturnValue("/mock-home");
    readFileSyncMock.mockReset();
    readdirSyncMock.mockReset();
  });

  afterAll(() => {
    mock.module("node:fs", () => originalFsModule);
    mock.module("node:os", () => originalOsModule);
  });

  test("returns identity from the first matching file", () => {
    readdirSyncMock.mockReturnValue([]);
    readFileSyncMock.mockImplementation((path) => {
      expect(path).toBe(join("/mock-home", ".claude.json"));
      return JSON.stringify({
        userID: "dev-123",
        oauthAccount: {
          accountUuid: "acc-456",
        },
      });
    });

    expect(loadClaudeIdentity()).toEqual({
      deviceId: "dev-123",
      accountUuid: "acc-456",
    });
  });

  test("returns empty identity when every candidate file is missing", () => {
    readdirSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(loadClaudeIdentity()).toEqual({
      deviceId: "",
      accountUuid: "",
    });
  });

  test("returns empty identity when JSON is malformed", () => {
    readdirSyncMock.mockReturnValue([]);
    readFileSyncMock.mockReturnValue("not json" as never);

    expect(loadClaudeIdentity()).toEqual({
      deviceId: "",
      accountUuid: "",
    });
  });

  test("falls back through configured search order and prefers newest backup file first", () => {
    readdirSyncMock.mockReturnValue([
      ".claude.json.backup.2026-01-01T00-00-00Z",
      ".claude.json.backup.2026-03-01T00-00-00Z",
      "ignore-me.json",
    ] as never);

    readFileSyncMock.mockImplementation((path) => {
      if (path === join("/mock-home", ".claude.json")) {
        throw new Error("ENOENT");
      }

      if (path === join("/mock-home", ".claude", ".claude.json")) {
        return JSON.stringify({ accountUuid: "missing-user-id" });
      }

      if (path === join("/mock-home", ".claude", "claude.json")) {
        throw new Error("ENOENT");
      }

      if (path === join("/mock-home", ".claude", "backups", ".claude.json.backup.2026-03-01T00-00-00Z")) {
        return JSON.stringify({
          userID: "dev-newest",
          accountUuid: "acc-newest",
        });
      }

      throw new Error(`unexpected path: ${String(path)}`);
    });

    expect(loadClaudeIdentity()).toEqual({
      deviceId: "dev-newest",
      accountUuid: "acc-newest",
    });

    expect(readFileSyncMock.mock.calls.map(([path]) => path)).toEqual([
      join("/mock-home", ".claude.json"),
      join("/mock-home", ".claude", ".claude.json"),
      join("/mock-home", ".claude", "claude.json"),
      join("/mock-home", ".claude", "backups", ".claude.json.backup.2026-03-01T00-00-00Z"),
    ]);
  });
});
