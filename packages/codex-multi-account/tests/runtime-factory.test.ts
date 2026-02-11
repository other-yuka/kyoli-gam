import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { AccountRuntimeFactory } from "../src/runtime-factory";
import { AccountStore } from "../src/account-store";
import { CODEX_API_ENDPOINT, TOKEN_EXPIRY_BUFFER_MS } from "../src/constants";
import { clearRefreshMutex } from "../src/token";
import {
  setupTestEnv,
  createMockClient,
  buildFakeJwt,
  createTokenResponse,
} from "./helpers";

describe("AccountRuntimeFactory", () => {
  let originalFetch: typeof globalThis.fetch;
  let store: AccountStore;
  let client: ReturnType<typeof createMockClient>;
  let cleanup: () => Promise<void>;

  const VALID_ACCESS_TOKEN = buildFakeJwt({ chatgpt_account_id: "acct-001" });
  const VALID_EXPIRES_AT = Date.now() + TOKEN_EXPIRY_BUFFER_MS + 600_000;

  async function seedAccount(overrides: Record<string, unknown> = {}) {
    const uuid = (overrides.uuid as string) ?? "test-uuid-0";
    await store.addAccount({
      uuid,
      accountId: "account-id-0",
      email: "test@example.com",
      planTier: "",
      refreshToken: "refresh-token-0",
      accessToken: VALID_ACCESS_TOKEN,
      expiresAt: VALID_EXPIRES_AT,
      addedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
      consecutiveAuthFailures: 0,
      isAuthDisabled: false,
      ...overrides,
    });
    return uuid;
  }

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    const env = await setupTestEnv();
    cleanup = env.cleanup;
    store = new AccountStore();
    client = createMockClient();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    clearRefreshMutex();
    await cleanup();
  });

  // ─── Runtime creation and caching ─────────────────────────────

  describe("runtime creation and caching", () => {
    test("getRuntime returns a runtime with a fetch function", async () => {
      await seedAccount();
      const factory = new AccountRuntimeFactory(store, client);

      const runtime = await factory.getRuntime("test-uuid-0");

      expect(runtime).toBeDefined();
      expect(typeof runtime.fetch).toBe("function");
    });

    test("getRuntime returns cached runtime on second call", async () => {
      await seedAccount();
      const factory = new AccountRuntimeFactory(store, client);

      const first = await factory.getRuntime("test-uuid-0");
      const second = await factory.getRuntime("test-uuid-0");

      expect(first).toBe(second);
    });

    test("getRuntime returns different runtimes for different UUIDs", async () => {
      await seedAccount({ uuid: "uuid-a" });
      await seedAccount({ uuid: "uuid-b", refreshToken: "refresh-b", email: "b@example.com" });
      const factory = new AccountRuntimeFactory(store, client);

      const runtimeA = await factory.getRuntime("uuid-a");
      const runtimeB = await factory.getRuntime("uuid-b");

      expect(runtimeA).not.toBe(runtimeB);
    });
  });

  // ─── Token and headers ────────────────────────────────────────

  describe("token and headers", () => {
    test("runtime fetch sets Authorization header with account accessToken", async () => {
      await seedAccount();
      const factory = new AccountRuntimeFactory(store, client);
      const runtime = await factory.getRuntime("test-uuid-0");

      let capturedHeaders: Headers | undefined;
      globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Headers;
        return new Response("ok");
      });

      await runtime.fetch("https://api.openai.com/v1/responses", { method: "POST" });

      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders!.get("authorization")).toBe(`Bearer ${VALID_ACCESS_TOKEN}`);
    });

    test("runtime fetch sets originator: opencode header", async () => {
      await seedAccount();
      const factory = new AccountRuntimeFactory(store, client);
      const runtime = await factory.getRuntime("test-uuid-0");

      let capturedHeaders: Headers | undefined;
      globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Headers;
        return new Response("ok");
      });

      await runtime.fetch("https://api.openai.com/v1/responses", { method: "POST" });

      expect(capturedHeaders!.get("originator")).toBe("opencode");
    });

    test("runtime fetch rewrites URL to CODEX_API_ENDPOINT for /v1/responses paths", async () => {
      await seedAccount();
      const factory = new AccountRuntimeFactory(store, client);
      const runtime = await factory.getRuntime("test-uuid-0");

      let capturedUrl: string | undefined;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        capturedUrl = input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input);
        return new Response("ok");
      });

      await runtime.fetch("https://api.openai.com/v1/responses", { method: "POST" });

      expect(capturedUrl).toBeDefined();
      expect(capturedUrl!.startsWith(CODEX_API_ENDPOINT)).toBe(true);
    });

    test("runtime fetch sets ChatGPT-Account-Id header when account has accountId", async () => {
      await seedAccount({ accountId: "acct-xyz-123" });
      const factory = new AccountRuntimeFactory(store, client);
      const runtime = await factory.getRuntime("test-uuid-0");

      let capturedHeaders: Headers | undefined;
      globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Headers;
        return new Response("ok");
      });

      await runtime.fetch("https://api.openai.com/v1/responses", { method: "POST" });

      expect(capturedHeaders!.get("chatgpt-account-id")).toBe("acct-xyz-123");
    });

    test("runtime fetch does not set ChatGPT-Account-Id when account has no accountId", async () => {
      await seedAccount({ accountId: undefined });
      const factory = new AccountRuntimeFactory(store, client);
      const runtime = await factory.getRuntime("test-uuid-0");

      let capturedHeaders: Headers | undefined;
      globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedHeaders = init?.headers as Headers;
        return new Response("ok");
      });

      await runtime.fetch("https://api.openai.com/v1/responses", { method: "POST" });

      expect(capturedHeaders!.get("chatgpt-account-id")).toBeNull();
    });
  });

  // ─── Token refresh trigger ────────────────────────────────────

  describe("token refresh trigger", () => {
    test("refreshes token when expiresAt is in the past and uses new token", async () => {
      const newAccessToken = buildFakeJwt({ chatgpt_account_id: "acct-refreshed" });
      await seedAccount({
        accessToken: buildFakeJwt({ chatgpt_account_id: "acct-001" }),
        expiresAt: Date.now() - 1000,
      });
      const factory = new AccountRuntimeFactory(store, client);
      const runtime = await factory.getRuntime("test-uuid-0");

      let capturedApiHeaders: Headers | undefined;
      const tokenEndpointUrl = "https://auth.openai.com/oauth/token";
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === tokenEndpointUrl) {
          return createTokenResponse({
            access_token: newAccessToken,
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          });
        }
        // Actual API request
        capturedApiHeaders = init?.headers as Headers;
        return new Response("ok");
      });

      await runtime.fetch("https://api.openai.com/v1/responses", { method: "POST" });

      expect(capturedApiHeaders).toBeDefined();
      expect(capturedApiHeaders!.get("authorization")).toBe(`Bearer ${newAccessToken}`);
    });

    test("token refresh updates account in store", async () => {
      const newAccessToken = buildFakeJwt({ chatgpt_account_id: "acct-updated" });
      await seedAccount({
        expiresAt: Date.now() - 1000,
      });
      const factory = new AccountRuntimeFactory(store, client);
      const runtime = await factory.getRuntime("test-uuid-0");

      const tokenEndpointUrl = "https://auth.openai.com/oauth/token";
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === tokenEndpointUrl) {
          return createTokenResponse({
            access_token: newAccessToken,
            refresh_token: "updated-refresh",
            expires_in: 7200,
          });
        }
        return new Response("ok");
      });

      await runtime.fetch("https://api.openai.com/v1/responses", { method: "POST" });

      const storage = await store.load();
      const account = storage.accounts.find((a) => a.uuid === "test-uuid-0");
      expect(account).toBeDefined();
      expect(account!.accessToken).toBe(newAccessToken);
      expect(account!.consecutiveAuthFailures).toBe(0);
      expect(account!.isAuthDisabled).toBe(false);
    });
  });

  // ─── Invalidation ─────────────────────────────────────────────

  describe("invalidation", () => {
    test("invalidate causes next getRuntime to create a new runtime", async () => {
      await seedAccount();
      const factory = new AccountRuntimeFactory(store, client);

      const first = await factory.getRuntime("test-uuid-0");
      factory.invalidate("test-uuid-0");
      const second = await factory.getRuntime("test-uuid-0");

      expect(first).not.toBe(second);
    });

    test("invalidateAll clears all cached runtimes", async () => {
      await seedAccount({ uuid: "uuid-x" });
      await seedAccount({ uuid: "uuid-y", refreshToken: "refresh-y", email: "y@example.com" });
      const factory = new AccountRuntimeFactory(store, client);

      const firstX = await factory.getRuntime("uuid-x");
      const firstY = await factory.getRuntime("uuid-y");
      factory.invalidateAll();
      const secondX = await factory.getRuntime("uuid-x");
      const secondY = await factory.getRuntime("uuid-y");

      expect(firstX).not.toBe(secondX);
      expect(firstY).not.toBe(secondY);
    });
  });

  // ─── Error handling ───────────────────────────────────────────

  describe("error handling", () => {
    test("throws when account UUID is not found in storage", async () => {
      const factory = new AccountRuntimeFactory(store, client);
      // getRuntime itself succeeds (creates a lazy runtime)
      const runtime = await factory.getRuntime("nonexistent-uuid");

      // The runtime's fetch throws when it can't find the account
      globalThis.fetch = vi.fn(async () => new Response("ok"));

      await expect(
        runtime.fetch("https://api.openai.com/v1/responses"),
      ).rejects.toThrow("No credentials found for account nonexistent-uuid");
    });

    test("throws when token refresh fails with error status", async () => {
      await seedAccount({
        expiresAt: Date.now() - 1000,
      });
      const factory = new AccountRuntimeFactory(store, client);
      const runtime = await factory.getRuntime("test-uuid-0");

      const tokenEndpointUrl = "https://auth.openai.com/oauth/token";
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === tokenEndpointUrl) {
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response("ok");
      });

      await expect(
        runtime.fetch("https://api.openai.com/v1/responses"),
      ).rejects.toThrow("Token refresh failed: 401");
    });

    test("throws when accessToken is missing and no refreshToken can help", async () => {
      await seedAccount({
        accessToken: undefined,
        expiresAt: undefined,
        refreshToken: "",
      });
      const factory = new AccountRuntimeFactory(store, client);
      const runtime = await factory.getRuntime("test-uuid-0");

      globalThis.fetch = vi.fn(async () => new Response("ok"));

      await expect(
        runtime.fetch("https://api.openai.com/v1/responses"),
      ).rejects.toThrow("Token refresh failed");
    });
  });

  // ─── Init lock deduplication ──────────────────────────────────

  describe("init lock deduplication", () => {
    test("concurrent getRuntime calls for same UUID return same runtime", async () => {
      await seedAccount();
      const factory = new AccountRuntimeFactory(store, client);

      const [first, second] = await Promise.all([
        factory.getRuntime("test-uuid-0"),
        factory.getRuntime("test-uuid-0"),
      ]);

      expect(first).toBe(second);
    });
  });
});
