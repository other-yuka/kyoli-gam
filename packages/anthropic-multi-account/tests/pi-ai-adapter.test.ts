import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  resetAnthropicTokenProxyStateForTest,
  withAnthropicTokenProxyFetch,
} from "../src/pi-ai-adapter";
import {
  setNodeTokenRequestRunnerForTest,
  type NodeTokenRequestOptions,
} from "../src/token-node-request";

describe("pi-ai-adapter token endpoint proxy", () => {
  let originalFetch: typeof globalThis.fetch;

  function installPassthroughFetch(): ReturnType<typeof vi.fn> {
    const passthroughFetch = vi.fn(async () => new Response("outside", { status: 200 }));
    globalThis.fetch = passthroughFetch as unknown as typeof globalThis.fetch;
    return passthroughFetch;
  }

  function createTokenRequest(body: ReadableStream<Uint8Array>): Request {
    return new Request(
      "https://platform.claude.com/v1/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        duplex: "half",
      } as RequestInit,
    );
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAnthropicTokenProxyStateForTest();
    setNodeTokenRequestRunnerForTest(null);
    vi.restoreAllMocks();
  });

  test("proxy routes token endpoint requests through external node process", async () => {
    const runnerSpy = vi.fn(async (options: NodeTokenRequestOptions) => {
      expect(options.endpoint).toBe("https://platform.claude.com/v1/oauth/token");
      expect(typeof options.body).toBe("string");

      return JSON.stringify({
        ok: true,
        body: JSON.stringify({
          access_token: "next-access",
          refresh_token: "next-refresh",
          expires_in: 3600,
        }),
      });
    });
    setNodeTokenRequestRunnerForTest(runnerSpy);

    const passthroughFetch = installPassthroughFetch();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          grant_type: "authorization_code",
          client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
          code: "auth-code",
        })));
        controller.close();
      },
    });

    const tokenRequest = createTokenRequest(stream);

    const response = await withAnthropicTokenProxyFetch(async () => {
      const tokenResponse = await fetch(tokenRequest);

      const unrelatedResponse = await fetch("https://example.com/health");
      expect(unrelatedResponse.status).toBe(200);
      return tokenResponse;
    });

    const result = await response.json() as {
      access_token: string;
      refresh_token: string;
    };

    expect(result.access_token).toBe("next-access");
    expect(result.refresh_token).toBe("next-refresh");
    expect(runnerSpy).toHaveBeenCalledTimes(1);
    expect(passthroughFetch).toHaveBeenCalledTimes(1);
  });

  test("proxy does not affect token endpoint requests outside auth context", async () => {
    const runnerSpy = vi.fn(async () => JSON.stringify({ ok: true, body: "{}" }));
    setNodeTokenRequestRunnerForTest(runnerSpy);

    const passthroughFetch = installPassthroughFetch();

    const response = await fetch("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ grant_type: "refresh_token" }),
    });

    expect(response.status).toBe(200);
    expect(runnerSpy).toHaveBeenCalledTimes(0);
    expect(passthroughFetch).toHaveBeenCalledTimes(1);
  });

  test("proxy surfaces node-runner failures", async () => {
    setNodeTokenRequestRunnerForTest(async () => JSON.stringify({
      ok: false,
      status: 429,
      body: JSON.stringify({
        error: { type: "rate_limit_error", message: "Rate limited. Please try again later." },
      }),
    }));

    let thrown: unknown;
    try {
      await withAnthropicTokenProxyFetch(async () => {
        await fetch("https://platform.claude.com/v1/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            grant_type: "refresh_token",
            client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            refresh_token: "current-refresh",
          }),
        });
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("status=429");
  });
});
