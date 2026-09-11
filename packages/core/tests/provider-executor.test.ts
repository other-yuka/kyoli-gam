import { describe, expect, it, vi } from "vitest";
import {
  executeWithAccountFailover,
  type AccountExecutionTraceEvent,
  type SelectedCredential,
} from "../src/provider-executor";
import { StickyAccountPool } from "../src/account-pool";
import {
  MemoryAccountStore,
  captureRateLimitRevision,
  createAccountRefreshUpdate,
} from "../src/accounts";

describe("executeWithAccountFailover", () => {
  it("uses a refreshed credential for same-account retry and success recording", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: { accessToken: "old-token", refreshToken: "old-refresh" },
    });
    await store.recordFailure(account.id, {
      status: 500,
      message: "earlier server failure",
      failureClass: "transient",
    });
    const refreshedAccount = await store.update(account.id, createAccountRefreshUpdate(account, {
      credentials: { accessToken: "new-token", refreshToken: "new-refresh" },
    }));
    if (!refreshedAccount) throw new Error("Expected refreshed account");
    const attemptedTokens: string[] = [];

    const response = await executeWithAccountFailover({
      provider: "codex",
      kind: "oauth",
      accounts: new StickyAccountPool(store),
      configuredCredential: {
        value: "old-token",
        accountId: account.id,
        rateLimitRevision: captureRateLimitRevision(account),
      },
      sessionKey: "refreshed-credential-retry",
      maxAttempts: 1,
      sameAccountMaxRetries: 1,
      missingCredentialResponse: () => new Response("missing", { status: 401 }),
      failureMessage: (status) => `failed ${status}`,
      selectCredential: async () => undefined,
      execute: async (credential) => {
        attemptedTokens.push(credential.value);
        if (attemptedTokens.length === 1) {
          return {
            response: new Response("retry", { status: 503 }),
            downstreamVisible: false,
            failure: {
              class: "transient",
              phase: "startup",
              httpStatus: 503,
              retryScope: "same_account",
            },
            effectiveCredential: {
              value: "new-token",
              accountId: account.id,
              rateLimitRevision: captureRateLimitRevision(refreshedAccount),
            },
          };
        }
        return new Response("ok", { status: 200 });
      },
    });

    expect(response.status).toBe(200);
    expect(attemptedTokens).toEqual(["old-token", "new-token"]);
    await expect(store.get(account.id)).resolves.toMatchObject({
      failureCount: 0,
      lastFailureClass: undefined,
    });
  });

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

  it("emits selection diagnostics on selected trace events", async () => {
    const trace: AccountExecutionTraceEvent[] = [];
    const response = await executeWithAccountFailover({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
      missingCredentialResponse: () => new Response("missing", { status: 401 }),
      failureMessage: (status) => `failed ${status}`,
      onTrace: (event) => trace.push(event),
      selectCredential: async () => ({
        value: "token-1",
        accountId: "account-1",
        selectionDiagnostics: {
          selectedReason: "round_robin",
          selectedAccount: {
            id: "account-1",
            usage: { five_hour: 20, seven_day: 30, max: 30 },
          },
          softQuotaSkippedAccountIds: ["account-2"],
        },
      }),
      execute: async () => new Response("upstream", { status: 200 }),
    });

    expect(response.status).toBe(200);
    expect(trace[0]).toMatchObject({
      type: "selected",
      accountId: "account-1",
      selectionDiagnostics: {
        selectedReason: "round_robin",
        softQuotaSkippedAccountIds: ["account-2"],
      },
    });
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

  it("stores quota reset and provider retry cooldown as separate boundaries", async () => {
    const now = new Date("2026-09-11T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const store = new MemoryAccountStore();
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
        credentials: { accessToken: "token" },
      });
      const resetAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      const cooldownUntil = new Date(now.getTime() + 2 * 60 * 1000).toISOString();

      await executeWithAccountFailover({
        provider: "claude-code",
        kind: "oauth",
        accounts: new StickyAccountPool(store),
        configuredCredential: {
          value: "token",
          accountId: account.id,
          rateLimitRevision: captureRateLimitRevision(account),
        },
        sessionKey: "separate-rate-boundaries",
        maxAttempts: 1,
        missingCredentialResponse: () => new Response("missing", { status: 401 }),
        failureMessage: (status) => `failed ${status}`,
        selectCredential: async () => undefined,
        execute: async () => ({
          response: new Response("limited", { status: 429 }),
          downstreamVisible: false,
          failure: {
            class: "rate_limit",
            code: "rate_limit",
            httpStatus: 429,
            phase: "startup",
            resetAt,
            retryAfterSeconds: 120,
            retryScope: "next_account",
          },
        }),
      });

      await expect(store.get(account.id)).resolves.toMatchObject({
        rateLimitResetAt: resetAt,
        rateLimitCooldownUntil: cooldownUntil,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an older successful request clear a newer rate limit", async () => {
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const store = new MemoryAccountStore();
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
        credentials: { accessToken: "token" },
      });
      let signalExecutionStarted: (() => void) | undefined;
      let finishExecution: ((response: Response) => void) | undefined;
      const executionStarted = new Promise<void>((resolve) => {
        signalExecutionStarted = resolve;
      });
      const executionFinished = new Promise<Response>((resolve) => {
        finishExecution = resolve;
      });

      const request = executeWithAccountFailover({
        provider: "claude-code",
        kind: "oauth",
        accounts: new StickyAccountPool(store),
        configuredCredential: {
          value: "token",
          accountId: account.id,
          rateLimitRevision: captureRateLimitRevision(account),
        },
        sessionKey: "success-after-rate-limit",
        maxAttempts: 1,
        missingCredentialResponse: () => new Response("missing", { status: 401 }),
        failureMessage: (status) => `failed ${status}`,
        selectCredential: async () => undefined,
        execute: async () => {
          signalExecutionStarted?.();
          return executionFinished;
        },
      });

      await executionStarted;
      const resetAt = new Date(now + 60 * 60 * 1000).toISOString();
      const cooldownUntil = new Date(now + 60_000).toISOString();
      await store.recordFailure(account.id, {
        status: 429,
        message: "newer rate limit",
        failureClass: "rate_limit",
        failureCode: "rate_limit",
        failurePhase: "startup",
        rateLimitResetAt: resetAt,
        rateLimitCooldownUntil: cooldownUntil,
      });
      finishExecution?.(new Response("ok", { status: 200 }));

      await expect(request).resolves.toMatchObject({ status: 200 });
      await expect(store.get(account.id)).resolves.toMatchObject({
        failureCount: 1,
        lastFailureMessage: "newer rate limit",
        rateLimitResetAt: resetAt,
        rateLimitCooldownUntil: cooldownUntil,
        rateLimitObservedAt: now,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a same-millisecond rate limit captured by the successful request", async () => {
    const now = new Date("2026-09-11T00:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const store = new MemoryAccountStore();
      const account = await store.create({
        provider: "claude-code",
        kind: "oauth",
        credentials: { accessToken: "token" },
      });
      await store.recordFailure(account.id, {
        status: 429,
        message: "first rate limit",
        rateLimitCooldownUntil: new Date(now + 60_000).toISOString(),
      });
      const blocked = await store.recordFailure(account.id, {
        status: 429,
        message: "second rate limit",
        rateLimitCooldownUntil: new Date(now + 60_000).toISOString(),
      });
      if (!blocked) throw new Error("Expected blocked account");

      const response = await executeWithAccountFailover({
        provider: "claude-code",
        kind: "oauth",
        accounts: new StickyAccountPool(store),
        configuredCredential: {
          value: "token",
          accountId: account.id,
          rateLimitRevision: captureRateLimitRevision(blocked),
        },
        sessionKey: "same-millisecond-success",
        maxAttempts: 1,
        missingCredentialResponse: () => new Response("missing", { status: 401 }),
        failureMessage: (status) => `failed ${status}`,
        selectCredential: async () => undefined,
        execute: async () => new Response("ok", { status: 200 }),
      });

      expect(response.status).toBe(200);
      await expect(store.get(account.id)).resolves.toMatchObject({
        failureCount: 0,
        rateLimitObservedAt: now + 2,
      });
      const recovered = await store.get(account.id);
      expect(recovered?.rateLimitResetAt).toBeUndefined();
      expect(recovered?.rateLimitBlockedAt).toBeUndefined();
      expect(recovered?.rateLimitCooldownUntil).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears rate-limit state for a successful legacy credential", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: { accessToken: "token" },
    });
    await store.recordFailure(account.id, {
      status: 429,
      message: "rate limited",
      failureClass: "rate_limit",
      failureCode: "rate_limit",
      rateLimitCooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    });

    const response = await executeWithAccountFailover({
      provider: "claude-code",
      kind: "oauth",
      accounts: new StickyAccountPool(store),
      configuredCredential: {
        value: "token",
        accountId: account.id,
      },
      sessionKey: "legacy-credential-success",
      maxAttempts: 1,
      missingCredentialResponse: () => new Response("missing", { status: 401 }),
      failureMessage: (status) => `failed ${status}`,
      selectCredential: async () => undefined,
      execute: async () => new Response("ok", { status: 200 }),
    });

    expect(response.status).toBe(200);
    await expect(store.get(account.id)).resolves.toMatchObject({ failureCount: 0 });
    const recovered = await store.get(account.id);
    expect(recovered?.rateLimitBlockedAt).toBeUndefined();
    expect(recovered?.rateLimitCooldownUntil).toBeUndefined();
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
