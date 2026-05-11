import { describe, expect, it } from "vitest";
import {
  executeWithAccountFailover,
  type AccountExecutionTraceEvent,
  type SelectedCredential,
} from "../src/provider-executor";
import { StickyAccountPool } from "../src/account-pool";
import { MemoryAccountStore } from "../src/accounts";

describe("executeWithAccountFailover", () => {
  it("tries more than three accounts by default", async () => {
    const attempts: string[] = [];
    const credentials = Array.from({ length: 4 }, (_, index) => ({
      value: `token-${index + 1}`,
      accountId: `account-${index + 1}`,
    }));

    const response = await executeWithAccountFailover({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
      missingCredentialResponse: () => new Response("missing", { status: 401 }),
      failureMessage: (status) => `failed ${status}`,
      selectCredential: async (excludedAccountIds) =>
        credentials.find((credential) => !excludedAccountIds.includes(credential.accountId)),
      execute: async (credential: SelectedCredential) => {
        attempts.push(credential.accountId ?? "");
        return new Response("upstream", {
          status: attempts.length < 4 ? 429 : 200,
        });
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("upstream");
    expect(attempts).toEqual(["account-1", "account-2", "account-3", "account-4"]);
  });

  it("emits trace events for selection, retry, and success", async () => {
    const trace: AccountExecutionTraceEvent[] = [];
    const credentials = [
      { value: "token-1", accountId: "account-1" },
      { value: "token-2", accountId: "account-2" },
    ];

    const response = await executeWithAccountFailover({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
      missingCredentialResponse: () => new Response("missing", { status: 401 }),
      failureMessage: (status) => `failed ${status}`,
      onTrace: (event) => trace.push(event),
      selectCredential: async (excludedAccountIds) =>
        credentials.find((credential) => !excludedAccountIds.includes(credential.accountId)),
      execute: async (credential: SelectedCredential) =>
        new Response("upstream", {
          status: credential.accountId === "account-1" ? 429 : 200,
        }),
    });

    expect(response.status).toBe(200);
    expect(trace.map((event) => event.type)).toEqual([
      "selected",
      "response",
      "retry",
      "selected",
      "response",
    ]);
    expect(trace).toMatchObject([
      { type: "selected", accountId: "account-1", attempt: 1 },
      { type: "response", accountId: "account-1", attempt: 1, status: 429, retryable: true },
      { type: "retry", accountId: "account-1", attempt: 1, status: 429 },
      { type: "selected", accountId: "account-2", attempt: 2 },
      { type: "response", accountId: "account-2", attempt: 2, status: 200, retryable: false },
    ]);
  });

  it("returns a structured rate-limit response when every account is cooling down", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      name: "Codex test",
      credentials: { accessToken: "token" },
    });
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    await store.recordFailure(account.id, {
      status: 429,
      message: "rate limited",
      rateLimitResetAt: resetAt,
    });
    const accounts = new StickyAccountPool(store);

    const response = await executeWithAccountFailover({
      provider: "codex",
      kind: "oauth",
      accounts,
      sessionKey: "session-a",
      maxAttempts: 1,
      missingCredentialResponse: () => new Response("missing", { status: 401 }),
      failureMessage: (status) => `failed ${status}`,
      selectCredential: async (excludedAccountIds) => {
        const selected = await accounts.select({
          provider: "codex",
          kind: "oauth",
          sessionKey: "session-a",
          excludeAccountIds: excludedAccountIds,
        });
        return selected ? { value: "token", accountId: selected.id } : undefined;
      },
      execute: async () => new Response("unused"),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: "account_rate_limited",
        provider: "codex",
        kind: "oauth",
        summary: {
          total: 1,
          ready: 0,
          rate_limited: 1,
          next_reset_at: resetAt,
        },
      },
    });
  });

  it("keeps the missing credential response when the provider has no stored accounts", async () => {
    const store = new MemoryAccountStore();
    const accounts = new StickyAccountPool(store);

    const response = await executeWithAccountFailover({
      provider: "codex",
      kind: "oauth",
      accounts,
      sessionKey: "session-a",
      missingCredentialResponse: () => new Response("missing", { status: 401 }),
      failureMessage: (status) => `failed ${status}`,
      selectCredential: async () => undefined,
      execute: async () => new Response("unused"),
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("missing");
  });

  it("returns a structured exhausted response when every account requires re-authentication", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: "Claude test",
      credentials: { accessToken: "token" },
    });
    await store.recordFailure(account.id, {
      status: 401,
      message: "refresh failed",
      reauthRequiredReason: "refresh failed",
    });
    const accounts = new StickyAccountPool(store);

    const response = await executeWithAccountFailover({
      provider: "claude-code",
      kind: "oauth",
      accounts,
      sessionKey: "session-a",
      maxAttempts: 1,
      missingCredentialResponse: () => new Response("missing", { status: 401 }),
      failureMessage: (status) => `failed ${status}`,
      selectCredential: async (excludedAccountIds) => {
        const selected = await accounts.select({
          provider: "claude-code",
          kind: "oauth",
          sessionKey: "session-a",
          excludeAccountIds: excludedAccountIds,
        });
        return selected ? { value: "token", accountId: selected.id } : undefined;
      },
      execute: async () => new Response("unused"),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: "account_exhausted",
        provider: "claude-code",
        kind: "oauth",
        retryable: false,
        summary: {
          total: 1,
          ready: 0,
          reauth_required: 1,
        },
      },
    });
  });
});
