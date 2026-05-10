import { afterEach, describe, expect, it } from "vitest";
import { MemoryAccountStore } from "@kyoli-gam/core";
import {
  createCodexCliE2EArgs,
  createOpenCodeE2EConfig,
  runCodexE2EDoctor,
  runCodexFileSmokeDoctor,
  runCodexLoadDoctor,
  runCodexSmokeDoctor,
  selectDefaultCodexModel,
} from "../src/codex-smoke";

const originalDisableModelsFetch = process.env.KYOLI_DISABLE_MODELS_FETCH;

afterEach(() => {
  if (originalDisableModelsFetch === undefined) {
    delete process.env.KYOLI_DISABLE_MODELS_FETCH;
  } else {
    process.env.KYOLI_DISABLE_MODELS_FETCH = originalDisableModelsFetch;
  }
});

describe("runCodexSmokeDoctor", () => {
  it("builds Codex CLI E2E args against kyoli backend-api Responses", () => {
    expect(createCodexCliE2EArgs({
      backendApiBaseUrl: "http://127.0.0.1:2021/backend-api",
      modelId: "gpt-5.3-codex",
      expectedText: "smoke-ok",
      projectDir: "/tmp/kyoli-codex-cli-e2e",
    })).toEqual([
      "-a",
      "never",
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "-s",
      "read-only",
      "-C",
      "/tmp/kyoli-codex-cli-e2e",
      "-m",
      "gpt-5.3-codex",
      "-c",
      "chatgpt_base_url=\"http://127.0.0.1:2021/backend-api\"",
      "Reply exactly: smoke-ok",
    ]);
  });

  it("builds OpenCode E2E config through the built-in openai Responses provider", () => {
    const config = createOpenCodeE2EConfig("http://127.0.0.1:2021/v1", "gpt-5.3-codex");

    expect(config).toMatchObject({
      model: "openai/gpt-5.3-codex",
      provider: {
        openai: {
          options: {
            baseURL: "http://127.0.0.1:2021/v1",
            apiKey: "kyoli-local-e2e",
          },
          models: {
            "gpt-5.3-codex": {
              reasoning: true,
              tool_call: true,
              provider: {
                npm: "@ai-sdk/openai",
              },
            },
          },
        },
      },
    });
    expect((config.provider as Record<string, unknown>).kyoli).toBeUndefined();
  });

  it("selects the newest standard Codex model from the model registry response", () => {
    expect(selectDefaultCodexModel({
      data: [
        {
          id: "openai/gpt-5.3-codex-spark",
          owned_by: "codex",
          kyoli: {
            provider: "codex",
            upstream_id: "gpt-5.3-codex-spark",
            capabilities: ["responses", "codex"],
            aliases: ["gpt-5.3-codex-spark"],
          },
        },
        {
          id: "openai/gpt-5.3-codex",
          owned_by: "codex",
          kyoli: {
            provider: "codex",
            upstream_id: "gpt-5.3-codex",
            capabilities: ["responses", "codex"],
            aliases: ["gpt-5.3-codex"],
          },
        },
        {
          id: "openai/gpt-5.2-codex",
          owned_by: "codex",
          kyoli: {
            provider: "codex",
            upstream_id: "gpt-5.2-codex",
            capabilities: ["responses", "codex"],
            aliases: ["gpt-5.2-codex"],
          },
        },
      ],
    })).toBe("openai/gpt-5.3-codex");
  });

  it("routes a Codex smoke request through the gateway and records the used account", async () => {
    process.env.KYOLI_DISABLE_MODELS_FETCH = "true";
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      name: "Codex smoke",
      credentials: {
        accessToken: "access-smoke",
        refreshToken: "refresh-smoke",
        expiresAt: Date.now() + 60 * 60 * 1000,
        accountId: "acct_smoke",
      },
    });
    let upstreamBody: Record<string, unknown> = {};
    let upstreamAuthorization = "";
    let upstreamAccountId = "";

    const report = await runCodexSmokeDoctor(
      store,
      {
        host: "127.0.0.1",
        port: 2021,
        accountSelectionStrategy: "sticky",
        softQuotaThresholdPercent: 100,
      },
      {
        fetch: async (_input, init) => {
          upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const headers = new Headers(init?.headers);
          upstreamAuthorization = headers.get("authorization") ?? "";
          upstreamAccountId = headers.get("ChatGPT-Account-ID") ?? "";

          return new Response(
            [
              "event: response.output_text.delta",
              'data: {"delta":"smoke-ok"}',
              "",
            ].join("\n"),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          );
        },
      },
    );

    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBe(7);
    expect(report.checks.find((check) => check.name === "account execution trace")?.detail).toContain(
      ":200",
    );
    expect(upstreamAuthorization).toBe("Bearer access-smoke");
    expect(upstreamAccountId).toBe("acct_smoke");
    expect(upstreamBody.model).toBe("gpt-5.3-codex");
    expect((await store.listByProvider("codex"))[0]?.lastUsedAt).toBeTruthy();
  });

  it("supports OpenAI-style /v1/responses with an unprefixed Codex model alias", async () => {
    process.env.KYOLI_DISABLE_MODELS_FETCH = "true";
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-smoke",
        refreshToken: "refresh-smoke",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    let upstreamBody: Record<string, unknown> = {};

    const report = await runCodexSmokeDoctor(
      store,
      {
        host: "127.0.0.1",
        port: 2021,
      },
      {
        route: "/v1/responses",
        model: "gpt-5.3-codex",
        fetch: async (_input, init) => {
          upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response('data: {"delta":"smoke-ok"}\n\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    );

    expect(report.summary.fail).toBe(0);
    expect(report.checks.find((check) => check.name === "codex model registry")?.detail).toBe(
      "gpt-5.3-codex is available",
    );
    expect(upstreamBody.model).toBe("gpt-5.3-codex");
  });

  it("supports OpenAI-style /v1/chat/completions streaming smoke checks", async () => {
    process.env.KYOLI_DISABLE_MODELS_FETCH = "true";
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-smoke",
        refreshToken: "refresh-smoke",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    let upstreamBody: Record<string, unknown> = {};

    const report = await runCodexSmokeDoctor(
      store,
      {
        host: "127.0.0.1",
        port: 2021,
      },
      {
        route: "/v1/chat/completions",
        model: "gpt-5.3-codex",
        fetch: async (_input, init) => {
          upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            [
              "event: response.output_text.delta",
              'data: {"delta":"smoke-"}',
              "",
              "event: response.output_text.delta",
              'data: {"delta":"smoke-ok"}',
              "",
              "event: response.completed",
              'data: {"response":{"status":"completed"}}',
              "",
            ].join("\n"),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          );
        },
      },
    );

    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBe(7);
    expect(upstreamBody.model).toBe("gpt-5.3-codex");
    expect(upstreamBody.instructions).toBe("You are a helpful assistant.");
    expect(upstreamBody.store).toBe(false);
    expect(upstreamBody.stream).toBe(true);
    expect(upstreamBody.messages).toBeUndefined();
    expect(upstreamBody.input).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Reply with exactly: smoke-ok",
          },
        ],
      },
    ]);
  });

  it("fails before live smoke when no Codex OAuth account exists", async () => {
    process.env.KYOLI_DISABLE_MODELS_FETCH = "true";
    const report = await runCodexSmokeDoctor(new MemoryAccountStore(), {
      host: "127.0.0.1",
      port: 2021,
    });

    expect(report.summary.fail).toBe(1);
    expect(report.checks.map((check) => check.name)).toEqual([
      "codex account inventory",
      "gateway health",
      "codex model registry",
    ]);
  });

  it("shows failover attempts in the execution trace", async () => {
    process.env.KYOLI_DISABLE_MODELS_FETCH = "true";
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        refreshToken: "first-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        refreshToken: "second-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });

    const report = await runCodexSmokeDoctor(
      store,
      {
        host: "127.0.0.1",
        port: 2021,
      },
      {
        fetch: async (_input, init) => {
          const authorization = new Headers(init?.headers).get("authorization");
          if (authorization === "Bearer first-access") {
            return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "60",
              },
            });
          }

          return new Response('data: {"delta":"smoke-ok"}\n\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    );

    expect(report.summary.fail).toBe(0);
    expect(report.checks.find((check) => check.name === "account execution trace")?.detail).toContain(
      ":429:retry",
    );
  });

  it("runs the Codex file upload smoke flow through create, upload, and finalize", async () => {
    process.env.KYOLI_DISABLE_MODELS_FETCH = "true";
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      name: "Codex file smoke",
      credentials: {
        accessToken: "access-smoke",
        refreshToken: "refresh-smoke",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    const calls: Array<{ url: string; method: string; auth: string; body?: string }> = [];

    const report = await runCodexFileSmokeDoctor(
      store,
      {
        host: "127.0.0.1",
        port: 2021,
        accountSelectionStrategy: "sticky",
        softQuotaThresholdPercent: 100,
      },
      {
        fileName: "smoke.txt",
        fileContent: "hello file",
        fetch: async (input, init) => {
          const url = String(input);
          calls.push({
            url,
            method: init?.method ?? "GET",
            auth: new Headers(init?.headers).get("authorization") ?? "",
            body: typeof init?.body === "string" ? init.body : undefined,
          });

          if (url === "https://chatgpt.com/backend-api/files") {
            return new Response(
              JSON.stringify({
                file_id: "file_smoke",
                upload_url: "https://upload.test/file_smoke",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }

          if (url === "https://upload.test/file_smoke") {
            return new Response(null, { status: 201, statusText: "Created" });
          }

          if (url === "https://chatgpt.com/backend-api/files/file_smoke/uploaded") {
            return new Response(JSON.stringify({ status: "uploaded" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          return new Response(null, { status: 500 });
        },
      },
    );

    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBe(7);
    expect(calls).toMatchObject([
      {
        url: "https://chatgpt.com/backend-api/files",
        method: "POST",
        auth: "Bearer access-smoke",
      },
      {
        url: "https://upload.test/file_smoke",
        method: "PUT",
        auth: "",
        body: "hello file",
      },
      {
        url: "https://chatgpt.com/backend-api/files/file_smoke/uploaded",
        method: "POST",
        auth: "Bearer access-smoke",
      },
    ]);
  });

  it("runs HTTP server E2E checks against Responses and Chat clients", async () => {
    process.env.KYOLI_DISABLE_MODELS_FETCH = "true";
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "access-e2e",
        refreshToken: "refresh-e2e",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    const upstreamBodies: Record<string, unknown>[] = [];

    const report = await runCodexE2EDoctor(
      store,
      {
        host: "127.0.0.1",
        port: 2021,
      },
      {
        expectedText: "smoke-ok",
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          upstreamBodies.push(body);
          return new Response(`data: {"delta":"smoke-ok"}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    );

    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBe(6);
    expect(report.checks.map((check) => check.name)).toEqual([
      "codex account inventory",
      "server health over HTTP",
      "OpenAI-compatible models over HTTP",
      "OpenAI Responses HTTP client",
      "Generic Chat Completions bridge HTTP client",
      "account execution trace",
    ]);
    expect(upstreamBodies).toHaveLength(2);
    expect(upstreamBodies.every((body) => body.model === "gpt-5.3-codex")).toBe(true);
  });

  it("runs a bounded Codex load check and reports account distribution", async () => {
    process.env.KYOLI_DISABLE_MODELS_FETCH = "true";
    const store = new MemoryAccountStore();
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "first-access",
        refreshToken: "first-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });
    await store.create({
      provider: "codex",
      kind: "oauth",
      credentials: {
        accessToken: "second-access",
        refreshToken: "second-refresh",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    });

    const report = await runCodexLoadDoctor(
      store,
      {
        host: "127.0.0.1",
        port: 2021,
        accountSelectionStrategy: "round-robin",
      },
      {
        requests: 4,
        concurrency: 2,
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const instructions = String(body.instructions ?? "");
          const expected = instructions.match(/request-ok-\d+/)?.[0] ?? "request-ok-missing";
          return new Response(`data: {"delta":"${expected}"}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    );

    expect(report.summary.fail).toBe(0);
    expect(report.checks.find((check) => check.name === "completed requests")?.detail).toContain("4/4");
    expect(report.checks.find((check) => check.name === "account distribution")?.status).toBe("pass");
  });
});
