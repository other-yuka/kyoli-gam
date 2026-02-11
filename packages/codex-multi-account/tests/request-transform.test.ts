import { describe, test, expect } from "vitest";
import { buildRequestHeaders, transformRequestUrl } from "../src/request-transform";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const EXPECTED_USER_AGENT = "opencode/1.1.53";

// ---------------------------------------------------------------------------
// buildRequestHeaders
// ---------------------------------------------------------------------------
describe("buildRequestHeaders", () => {
  const TOKEN = "test-access-token";

  test("sets authorization header with Bearer token", () => {
    const headers = buildRequestHeaders("https://example.com", undefined, TOKEN);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("sets originator to opencode", () => {
    const headers = buildRequestHeaders("https://example.com", undefined, TOKEN);
    expect(headers.get("originator")).toBe("opencode");
  });

  test("sets User-Agent to OPENAI_CLI_USER_AGENT", () => {
    const headers = buildRequestHeaders("https://example.com", undefined, TOKEN);
    expect(headers.get("User-Agent")).toBe(EXPECTED_USER_AGENT);
  });

  test("sets ChatGPT-Account-Id when accountId is provided", () => {
    const headers = buildRequestHeaders("https://example.com", undefined, TOKEN, "acc-123");
    expect(headers.get("ChatGPT-Account-Id")).toBe("acc-123");
  });

  test("does NOT set ChatGPT-Account-Id when accountId is undefined", () => {
    const headers = buildRequestHeaders("https://example.com", undefined, TOKEN);
    expect(headers.has("ChatGPT-Account-Id")).toBe(false);
  });

  test("deletes ChatGPT-Account-Id if previously present and accountId is undefined", () => {
    const init: RequestInit = {
      headers: { "ChatGPT-Account-Id": "old-account" },
    };
    const headers = buildRequestHeaders("https://example.com", init, TOKEN);
    expect(headers.has("ChatGPT-Account-Id")).toBe(false);
  });

  test("deletes ChatGPT-Account-Id when accountId is empty string", () => {
    const init: RequestInit = {
      headers: { "ChatGPT-Account-Id": "old-account" },
    };
    const headers = buildRequestHeaders("https://example.com", init, TOKEN, "");
    expect(headers.has("ChatGPT-Account-Id")).toBe(false);
  });

  test("removes x-api-key header", () => {
    const init: RequestInit = {
      headers: { "x-api-key": "some-key" },
    };
    const headers = buildRequestHeaders("https://example.com", init, TOKEN);
    expect(headers.has("x-api-key")).toBe(false);
  });

  test("removes existing authorization header before setting new one", () => {
    const init: RequestInit = {
      headers: { Authorization: "Bearer old-token" },
    };
    const headers = buildRequestHeaders("https://example.com", init, TOKEN);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("preserves other custom headers from init", () => {
    const init: RequestInit = {
      headers: { "X-Custom": "value", "Accept": "application/json" },
    };
    const headers = buildRequestHeaders("https://example.com", init, TOKEN);
    expect(headers.get("X-Custom")).toBe("value");
    expect(headers.get("Accept")).toBe("application/json");
  });

  test("merges headers from Request input object", () => {
    const req = new Request("https://example.com", {
      headers: { "X-From-Request": "req-value" },
    });
    const headers = buildRequestHeaders(req, undefined, TOKEN);
    expect(headers.get("X-From-Request")).toBe("req-value");
  });

  test("init headers override Request input headers", () => {
    const req = new Request("https://example.com", {
      headers: { "X-Shared": "from-request" },
    });
    const init: RequestInit = {
      headers: { "X-Shared": "from-init" },
    };
    const headers = buildRequestHeaders(req, init, TOKEN);
    expect(headers.get("X-Shared")).toBe("from-init");
  });

  test("handles init.headers as Headers object", () => {
    const h = new Headers();
    h.set("X-Headers-Obj", "headers-value");
    const init: RequestInit = { headers: h };
    const headers = buildRequestHeaders("https://example.com", init, TOKEN);
    expect(headers.get("X-Headers-Obj")).toBe("headers-value");
  });

  test("handles init.headers as array of tuples", () => {
    const init: RequestInit = {
      headers: [
        ["X-Tuple-Header", "tuple-value"],
        ["Accept", "text/plain"],
      ],
    };
    const headers = buildRequestHeaders("https://example.com", init, TOKEN);
    expect(headers.get("X-Tuple-Header")).toBe("tuple-value");
    expect(headers.get("Accept")).toBe("text/plain");
  });
});

// ---------------------------------------------------------------------------
// transformRequestUrl
// ---------------------------------------------------------------------------
describe("transformRequestUrl", () => {
  test("rewrites URL containing /v1/responses", () => {
    const result = transformRequestUrl("https://api.openai.com/v1/responses");
    expect(result).toBeInstanceOf(URL);
    expect((result as URL).href).toBe(`${CODEX_API_ENDPOINT}`);
  });

  test("rewrites URL containing /chat/completions", () => {
    const result = transformRequestUrl("https://api.openai.com/v1/chat/completions");
    expect(result).toBeInstanceOf(URL);
    expect((result as URL).href).toBe(`${CODEX_API_ENDPOINT}`);
  });

  test("preserves query string when rewriting", () => {
    const result = transformRequestUrl("https://api.openai.com/v1/responses?stream=true&beta=1");
    expect(result).toBeInstanceOf(URL);
    const url = result as URL;
    expect(url.origin + url.pathname).toBe(CODEX_API_ENDPOINT);
    expect(url.searchParams.get("stream")).toBe("true");
    expect(url.searchParams.get("beta")).toBe("1");
  });

  test("does NOT rewrite URLs that don't match", () => {
    const original = "https://api.openai.com/v1/models";
    const result = transformRequestUrl(original);
    expect(result).toBe(original);
  });

  test("does NOT rewrite /v1/embeddings", () => {
    const original = "https://api.openai.com/v1/embeddings";
    const result = transformRequestUrl(original);
    expect(result).toBe(original);
  });

  test("handles URL input object", () => {
    const input = new URL("https://api.openai.com/v1/responses");
    const result = transformRequestUrl(input);
    expect(result).toBeInstanceOf(URL);
    expect((result as URL).href).toBe(`${CODEX_API_ENDPOINT}`);
  });

  test("handles Request input and returns new Request with rewritten URL", () => {
    const req = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4" }),
    });
    const result = transformRequestUrl(req);
    expect(result).toBeInstanceOf(Request);
    const newReq = result as Request;
    expect(newReq.url).toBe(CODEX_API_ENDPOINT);
    expect(newReq.method).toBe("POST");
  });

  test("Request input preserves original headers after URL rewrite", () => {
    const req = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "X-Custom": "keep-me" },
    });
    const result = transformRequestUrl(req) as Request;
    expect(result.headers.get("X-Custom")).toBe("keep-me");
  });

  test("returns original input unchanged when URL doesn't match", () => {
    const req = new Request("https://api.openai.com/v1/models");
    const result = transformRequestUrl(req);
    expect(result).toBe(req);
  });

  test("handles invalid URL strings gracefully (returns input as-is)", () => {
    const invalid = "not-a-valid-url";
    const result = transformRequestUrl(invalid);
    expect(result).toBe(invalid);
  });

  test("rewrites URL with both /chat/completions path and query params", () => {
    const result = transformRequestUrl("https://api.openai.com/v1/chat/completions?model=gpt-4");
    expect(result).toBeInstanceOf(URL);
    const url = result as URL;
    expect(url.origin + url.pathname).toBe(CODEX_API_ENDPOINT);
    expect(url.searchParams.get("model")).toBe("gpt-4");
  });
});
