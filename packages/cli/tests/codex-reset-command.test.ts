import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteAccountStore } from "@kyoli-gam/core";
import { describe, expect, it, vi } from "vitest";
import {
  requiresCodexResetConsumeConfirmation,
  shouldEmitJsonConfirmationRequired,
} from "../src/codex-reset-command";

describe("codex reset command helpers", () => {
  it("requires --yes for JSON consume mode instead of prompting", () => {
    const argv = ["kyoli", "codex-reset", "consume", "acct_123", "--json"];

    expect(requiresCodexResetConsumeConfirmation(argv)).toBe(true);
    expect(shouldEmitJsonConfirmationRequired(argv)).toBe(true);
  });

  it("allows non-interactive JSON consume when --yes or --dry-run is present", () => {
    expect(shouldEmitJsonConfirmationRequired([
      "kyoli",
      "codex-reset",
      "consume",
      "acct_123",
      "--json",
      "--yes",
    ])).toBe(false);
    expect(shouldEmitJsonConfirmationRequired([
      "kyoli",
      "codex-reset",
      "consume",
      "acct_123",
      "--json",
      "--dry-run",
    ])).toBe(false);
  });

  it("adopts concurrent reauthentication and preserves later metadata changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyoli-codex-reset-race-"));
    const databasePath = join(dir, "kyoli.db");
    const originalArgv = process.argv;
    const originalDatabasePath = process.env.KYOLI_DATABASE_PATH;
    const originalConfigPath = process.env.KYOLI_CONFIG_PATH;
    const originalFetch = globalThis.fetch;
    const originalExitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let finishTokenRefresh: (() => void) | undefined;
    let finishUsage: (() => void) | undefined;

    try {
      const store = new SQLiteAccountStore(databasePath);
      const account = await store.create({
        provider: "codex",
        kind: "oauth",
        credentials: {
          accessToken: "initial-access",
          refreshToken: "initial-refresh",
          accountId: "generation-a-account",
          expiresAt: Date.now() - 1,
        },
        metadata: { owner: "initial", cachedUsageAt: 1 },
      });
      let signalTokenRefreshStarted: (() => void) | undefined;
      let signalUsageStarted: (() => void) | undefined;
      const tokenRefreshStarted = new Promise<void>((resolve) => {
        signalTokenRefreshStarted = resolve;
      });
      const tokenRefreshFinished = new Promise<void>((resolve) => {
        finishTokenRefresh = resolve;
      });
      const usageStarted = new Promise<void>((resolve) => {
        signalUsageStarted = resolve;
      });
      const usageFinished = new Promise<void>((resolve) => {
        finishUsage = resolve;
      });

      process.argv = [process.execPath, "kyoli", "codex-reset", "status", account.id, "--json"];
      process.env.KYOLI_DATABASE_PATH = databasePath;
      process.env.KYOLI_CONFIG_PATH = join(dir, "config.json");
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url === "https://auth.openai.com/oauth/token") {
          signalTokenRefreshStarted?.();
          await tokenRefreshFinished;
          return Response.json({
            access_token: "generation-a-refreshed-access",
            refresh_token: "generation-a-refreshed-refresh",
            expires_in: 3600,
            account_id: "generation-a-account",
          });
        }
        if (url.endsWith("/wham/rate-limit-reset-credits")) {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer generation-b-access");
          expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("generation-b-account");
          return Response.json({ available_count: 0, credits: [] });
        }
        if (url.endsWith("/wham/usage")) {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer generation-b-access");
          expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("generation-b-account");
          signalUsageStarted?.();
          await usageFinished;
          return Response.json({
            plan_type: "plus",
            rate_limit: {
              primary_window: { used_percent: 10, reset_after_seconds: 60 },
              secondary_window: { used_percent: 20, reset_after_seconds: 120 },
            },
          });
        }
        return Response.json({ error: "unexpected request" }, { status: 500 });
      };

      const command = import("../src/index");
      await tokenRefreshStarted;
      const concurrentStore = new SQLiteAccountStore(databasePath);
      await concurrentStore.update(account.id, {
        credentials: {
          accessToken: "generation-b-access",
          refreshToken: "generation-b-refresh",
          accountId: "generation-b-account",
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        },
        metadata: { owner: "reauthenticated", cachedUsageAt: 99 },
      });
      finishTokenRefresh?.();
      await usageStarted;
      await concurrentStore.update(account.id, {
        metadataPatch: { owner: "concurrent-during-usage" },
      });
      finishUsage?.();
      await command;

      const stored = await concurrentStore.get(account.id);
      expect(stored?.credentials).toMatchObject({
        accessToken: "generation-b-access",
        refreshToken: "generation-b-refresh",
        accountId: "generation-b-account",
      });
      expect(stored?.metadata).toMatchObject({
        owner: "concurrent-during-usage",
        cachedUsageAt: expect.any(Number),
        planTier: "plus",
      });
    } finally {
      finishTokenRefresh?.();
      finishUsage?.();
      process.argv = originalArgv;
      if (originalDatabasePath === undefined) delete process.env.KYOLI_DATABASE_PATH;
      else process.env.KYOLI_DATABASE_PATH = originalDatabasePath;
      if (originalConfigPath === undefined) delete process.env.KYOLI_CONFIG_PATH;
      else process.env.KYOLI_CONFIG_PATH = originalConfigPath;
      globalThis.fetch = originalFetch;
      process.exitCode = originalExitCode;
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a stale Claude metadata refresh after concurrent reauthentication", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kyoli-accounts-refresh-race-"));
    const databasePath = join(dir, "kyoli.db");
    const originalArgv = process.argv;
    const originalDatabasePath = process.env.KYOLI_DATABASE_PATH;
    const originalConfigPath = process.env.KYOLI_CONFIG_PATH;
    const originalFetch = globalThis.fetch;
    const originalExitCode = process.exitCode;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let finishMetadataRefresh: (() => void) | undefined;

    try {
      const store = new SQLiteAccountStore(databasePath);
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
        credentials: {
          accessToken: "generation-a-access",
          refreshToken: "generation-a-refresh",
          expiresAt: Date.now() + 60 * 60 * 1000,
        },
        metadata: { owner: "generation-a", planTier: "pro" },
      });
      let signalMetadataRefreshStarted: (() => void) | undefined;
      const metadataRefreshStarted = new Promise<void>((resolve) => {
        signalMetadataRefreshStarted = resolve;
      });
      const metadataRefreshFinished = new Promise<void>((resolve) => {
        finishMetadataRefresh = resolve;
      });

      process.argv = [process.execPath, "kyoli", "accounts", "refresh", account.id];
      process.env.KYOLI_DATABASE_PATH = databasePath;
      process.env.KYOLI_CONFIG_PATH = join(dir, "config.json");
      globalThis.fetch = async (input) => {
        signalMetadataRefreshStarted?.();
        await metadataRefreshFinished;
        const url = String(input);
        if (url.endsWith("/api/oauth/profile")) {
          return Response.json({
            account: { email: "generation-a@example.test", has_claude_pro: true },
          });
        }
        if (url.endsWith("/api/oauth/usage")) {
          return Response.json({
            five_hour: { utilization: 10, resets_at: null },
          });
        }
        return Response.json({ error: "unexpected request" }, { status: 500 });
      };

      vi.resetModules();
      const command = import("../src/index");
      await metadataRefreshStarted;
      await store.update(account.id, {
        credentials: {
          accessToken: "generation-b-access",
          refreshToken: "generation-b-refresh",
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        },
        metadata: { owner: "generation-b", planTier: "max" },
      });
      finishMetadataRefresh?.();

      await expect(command).rejects.toThrow("Account credentials changed while refreshing");
      const stored = await store.get(account.id);
      expect(stored?.credentials).toMatchObject({
        accessToken: "generation-b-access",
        refreshToken: "generation-b-refresh",
      });
      expect(stored?.metadata).toEqual({ owner: "generation-b", planTier: "max" });
    } finally {
      finishMetadataRefresh?.();
      process.argv = originalArgv;
      if (originalDatabasePath === undefined) delete process.env.KYOLI_DATABASE_PATH;
      else process.env.KYOLI_DATABASE_PATH = originalDatabasePath;
      if (originalConfigPath === undefined) delete process.env.KYOLI_CONFIG_PATH;
      else process.env.KYOLI_CONFIG_PATH = originalConfigPath;
      globalThis.fetch = originalFetch;
      process.exitCode = originalExitCode;
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
