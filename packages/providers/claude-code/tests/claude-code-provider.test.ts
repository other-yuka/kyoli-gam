import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryAccountStore, StickyAccountPool } from "@kyoli-gam/core";
import {
  applyClaudeCodeUpstreamBodyFields,
  checkClaudeCodeTemplateDrift,
  CLIENT_SYSTEM_PREFACE,
  cchForBody,
  composeClaudeCodeBillingSystemEntry,
  computeClaudeCodeBuildTag,
  createClaudeCodePerRequestHeaders,
  createClaudeCodeStaticHeaders,
  createClaudeCodeProvider,
  getClaudeCodeTemplateMetadata,
  getClaudeCodeTemplateTools,
  isClaudeCodeNonSubscriptionBillingClaim,
  loadClaudeCodeSharedRequestProfile,
  orderClaudeCodeHeadersForOutbound,
  refreshClaudeCodeAccountMetadata,
  refreshClaudeCodeOAuthToken,
  stampClaudeCodeCch,
} from "../src";

function createTestClaudeCodeProvider(
  options: Parameters<typeof createClaudeCodeProvider>[0] = {},
) {
  return createClaudeCodeProvider({
    allowLiveMessages: true,
    ...options,
  });
}

async function withSuspendedFable<T>(callback: () => Promise<T>): Promise<T> {
  const previous = process.env.KYOLI_SUSPENDED_CLAUDE_CODE_FAMILIES;
  process.env.KYOLI_SUSPENDED_CLAUDE_CODE_FAMILIES = "fable";
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.KYOLI_SUSPENDED_CLAUDE_CODE_FAMILIES;
    } else {
      process.env.KYOLI_SUSPENDED_CLAUDE_CODE_FAMILIES = previous;
    }
  }
}

describe("OpenCode shared Claude Code helpers", () => {
  it("exposes provider-owned profile defaults without gateway dependencies", () => {
    const profile = loadClaudeCodeSharedRequestProfile();

    expect(profile.baseUrl).toBe("https://api.anthropic.com");
    expect(profile.apiV1BaseUrl).toBe("https://api.anthropic.com/v1");
    expect(profile.anthropicBeta).toContain("oauth-");
    expect(profile.userAgent).toMatch(/^claude-cli\//);
  });

  it("orders headers with the Claude Code template order", () => {
    const ordered = orderClaudeCodeHeadersForOutbound(
      {
        "x-later": "3",
        "user-agent": "ua",
        "accept": "application/json",
      },
      ["user-agent", "accept"],
    );

    expect(ordered).toEqual([
      ["user-agent", "ua"],
      ["accept", "application/json"],
      ["x-later", "3"],
    ]);
  });

  it("builds static and per-request headers for OpenCode native plugins", () => {
    const staticHeaders = createClaudeCodeStaticHeaders({
      headerValues: { "user-agent": "template-ua", "x-extra": "yes" },
      userAgent: "profile-ua",
      xApp: "cli",
    });
    const requestHeaders = createClaudeCodePerRequestHeaders({
      anthropicVersion: "2024-10-22",
      sessionId: "session-123",
    });

    expect(staticHeaders["user-agent"]).toBe("template-ua");
    expect(staticHeaders["x-extra"]).toBe("yes");
    expect(staticHeaders["x-stainless-runtime"]).toBe("node");
    expect(requestHeaders["x-claude-code-session-id"]).toBe("session-123");
    expect(requestHeaders["anthropic-version"]).toBe("2024-10-22");
    expect(requestHeaders["x-stainless-timeout"]).toBe("300");
  });

  it("shares Claude Code billing build tag calculation", () => {
    const tag = computeClaudeCodeBuildTag("hello reviewer", "2.1.137");

    expect(tag).toMatch(/^[0-9a-f]{3}$/);
    expect(composeClaudeCodeBillingSystemEntry("hello reviewer", "2.1.137")).toBe(
      `x-anthropic-billing-header: cc_version=2.1.137.${tag}; cc_entrypoint=sdk-cli; cch=00000;`,
    );

    const tagWithoutCch = computeClaudeCodeBuildTag("hello reviewer", "2.1.183");
    expect(composeClaudeCodeBillingSystemEntry("hello reviewer", "2.1.183")).toBe(
      `x-anthropic-billing-header: cc_version=2.1.183.${tagWithoutCch}; cc_entrypoint=sdk-cli;`,
    );
  });

  it("stamps deterministic cch only for verified Claude Code seeds", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-8",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "earlier log line said cc_entrypoint=sdk-cli; cch=dead1;" },
          { type: "text", text: "hello stream", cache_control: { type: "ephemeral" } },
        ],
      }],
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.177.dd9; cc_entrypoint=sdk-cli; cch=a82da;" },
        { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: "ephemeral" } },
        { type: "text", text: "CWD: /tmp\nDate: 2026-06-16", cache_control: { type: "ephemeral" } },
      ],
      tools: [],
      metadata: {
        user_id: JSON.stringify({
          device_id: "2310428a2ab526a3f57d940cbb0e3ab42f64116b322a8c26b56498cd4a2ee69d",
          account_uuid: "",
          session_id: "00000000-0000-4000-8000-000000000000",
        }),
      },
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
      output_config: { effort: "max" },
      stream: true,
    });

    const stamped = stampClaudeCodeCch(body.replace("cch=a82da", "cch=00000"), "2.1.177");
    expect(cchForBody(body, "2.1.177")).toBe("69681");
    expect(stamped).toContain("cc_entrypoint=sdk-cli; cch=69681;");
    expect(stamped).toContain("earlier log line said cc_entrypoint=sdk-cli; cch=dead1;");
    expect(stampClaudeCodeCch(body.replace("cch=a82da", "cch=00000"), "2.1.178")).toContain(
      "cc_entrypoint=sdk-cli; cch=69681;",
    );

    const unknownVersionBody = body.replace("cc_version=2.1.177.dd9", "cc_version=2.1.178.dd9");
    expect(stampClaudeCodeCch(unknownVersionBody)).toBe(unknownVersionBody);
  });

  it("classifies non-subscription Claude Code billing claims conservatively", () => {
    expect(isClaudeCodeNonSubscriptionBillingClaim("five_hour")).toBe(false);
    expect(isClaudeCodeNonSubscriptionBillingClaim("seven_day_sonnet")).toBe(false);
    expect(isClaudeCodeNonSubscriptionBillingClaim("unknown")).toBe(false);
    expect(isClaudeCodeNonSubscriptionBillingClaim("workspace")).toBe(false);
    expect(isClaudeCodeNonSubscriptionBillingClaim("api")).toBe(true);
    expect(isClaudeCodeNonSubscriptionBillingClaim("overage")).toBe(true);
    expect(isClaudeCodeNonSubscriptionBillingClaim("sdk_credit")).toBe(true);
    expect(isClaudeCodeNonSubscriptionBillingClaim("future_credit_bucket")).toBe(true);
  });

  it("applies shared Claude Code body fields", () => {
    const body = applyClaudeCodeUpstreamBodyFields(
      {
        messages: [{ role: "user", content: "hello shared body" }],
        system: ["local reminder"],
      },
      {
        agentIdentity: "agent identity",
        bodyFieldOrder: ["messages", "system", "metadata", "tools"],
        ccVersion: "2.1.137",
        defaultTools: [{ name: "Bash", input_schema: { type: "object" } }],
        identity: { accountUuid: "account-1", deviceId: "device-1" },
        sessionId: "session-1",
        systemPrompt: "system prompt",
      },
    );

    const system = body.system as Array<{ text: string }>;
    const metadata = body.metadata as { user_id: string };
    expect(Object.keys(body).slice(0, 4)).toEqual(["messages", "system", "metadata", "tools"]);
    expect(system.map((entry) => entry.text)).toEqual([
      expect.stringContaining("x-anthropic-billing-header:"),
      "agent identity",
      `system prompt${CLIENT_SYSTEM_PREFACE}local reminder`,
    ]);
    expect(JSON.parse(metadata.user_id)).toEqual({
      account_uuid: "account-1",
      device_id: "device-1",
      session_id: "session-1",
    });
    expect(body.tools).toEqual([
      {
        name: "Bash",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("frames client system text as task-specific instructions", () => {
    expect(CLIENT_SYSTEM_PREFACE).toContain("security");
    expect(CLIENT_SYSTEM_PREFACE).toContain("cannot be overridden");

    const body = applyClaudeCodeUpstreamBodyFields(
      {
        messages: [{ role: "user", content: "hello shared body" }],
        system: [
          { type: "text", text: "First client instruction." },
          { type: "text", text: "Second client instruction." },
        ],
      },
      {
        agentIdentity: "agent identity",
        ccVersion: "2.1.137",
        identity: { accountUuid: "account-1", deviceId: "device-1" },
        sessionId: "session-1",
        systemPrompt: "system prompt",
      },
    );

    const systemText = (body.system as Array<{ text: string }>)[2]?.text ?? "";
    expect(systemText).toContain(CLIENT_SYSTEM_PREFACE);
    expect(systemText.indexOf(CLIENT_SYSTEM_PREFACE)).toBeGreaterThan(
      systemText.indexOf("system prompt"),
    );
    expect(systemText.indexOf("First client instruction.")).toBeGreaterThan(
      systemText.indexOf(CLIENT_SYSTEM_PREFACE),
    );
    expect(systemText).toContain("First client instruction.\n\nSecond client instruction.");
  });

  it("does not add the client-system preface without client system text", () => {
    const body = applyClaudeCodeUpstreamBodyFields(
      {
        messages: [{ role: "user", content: "hello shared body" }],
      },
      {
        agentIdentity: "agent identity",
        ccVersion: "2.1.137",
        identity: { accountUuid: "account-1", deviceId: "device-1" },
        sessionId: "session-1",
        systemPrompt: "system prompt",
      },
    );

    const systemText = (body.system as Array<{ text: string }>)[2]?.text ?? "";
    expect(systemText).toBe("system prompt");
    expect(systemText).not.toContain(CLIENT_SYSTEM_PREFACE);
  });

  it("adds Claude Code prompt cache breakpoints to tools and block-array messages", () => {
    const body = applyClaudeCodeUpstreamBodyFields(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
          { role: "assistant", content: [{ type: "text", text: "answer" }] },
        ],
        tools: [
          { name: "Read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
          { name: "Write", input_schema: { type: "object" } },
        ],
      },
      {
        agentIdentity: "agent identity",
        ccVersion: "2.1.137",
        identity: { accountUuid: "account-1", deviceId: "device-1" },
        sessionId: "session-1",
        systemPrompt: "system prompt",
      },
    );

    const tools = body.tools as Array<{ cache_control?: { type: string } }>;
    const messages = body.messages as Array<{ content: Array<{ cache_control?: { type: string } }> }>;

    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(messages[0]?.content[0]?.cache_control).toBeUndefined();
    expect(messages[1]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("createClaudeCodeProvider", () => {
  it("does not advertise suspended Fable models", async () => {
    await withSuspendedFable(async () => {
      const provider = createTestClaudeCodeProvider();

      await expect(provider.listModels()).resolves.not.toContainEqual(
        expect.objectContaining({ upstreamId: expect.stringContaining("fable") }),
      );
    });
  });

  it("keeps arbitrary Claude per-model usage buckets from OAuth usage refresh", async () => {
    const metadata = await refreshClaudeCodeAccountMetadata("access-test", {
      fetch: async (input) => {
        if (String(input).includes("/profile")) {
          return new Response(JSON.stringify({ account: { email: "user@example.com", has_claude_max: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          five_hour: { utilization: 12, resets_at: null },
          seven_day_opus: { utilization: 88, resets_at: "2026-05-21T00:00:00.000Z" },
          seven_day_haiku: { utilization: 34, resets_at: null },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(metadata.planTier).toBe("max");
    expect((metadata.cachedUsage as { seven_day_opus?: { utilization: number } }).seven_day_opus?.utilization)
      .toBe(88);
    expect((metadata.cachedUsage as { seven_day_haiku?: { utilization: number } }).seven_day_haiku?.utilization)
      .toBe(34);
  });

  it("proxies /v1/messages with Claude Code OAuth headers", async () => {
    let upstreamUrl = "";
    let upstreamBody: unknown;
    let upstreamAuth = "";
    let upstreamVersion = "";
    let upstreamBrowserAccess = "";
    let upstreamUserAgent = "";
    let upstreamXApp = "";
    let upstreamBeta = "";
    let upstreamSessionId = "";
    let upstreamClientRequestId = "";
    let upstreamTimeout = "";

    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        upstreamUrl = String(input);
        upstreamBody = JSON.parse(String(init?.body));
        upstreamAuth = headers.get("authorization") ?? "";
        upstreamVersion = headers.get("anthropic-version") ?? "";
        upstreamBrowserAccess =
          headers.get("anthropic-dangerous-direct-browser-access") ?? "";
        upstreamUserAgent = headers.get("user-agent") ?? "";
        upstreamXApp = headers.get("x-app") ?? "";
        upstreamBeta = headers.get("anthropic-beta") ?? "";
        upstreamSessionId = headers.get("x-claude-code-session-id") ?? "";
        upstreamClientRequestId = headers.get("x-client-request-id") ?? "";
        upstreamTimeout = headers.get("x-stainless-timeout") ?? "";

        return new Response(JSON.stringify({ id: "msg_test", type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-a",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "msg_test", type: "message" });
    expect(upstreamUrl).toBe("https://example.test/v1/messages?beta=true");
    expect(upstreamAuth).toBe("Bearer access-test");
    expect(upstreamVersion).toBe("2023-06-01");
    expect(upstreamBrowserAccess).toBe("true");
    expect(upstreamUserAgent).toBe(getClaudeCodeTemplateMetadata().headerValues["user-agent"]);
    expect(upstreamXApp).toBe("cli");
    expect(upstreamBeta).toContain("claude-code-20250219");
    expect(upstreamBeta).toContain("oauth-2025-04-20");
    expect(upstreamSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(upstreamClientRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(upstreamTimeout).toBe("600");
    expect(upstreamBody).toMatchObject({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(Object.keys(upstreamBody as Record<string, unknown>).slice(0, 6)).toEqual([
      "model",
      "messages",
      "system",
      "tools",
      "metadata",
      "max_tokens",
    ]);
    expect((upstreamBody as { system: unknown[] }).system).toHaveLength(3);
    const systemText = (upstreamBody as { system: Array<{ text: string }> }).system[2]?.text ?? "";
    expect(systemText).toBe(getClaudeCodeTemplateMetadata().systemPrompt);
    expect(systemText.length).toBeGreaterThan(6_000);
    expect((upstreamBody as { tools: Array<{ name: string; input_schema?: unknown }> }).tools).toHaveLength(
      getClaudeCodeTemplateMetadata().toolNames.length,
    );
    expect((upstreamBody as { tools: Array<{ name: string; input_schema?: unknown }> }).tools[0]).toMatchObject({
      name: "Agent",
    });
    expect((upstreamBody as { tools: Array<{ name: string; input_schema?: unknown }> }).tools.every((tool) => tool.input_schema)).toBe(true);
    const billingText = (upstreamBody as { system: Array<{ text: string }> }).system[0]?.text ?? "";
    expect(billingText).toContain("x-anthropic-billing-header:");
    const escapedVersion = getClaudeCodeTemplateMetadata().ccVersion?.replace(/\./g, "\\.");
    expect(billingText).toMatch(new RegExp(`cc_version=${escapedVersion}\\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;(?: cch=[0-9a-f]{5};)?`));
    const userId = JSON.parse((upstreamBody as { metadata: { user_id: string } }).metadata.user_id) as {
      account_uuid?: string;
      device_id?: string;
      session_id?: string;
    };
    expect(userId.account_uuid).toBeTruthy();
    expect(userId.device_id).toBeTruthy();
    expect(userId.session_id).toBe(upstreamSessionId);
  });



  it("rejects suspended Fable aliases before upstream routing", async () => {
    await withSuspendedFable(async () => {
      const provider = createTestClaudeCodeProvider({
        baseUrl: "https://example.test",
        fetch: async () => {
          throw new Error("suspended Fable requests should not reach upstream");
        },
      });

      const response = await provider.handleRequest({
        request: new Request("http://127.0.0.1:2021/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "fable1m",
            max_tokens: 1024,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
        route: "/v1/messages",
        sessionKey: "session-fable",
        body: {
          model: "fable1m",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        },
        model: "fable1m",
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          type: "model_temporarily_unavailable",
          message: expect.stringContaining("Claude Fable 5 is temporarily unavailable"),
        },
      });
    });
  });

  it("uses Claude Code identity device id while keeping the selected account UUID", async () => {
    let upstreamBody: {
      metadata?: {
        user_id?: string;
      };
    } = {};

    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        accountId: "credential-account",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
      metadata: {
        accountId: "metadata-account",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      identity: {
        accountUuid: "local-account",
        deviceId: "device-real",
      },
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "msg_test", type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-identity",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    const userId = JSON.parse(upstreamBody.metadata?.user_id ?? "{}") as {
      account_uuid?: string;
      device_id?: string;
    };
    expect(response.status).toBe(200);
    expect(userId.device_id).toBe("device-real");
    expect(userId.account_uuid).toBe("metadata-account");
  });

  it("filters caller-supplied Claude Code fingerprint headers by default", async () => {
    let upstreamHeaders = new Headers();
    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        upstreamHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ id: "msg_test", type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-beta": "extended-cache-ttl-2025-04-11,caller-beta",
          "anthropic-version": "caller-version",
          "content-type": "application/json",
          "user-agent": "not-claude-code",
          "x-app": "not-cli",
          "x-client-request-id": "caller-request-id",
          "x-stainless-runtime": "browser",
          "x-stainless-timeout": "999",
        },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-filter",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    expect(response.status).toBe(200);
    expect(upstreamHeaders.get("user-agent")).toBe(getClaudeCodeTemplateMetadata().headerValues["user-agent"]);
    expect(upstreamHeaders.get("x-app")).toBe("cli");
    expect(upstreamHeaders.get("anthropic-version")).toBe("2023-06-01");
    expect(upstreamHeaders.get("anthropic-beta")).toContain("claude-code-20250219");
    expect(upstreamHeaders.get("anthropic-beta")).not.toContain("caller-beta");
    expect(upstreamHeaders.get("anthropic-beta")).not.toContain("extended-cache-ttl-2025-04-11");
    expect(upstreamHeaders.get("x-client-request-id")).not.toBe("caller-request-id");
    expect(upstreamHeaders.get("x-stainless-runtime")).toBe("node");
    expect(upstreamHeaders.get("x-stainless-timeout")).toBe("600");
  });

  it("can trust caller fingerprint headers when explicitly enabled", async () => {
    let upstreamHeaders = new Headers();
    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      trustClientFingerprint: true,
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        upstreamHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ id: "msg_test", type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-beta": "caller-beta,extended-cache-ttl-2025-04-11",
          "content-type": "application/json",
          "user-agent": "claude-cli/custom",
          "x-client-request-id": "caller-request-id",
        },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-trust",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    expect(response.status).toBe(200);
    expect(upstreamHeaders.get("user-agent")).toBe("claude-cli/custom");
    expect(upstreamHeaders.get("x-client-request-id")).toBe("caller-request-id");
    expect(upstreamHeaders.get("anthropic-beta")).toContain("caller-beta");
    expect(upstreamHeaders.get("anthropic-beta")).not.toContain("extended-cache-ttl-2025-04-11");
  });

  it("refreshes expired OAuth credentials before proxying", async () => {
    let upstreamAuth = "";
    let refreshTokenSeen = "";
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "expired-access",
        expiresAt: Date.now() - 1000,
        refreshToken: "refresh-old",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      tokenRefresh: async (refreshToken) => {
        refreshTokenSeen = refreshToken;
        return {
          accessToken: "fresh-access",
          refreshToken: "refresh-new",
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
      },
      fetch: async (_input, init) => {
        upstreamAuth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify({ id: "msg_test", type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-a",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    const updated = await store.get(account.id);
    expect(response.status).toBe(200);
    expect(refreshTokenSeen).toBe("refresh-old");
    expect(upstreamAuth).toBe("Bearer fresh-access");
    expect(updated?.credentials.accessToken).toBe("fresh-access");
    expect(updated?.credentials.refreshToken).toBe("refresh-new");
  });

  it("exposes usage refresh metadata through the provider capability", async () => {
    const store = new MemoryAccountStore();
    const account = await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
      metadata: {
        planTier: "pro",
        cachedUsageAt: Date.now() - 60 * 60 * 1000,
        cachedUsage: {
          five_hour: { utilization: 90, resets_at: null },
        },
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async (accessToken) => {
        expect(accessToken).toBe("access-test");
        return {
          planTier: "max",
          cachedUsageAt: Date.now(),
          cachedUsage: {
            five_hour: { utilization: 15, resets_at: null },
            seven_day: { utilization: 25, resets_at: null },
          },
        };
      },
    });

    const refreshed = await provider.refreshUsage?.({ account });

    expect(refreshed?.ok).toBe(true);
    expect(refreshed?.metadata?.planTier).toBe("max");
    expect((refreshed?.metadata?.cachedUsage as { five_hour?: { utilization: number } }).five_hour?.utilization).toBe(15);
  });

  it("fails over after upstream rate limits an OAuth account", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    const second = await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });
    const upstreamAuths: string[] = [];

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        upstreamAuths.push(authorization);

        if (authorization === "Bearer first-access") {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: {
              "anthropic-ratelimit-unified-5h-utilization": "0.92",
              "anthropic-ratelimit-unified-7d-utilization": "0.34",
              "anthropic-ratelimit-unified-7d_sonnet-utilization": "0.71",
              "anthropic-ratelimit-unified-representative-claim": "five_hour",
              "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600),
              "anthropic-ratelimit-unified-status": "rejected",
              "content-type": "application/json",
              "retry-after": "60",
            },
          });
        }

        return new Response(JSON.stringify({ id: "msg_second", type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-a",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    const firstUpdated = await store.get(first.id);
    const secondUpdated = await store.get(second.id);
    expect(response.status).toBe(200);
    expect(upstreamAuths).toEqual(["Bearer first-access", "Bearer second-access"]);
    expect(firstUpdated?.failureCount).toBe(1);
    expect(firstUpdated?.rateLimitResetAt).toBeTruthy();
    expect(firstUpdated?.metadata.rateLimitClaim).toBe("five_hour");
    expect(firstUpdated?.metadata.rateLimitStatus).toBe("rejected");
    expect((firstUpdated?.metadata.cachedUsage as { five_hour?: { utilization: number } }).five_hour?.utilization).toBe(0.92);
    expect((firstUpdated?.metadata.cachedUsage as { seven_day_sonnet?: { utilization: number } }).seven_day_sonnet?.utilization).toBe(0.71);
    expect(secondUpdated?.lastUsedAt).toBeTruthy();
  });

  it("fails over when a Claude stream starts with a rate limit error", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    const second = await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });
    const upstreamAuths: string[] = [];

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        upstreamAuths.push(authorization);

        if (authorization === "Bearer first-access") {
          return new Response(
            [
              "event: error",
              'data: {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}',
              "",
              "",
            ].join("\n"),
            {
              status: 200,
              headers: {
                "anthropic-ratelimit-unified-representative-claim": "five_hour",
                "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600),
                "anthropic-ratelimit-unified-status": "rejected",
                "content-type": "text/event-stream",
                "retry-after": "60",
              },
            },
          );
        }

        return new Response(JSON.stringify({ id: "msg_second", type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-a",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    const firstUpdated = await store.get(first.id);
    const secondUpdated = await store.get(second.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "msg_second" });
    expect(upstreamAuths).toEqual(["Bearer first-access", "Bearer second-access"]);
    expect(firstUpdated?.failureCount).toBe(1);
    expect(firstUpdated?.rateLimitResetAt).toBeTruthy();
    expect(firstUpdated?.metadata.rateLimitClaim).toBe("five_hour");
    expect(firstUpdated?.metadata.rateLimitStatus).toBe("rejected");
    expect(secondUpdated?.lastUsedAt).toBeTruthy();
  });

  it("blocks and fails over when a Claude response bills outside subscription claims", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    const second = await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });
    const upstreamAuths: string[] = [];

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        upstreamAuths.push(authorization);

        if (authorization === "Bearer first-access") {
          return new Response(
            [
              "event: message_start",
              'data: {"type":"message_start","message":{"id":"msg_billed","type":"message"}}',
              "",
              "",
            ].join("\n"),
            {
              status: 200,
              headers: {
                "anthropic-ratelimit-unified-representative-claim": "api",
                "anthropic-ratelimit-unified-status": "accepted",
                "content-type": "text/event-stream",
              },
            },
          );
        }

        return new Response(JSON.stringify({ id: "msg_second", type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-non-sub-billing",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    const firstUpdated = await store.get(first.id);
    const secondUpdated = await store.get(second.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "msg_second" });
    expect(upstreamAuths).toEqual(["Bearer first-access", "Bearer second-access"]);
    expect(firstUpdated?.failureCount).toBe(1);
    expect(firstUpdated?.lastFailureClass).toBe("quota");
    expect(firstUpdated?.lastFailureCode).toBe("non_subscription_billing_claim");
    expect(firstUpdated?.metadata.rateLimitClaim).toBe("api");
    expect(firstUpdated?.rateLimitBlockedAt).toBeTruthy();
    expect(secondUpdated?.lastUsedAt).toBeTruthy();
  });

  it("does not synthesize Claude reset timestamps from startup rate-limit messages", async () => {
    const store = new MemoryAccountStore();
    const first = await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        if (authorization === "Bearer first-access") {
          return new Response([
            "event: error",
            'data: {"type":"error","error":{"type":"rate_limit_error","message":"rate limited; try again later"}}',
            "",
            "",
          ].join("\n"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(JSON.stringify({ id: "msg_second", type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-a",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    const firstUpdated = await store.get(first.id);
    expect(response.status).toBe(200);
    expect(firstUpdated?.lastFailureClass).toBe("rate_limit");
    expect(firstUpdated?.rateLimitResetAt).toBeUndefined();
    expect(firstUpdated?.rateLimitBlockedAt).toBeTruthy();
  });

  it("does not fail over after a Claude stream has become visible downstream", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-first",
      },
    });
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-second",
      },
    });
    const upstreamAuths: string[] = [];

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        upstreamAuths.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response(
          [
            "event: message_start",
            'data: {"type":"message_start","message":{"id":"msg_first","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
            "",
            "event: error",
            'data: {"type":"error","error":{"type":"rate_limit_error","message":"rate limited mid-stream"}}',
            "",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-a",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    const text = await response.text();
    expect(response.status).toBe(200);
    expect(upstreamAuths).toEqual(["Bearer first-access"]);
    expect(text).toContain("message_start");
    expect(text).toContain("rate limited mid-stream");
  });

  it("enriches exhausted Claude Code 429 responses with rate limit header details", async () => {
    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "only-access",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-only",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      maxAccountAttempts: 2,
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "Error" } }), {
          status: 429,
          headers: {
            "anthropic-ratelimit-unified-5h-utilization": "0.98",
            "anthropic-ratelimit-unified-7d-utilization": "0.42",
            "anthropic-ratelimit-unified-representative-claim": "five_hour",
            "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600),
            "anthropic-ratelimit-unified-status": "rejected",
            "content-type": "application/json",
          },
        }),
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-rate-limit",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    const payload = await response.json() as { error?: { message?: string } };
    expect(response.status).toBe(429);
    expect(payload.error?.message).toContain("Limiting window: five_hour");
    expect(payload.error?.message).toContain("5h utilization: 98%");
  });

  it("returns 401 when no OAuth account is available", async () => {
    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(new MemoryAccountStore()),
      fetch: async () => new Response(null, { status: 500 }),
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-a",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    expect(response.status).toBe(401);
  });

  it("blocks live /v1/messages generation unless explicitly enabled", async () => {
    const provider = createClaudeCodeProvider({
      accounts: new StickyAccountPool(new MemoryAccountStore()),
      fetch: async () => new Response(null, { status: 500 }),
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-live-blocked",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    const payload = await response.json() as { error?: { type?: string } };
    expect(response.status).toBe(403);
    expect(payload.error?.type).toBe("claude_live_messages_disabled");
  });

  it("masks custom tool names upstream and reverses response tool names", async () => {
    let upstreamToolName = "";
    let upstreamToolChoice = "";

    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        const parsed = JSON.parse(String(init?.body)) as {
          tools: Array<{ name: string }>;
          tool_choice: { name: string };
        };
        upstreamToolName = parsed.tools[0]?.name ?? "";
        upstreamToolChoice = parsed.tool_choice.name;

        return new Response(
          JSON.stringify({
            type: "message",
            content: [
              {
                type: "tool_use",
                id: "toolu_test",
                name: upstreamToolName,
                input: {},
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const response = await provider.handleRequest({
      request: new Request("http://127.0.0.1:2021/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-code/claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "use it" }],
          tools: [{ name: "browser.open", input_schema: { type: "object" } }],
          tool_choice: { type: "tool", name: "browser.open" },
        }),
      }),
      route: "/v1/messages",
      sessionKey: "session-tools",
      body: {
        model: "claude-code/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "use it" }],
        tools: [{ name: "browser.open", input_schema: { type: "object" } }],
        tool_choice: { type: "tool", name: "browser.open" },
      },
      model: "claude-code/claude-sonnet-4-5",
    });

    const payload = (await response.json()) as {
      content: Array<{ type: string; name: string }>;
    };
    expect(upstreamToolName.startsWith("tool_")).toBe(true);
    expect(upstreamToolChoice).toBe(upstreamToolName);
    expect(payload.content[0]?.name).toBe("browser.open");
  });

  it("retries without rejected beta flags and caches them for the account", async () => {
    const betas: string[] = [];
    const retryCounts: string[] = [];
    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        betas.push(headers.get("anthropic-beta") ?? "");
        retryCounts.push(headers.get("x-stainless-retry-count") ?? "");
        if (betas.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "Unexpected value(s) `advisor-tool-2026-03-01` for the `anthropic-beta` header",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ id: `msg_${betas.length}`, type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const context = createMessagesContext("session-beta");
    const first = await provider.handleRequest(context);
    const second = await provider.handleRequest(createMessagesContext("session-beta-2"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(betas).toHaveLength(3);
    expect(betas[0]).toContain("advisor-tool-2026-03-01");
    expect(betas[1]).not.toContain("advisor-tool-2026-03-01");
    expect(betas[2]).not.toContain("advisor-tool-2026-03-01");
    expect(retryCounts).toEqual(["0", "1", "0"]);
  });

  it("retries hard effort-capability 400s and caches the supported level", async () => {
    const efforts: string[] = [];
    const retryCounts: string[] = [];
    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      allowLiveMessages: true,
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { output_config?: { effort?: string } };
        const headers = new Headers(init?.headers);
        efforts.push(body.output_config?.effort ?? "");
        retryCounts.push(headers.get("x-stainless-retry-count") ?? "");
        if (efforts.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                message: "This model does not support effort level 'max'. Supported levels: high, low, medium.",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ id: `msg_${efforts.length}`, type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const firstContext = createMessagesContext(
      "session-effort",
      "anthropic/claude-opus-4-5-20251101",
    ) as ReturnType<typeof createMessagesContext> & { body: Record<string, unknown> };
    firstContext.body.output_config = { effort: "max" };
    const first = await provider.handleRequest(firstContext);

    const secondContext = createMessagesContext(
      "session-effort-2",
      "anthropic/claude-opus-4-5-20251101",
    ) as ReturnType<typeof createMessagesContext> & { body: Record<string, unknown> };
    secondContext.body.output_config = { effort: "max" };
    const second = await provider.handleRequest(secondContext);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(efforts).toEqual(["max", "high", "high"]);
    expect(retryCounts).toEqual(["0", "1", "0"]);
  });

  it("retries without long-context betas after subscription errors", async () => {
    const betas: string[] = [];
    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        const beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
        betas.push(beta);
        if (betas.length === 1) {
          return new Response(JSON.stringify({ error: { message: "long context beta is not yet available" } }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: "msg_retry", type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await provider.handleRequest(
      createMessagesContext("session-context-haiku", "anthropic/claude-haiku-4-5"),
    );

    expect(response.status).toBe(200);
    expect(betas).toHaveLength(2);
    expect(betas[0]).toContain("context-1m-2025-08-07");
    expect(betas[0]).toContain("context-management-2025-06-27");
    expect(betas[1]).not.toContain("context-1m-2025-08-07");
    expect(betas[1]).not.toContain("context-management-2025-06-27");
  });

  it("can rotate Claude Code session IDs by max age", async () => {
    const sessionIds: string[] = [];
    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      sessionRotation: { maxAgeMs: 1 },
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async (_input, init) => {
        sessionIds.push(new Headers(init?.headers).get("x-claude-code-session-id") ?? "");
        return new Response(JSON.stringify({ id: "msg_test", type: "message" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await provider.handleRequest(createMessagesContext("session-rotate"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await provider.handleRequest(createMessagesContext("session-rotate"));

    expect(sessionIds).toHaveLength(2);
    expect(sessionIds[0]).toBeTruthy();
    expect(sessionIds[1]).toBeTruthy();
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
  });

  it("can pace outbound Claude Code requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T00:00:00.000Z"));

    try {
      const startedAt: number[] = [];
      const store = new MemoryAccountStore();
      await store.create({
        provider: "claude-code",
        kind: "oauth",
        credentials: {
          accessToken: "access-test",
          expiresAt: Date.now() + 60 * 60 * 1000,
          refreshToken: "refresh-test",
        },
      });

      const provider = createTestClaudeCodeProvider({
        accounts: new StickyAccountPool(store),
        baseUrl: "https://example.test",
        pacing: { minGapMs: 20 },
        usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
        fetch: async () => {
          startedAt.push(Date.now());
          return new Response(JSON.stringify({ id: "msg_test", type: "message" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      await provider.handleRequest(createMessagesContext("session-pace-1"));
      const paced = provider.handleRequest(createMessagesContext("session-pace-2"));
      await vi.advanceTimersByTimeAsync(20);
      await paced;

      expect(startedAt).toHaveLength(2);
      expect(startedAt[1]! - startedAt[0]!).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains streaming upstream responses instead of cancelling when enabled", async () => {
    let upstreamCancelled = false;
    let pulls = 0;
    const store = new MemoryAccountStore();
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      credentials: {
        accessToken: "access-test",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "refresh-test",
      },
    });

    const provider = createTestClaudeCodeProvider({
      accounts: new StickyAccountPool(store),
      baseUrl: "https://example.test",
      drainOnCancel: true,
      usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(new TextEncoder().encode('data: {"type":"ping"}\n\n'));
                return;
              }
              controller.close();
            },
            cancel() {
              upstreamCancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });

    const response = await provider.handleRequest(createMessagesContext("session-drain"));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upstreamCancelled).toBe(false);
    expect(pulls).toBeGreaterThanOrEqual(2);
  });

  it("checks Claude Code template drift through a loopback CLI capture", async () => {
    const previousPath = process.env.KYOLI_CLAUDE_CODE_PATH;
    const tempDir = await mkdtemp(join(tmpdir(), "kyoli-claude-template-"));
    const fakeClaudePath = join(tempDir, "claude.mjs");
    const metadata = getClaudeCodeTemplateMetadata();
    const interactiveOnlyTools = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]);
    const tools = getClaudeCodeTemplateTools()
      .filter((tool) => !interactiveOnlyTools.has(tool.name));
    const capturedSystemPrompt = (metadata.systemPrompt ?? "").replaceAll(
      "/.claude/projects/project/memory/",
      "/.claude/projects/-tmp-example-repo/memory/",
    );

    await writeFile(
      fakeClaudePath,
      `
import net from "node:net";

const baseUrl = new URL(process.env.ANTHROPIC_BASE_URL);
const body = {
  model: "claude-sonnet-4-5",
  messages: [{ role: "user", content: "hi" }],
  system: [
    { type: "text", text: "x-anthropic-billing-header: cc_version=${metadata.ccVersion}.abc; cc_entrypoint=sdk-cli; cch=abc12;" },
    { type: "text", text: ${JSON.stringify(metadata.agentIdentity)} },
    { type: "text", text: ${JSON.stringify(capturedSystemPrompt)} }
  ],
  tools: ${JSON.stringify(tools)},
  metadata: { user_id: "{}" },
  max_tokens: 1024,
  thinking: null,
  context_management: null,
  output_config: null,
  stream: true
};
const bodyText = JSON.stringify(body);
const headers = [
  ["Accept", "application/json"],
  ["Authorization", "Bearer fake"],
  ["Content-Type", "application/json"],
  ["User-Agent", ${JSON.stringify(metadata.headerValues["user-agent"])}],
  ["X-Claude-Code-Session-Id", "00000000-0000-4000-8000-000000000000"],
  ["X-Stainless-Arch", "arm64"],
  ["X-Stainless-Lang", "js"],
  ["X-Stainless-OS", "MacOS"],
  ["X-Stainless-Package-Version", "0.81.0"],
  ["X-Stainless-Retry-Count", "0"],
  ["X-Stainless-Runtime", "node"],
  ["X-Stainless-Runtime-Version", "v22.0.0"],
  ["X-Stainless-Timeout", ${JSON.stringify(metadata.headerValues["x-stainless-timeout"])}],
  ["anthropic-beta", ${JSON.stringify(metadata.anthropicBeta)}],
  ["anthropic-dangerous-direct-browser-access", ${JSON.stringify(metadata.headerValues["anthropic-dangerous-direct-browser-access"])}],
  ["anthropic-version", ${JSON.stringify(metadata.headerValues["anthropic-version"])}],
  ["x-app", ${JSON.stringify(metadata.headerValues["x-app"])}],
  ["Connection", "close"],
  ["Host", baseUrl.host],
  ["Accept-Encoding", "gzip, deflate"],
  ["Content-Length", String(Buffer.byteLength(bodyText))]
];
const request = [
  "POST /v1/messages HTTP/1.1",
  ...headers.map(([key, value]) => key + ": " + value),
  "",
  bodyText
].join("\\r\\n");
const socket = net.connect(Number(baseUrl.port), baseUrl.hostname, () => socket.end(request));
socket.resume();
await new Promise((resolve) => socket.on("close", resolve));
`,
      "utf8",
    );

    process.env.KYOLI_CLAUDE_CODE_PATH = fakeClaudePath;
    try {
      const report = await checkClaudeCodeTemplateDrift({ timeoutMs: 2_000 });
      expect(report.captured).toBe(true);
      expect(report.drifted).toBe(false);
      expect(report.checks.every((check) => check.ok)).toBe(true);
      expect(report.checks.find((check) => check.name === "tool names")?.detail)
        .toContain("interactive-only bundled tool(s) allowed outside headless capture");
    } finally {
      if (previousPath === undefined) {
        delete process.env.KYOLI_CLAUDE_CODE_PATH;
      } else {
        process.env.KYOLI_CLAUDE_CODE_PATH = previousPath;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refreshes tokens through the Claude Code OAuth token endpoint", async () => {
    let requestUrl = "";
    let requestBody = "";
    let requestContentType = "";

    const refreshed = await refreshClaudeCodeOAuthToken("refresh-old", {
      config: {
        clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        authorizeUrl: "https://claude.ai/oauth/authorize",
        tokenUrl: "https://token.example/oauth/token",
        scopes: "user:profile user:inference user:sessions:claude_code",
        baseApiUrl: "https://api.anthropic.com",
        source: "fallback",
      },
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestBody = String(init?.body);
        requestContentType = new Headers(init?.headers).get("content-type") ?? "";

        return new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "refresh-new",
            expires_in: 3600,
            account: {
              uuid: "account-1",
              email_address: "user@example.test",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    expect(refreshed.accessToken).toBe("fresh-access");
    expect(refreshed.refreshToken).toBe("refresh-new");
    expect(refreshed.accountId).toBe("account-1");
    expect(refreshed.email).toBe("user@example.test");
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
    expect(requestUrl).toBe("https://token.example/oauth/token");
    expect(requestContentType).toBe("application/x-www-form-urlencoded");
    expect(requestBody).toContain("grant_type=refresh_token");
    expect(requestBody).toContain("refresh_token=refresh-old");
  });
});

function createMessagesContext(sessionKey: string, model = "claude-code/claude-sonnet-4-5") {
  return {
    request: new Request("http://127.0.0.1:2021/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
    route: "/v1/messages" as const,
    sessionKey,
    body: {
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    },
    model,
  };
}
