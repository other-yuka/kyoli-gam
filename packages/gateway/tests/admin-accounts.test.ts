import { describe, expect, it } from "vitest";
import { MemoryAccountStore, MemoryRequestLogStore, StickyAccountPool } from "@kyoli-gam/core";
import { createGateway } from "../src";

describe("admin accounts API", () => {
  it("protects admin routes when an admin token is configured", async () => {
    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [],
      adminToken: "admin-secret",
    });

    const unauthorized = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/accounts"),
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/accounts", {
        headers: { authorization: "Bearer admin-secret" },
      }),
    );
    expect(authorized.status).toBe(200);

    const headerAuthorized = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/accounts", {
        headers: { "x-kyoli-admin-token": "admin-secret" },
      }),
    );
    expect(headerAuthorized.status).toBe(200);
  });

  it("creates, lists, updates, and deletes accounts without exposing credentials", async () => {
    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [],
    });

    const createResponse = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          kind: "oauth",
          name: "Codex test",
          credentials: { refreshToken: "refresh-test" },
          metadata: { plan: "plus" },
        }),
      }),
    );

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      id: string;
      credentialKeys: string[];
      credentials?: unknown;
    };
    expect(created.credentials).toBeUndefined();
    expect(created.credentialKeys).toEqual(["refreshToken"]);

    const listResponse = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/accounts"),
    );
    const listed = (await listResponse.json()) as { data: unknown[] };
    expect(listResponse.status).toBe(200);
    expect(listed.data).toHaveLength(1);

    const patchResponse = await gateway.fetch(
      new Request(`http://127.0.0.1:2021/admin/accounts/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    const patched = (await patchResponse.json()) as { enabled: boolean };
    expect(patchResponse.status).toBe(200);
    expect(patched.enabled).toBe(false);

    const deleteResponse = await gateway.fetch(
      new Request(`http://127.0.0.1:2021/admin/accounts/${created.id}`, {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(204);
  });

  it("rejects invalid account providers", async () => {
    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "unknown",
          kind: "oauth",
        }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects removed API provider ids", async () => {
    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          kind: "oauth",
        }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects api-key account kinds", async () => {
    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      providers: [],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          kind: "api-key",
        }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("summarizes account status without exposing credentials", async () => {
    const accounts = new MemoryAccountStore();
    const limited = await accounts.create({
      provider: "codex",
      kind: "oauth",
      credentials: { accessToken: "secret-access" },
    });
    await accounts.recordFailure(limited.id, {
      status: 429,
      message: "rate limited",
      rateLimitResetAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await accounts.create({
      provider: "codex",
      kind: "oauth",
      credentials: { accessToken: "ready-secret" },
    });
    await accounts.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: { accessToken: "claude-secret" },
    });
    const gateway = createGateway({
      accounts,
      providers: [],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/accounts/status?provider=codex"),
    );
    const body = (await response.json()) as {
      object: string;
      data: Array<{ provider: string; total: number; ready: number; rate_limited: number }>;
      ready: Array<{ id: string; provider: string }>;
      rate_limited: Array<{ id: string; provider: string; reset_at: string }>;
      blocked: Array<{ id: string; provider: string }>;
      failed: Array<{ id: string; provider: string }>;
      expired_rate_limits: Array<{ id: string; provider: string }>;
      credentials?: unknown;
    };

    expect(response.status).toBe(200);
    expect(body.object).toBe("account_status");
    expect(body.credentials).toBeUndefined();
    expect(body.data).toEqual([
      expect.objectContaining({
        provider: "codex",
        total: 2,
        ready: 1,
        rate_limited: 1,
      }),
    ]);
    expect(body.rate_limited).toEqual([
      expect.objectContaining({
        id: limited.id,
        provider: "codex",
      }),
    ]);
    expect(body.ready).toEqual([
      expect.objectContaining({
        provider: "codex",
      }),
    ]);
    expect(body.blocked).toEqual([]);
    expect(body.failed).toEqual([
      expect.objectContaining({
        id: limited.id,
        provider: "codex",
      }),
    ]);
    expect(body.expired_rate_limits).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("serves Codex usage from cached account metadata", async () => {
    const accounts = new MemoryAccountStore();
    await accounts.create({
      provider: "codex",
      kind: "oauth",
      metadata: {
        planType: "plus",
        cachedUsage: {
          five_hour: {
            utilization: "42",
            reset_at: new Date(Date.now() + 60_000).toISOString(),
          },
          seven_day: {
            utilization: "11",
          },
          credits: {
            has_credits: true,
            unlimited: false,
            balance: "10",
          },
        },
      },
    });
    const gateway = createGateway({
      accounts,
      providers: [],
    });

    const response = await gateway.fetch(new Request("http://127.0.0.1:2021/api/codex/usage"));
    const body = await response.json() as {
      object: string;
      plan_type: string;
      rate_limit: { primary_window: { used_percent: number } };
      credits: { balance: string };
      additional_rate_limits: Array<{ quota_key: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.object).toBe("codex.usage");
    expect(body.plan_type).toBe("plus");
    expect(body.rate_limit.primary_window.used_percent).toBe(42);
    expect(body.credits.balance).toBe("10");
    expect(body.additional_rate_limits.map((limit) => limit.quota_key)).toContain("five_hour");
  });

  it("resets expired rate-limit state in bulk", async () => {
    const accounts = new MemoryAccountStore();
    const expired = await accounts.create({
      provider: "codex",
      kind: "oauth",
    });
    await accounts.recordFailure(expired.id, {
      status: 429,
      message: "old limit",
      rateLimitResetAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const active = await accounts.create({
      provider: "codex",
      kind: "oauth",
    });
    await accounts.recordFailure(active.id, {
      status: 429,
      message: "active limit",
      rateLimitResetAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const gateway = createGateway({
      accounts,
      providers: [],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/accounts/reset-expired?provider=codex", {
        method: "POST",
      }),
    );
    const body = (await response.json()) as {
      data: Array<{ id: string; failureCount: number; rateLimitResetAt?: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        id: expired.id,
        failureCount: 0,
      }),
    ]);
    expect((await accounts.get(expired.id))?.rateLimitResetAt).toBeUndefined();
    expect((await accounts.get(active.id))?.rateLimitResetAt).toBeDefined();
  });

  it("pauses and reactivates accounts with codex-lb-style actions", async () => {
    const accounts = new MemoryAccountStore();
    const account = await accounts.create({
      provider: "codex",
      kind: "oauth",
      credentials: { accessToken: "secret-access" },
    });
    await accounts.recordFailure(account.id, {
      status: 401,
      message: "bad token",
      reauthRequiredReason: "bad token",
    });
    const gateway = createGateway({
      accounts,
      providers: [],
    });

    const pauseResponse = await gateway.fetch(
      new Request(`http://127.0.0.1:2021/admin/accounts/${account.id}/pause`, {
        method: "POST",
      }),
    );
    const paused = (await pauseResponse.json()) as { enabled: boolean };
    expect(pauseResponse.status).toBe(200);
    expect(paused.enabled).toBe(false);

    const reactivateResponse = await gateway.fetch(
      new Request(`http://127.0.0.1:2021/admin/accounts/${account.id}/reactivate`, {
        method: "POST",
      }),
    );
    const reactivated = (await reactivateResponse.json()) as {
      enabled: boolean;
      failureCount: number;
      reauthRequiredReason?: string;
      credentials?: unknown;
    };

    expect(reactivateResponse.status).toBe(200);
    expect(reactivated.enabled).toBe(true);
    expect(reactivated.failureCount).toBe(0);
    expect(reactivated.reauthRequiredReason).toBeUndefined();
    expect(reactivated.credentials).toBeUndefined();
  });

  it("lists, deletes, and clears sticky session mappings", async () => {
    const accounts = new MemoryAccountStore();
    const account = await accounts.create({
      provider: "codex",
      kind: "oauth",
    });
    const stickySessions = new StickyAccountPool(accounts);
    await stickySessions.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
    });
    await stickySessions.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-b",
    });
    const gateway = createGateway({
      accounts,
      stickySessions,
      providers: [],
    });

    const listResponse = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/sticky-sessions?provider=codex"),
    );
    const listed = (await listResponse.json()) as {
      data: Array<{ key: string; accountId: string }>;
      total: number;
    };

    expect(listResponse.status).toBe(200);
    expect(listed.total).toBe(2);
    expect(listed.data).toContainEqual(
      expect.objectContaining({
        key: "codex:oauth:session-a",
        accountId: account.id,
      }),
    );

    const deleteResponse = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/sticky-sessions/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "codex:oauth:session-a" }),
      }),
    );
    expect(deleteResponse.status).toBe(200);
    expect(stickySessions.listStickySessions()).toHaveLength(1);

    const clearResponse = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/sticky-sessions/clear", {
        method: "POST",
      }),
    );
    const cleared = (await clearResponse.json()) as { deleted_count: number };
    expect(clearResponse.status).toBe(200);
    expect(cleared.deleted_count).toBe(1);
    expect(stickySessions.listStickySessions()).toEqual([]);
  });

  it("purges stale sticky session mappings", async () => {
    const accounts = new MemoryAccountStore();
    await accounts.create({ provider: "codex", kind: "oauth" });
    const stickySessions = new StickyAccountPool(accounts);
    await stickySessions.select({
      provider: "codex",
      kind: "oauth",
      sessionKey: "session-a",
    });
    const gateway = createGateway({
      accounts,
      stickySessions,
      providers: [],
    });

    const response = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/sticky-sessions/purge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxAgeSeconds: 0 }),
      }),
    );
    const body = (await response.json()) as { deleted_count: number };

    expect(response.status).toBe(200);
    expect(body.deleted_count).toBe(1);
    expect(stickySessions.listStickySessions()).toEqual([]);
  });

  it("lists and clears request logs", async () => {
    const requestLogs = new MemoryRequestLogStore();
    const requestId = "request-a";
    requestLogs.createRequestLog({
      requestId,
      provider: "codex",
      route: "/v1/responses",
      model: "gpt-5.3-codex",
      sessionKey: "session-a",
      accountId: "account-a",
      eventType: "selected",
      attempt: 1,
    });
    requestLogs.createRequestLog({
      requestId,
      provider: "codex",
      route: "/v1/responses",
      model: "gpt-5.3-codex",
      sessionKey: "session-a",
      accountId: "account-a",
      eventType: "response",
      attempt: 1,
      status: 200,
      retryable: false,
    });
    const gateway = createGateway({
      accounts: new MemoryAccountStore(),
      requestLogs,
      providers: [],
    });

    const listResponse = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/request-logs?provider=codex&status=200"),
    );
    const listed = (await listResponse.json()) as {
      data: Array<{ accountId: string; status: number }>;
    };
    expect(listResponse.status).toBe(200);
    expect(listed.data).toEqual([
      expect.objectContaining({
        requestId,
        accountId: "account-a",
        status: 200,
      }),
    ]);

    const groupedResponse = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/request-logs?provider=codex&grouped=true"),
    );
    const grouped = (await groupedResponse.json()) as {
      object: string;
      data: Array<{ requestId: string; finalStatus?: number; events: unknown[] }>;
    };
    expect(grouped.object).toBe("request_log_group_list");
    expect(grouped.data).toEqual([
      expect.objectContaining({
        requestId,
        finalStatus: 200,
        events: expect.arrayContaining([
          expect.objectContaining({ eventType: "selected" }),
          expect.objectContaining({ eventType: "response" }),
        ]),
      }),
    ]);

    const clearResponse = await gateway.fetch(
      new Request("http://127.0.0.1:2021/admin/request-logs/clear", {
        method: "POST",
      }),
    );
    const cleared = (await clearResponse.json()) as { deleted_count: number };
    expect(clearResponse.status).toBe(200);
    expect(cleared.deleted_count).toBe(2);
  });

  it("resets transient account failure state", async () => {
    const accounts = new MemoryAccountStore();
    const account = await accounts.create({
      provider: "codex",
      kind: "oauth",
      enabled: false,
      credentials: { accessToken: "secret-access" },
    });
    await accounts.recordFailure(account.id, {
      status: 401,
      message: "bad token",
      reauthRequiredReason: "bad token",
    });
    const gateway = createGateway({
      accounts,
      providers: [],
    });

    const response = await gateway.fetch(
      new Request(`http://127.0.0.1:2021/admin/accounts/${account.id}/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enable: true }),
      }),
    );
    const body = (await response.json()) as {
      enabled: boolean;
      failureCount: number;
      lastErrorAt?: string;
      rateLimitResetAt?: string;
      reauthRequiredReason?: string;
      credentials?: unknown;
    };

    expect(response.status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.failureCount).toBe(0);
    expect(body.lastErrorAt).toBeUndefined();
    expect(body.rateLimitResetAt).toBeUndefined();
    expect(body.reauthRequiredReason).toBeUndefined();
    expect(body.credentials).toBeUndefined();
  });
});
