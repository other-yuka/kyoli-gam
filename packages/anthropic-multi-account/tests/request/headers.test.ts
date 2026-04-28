import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, mock, test, vi } from "bun:test";

const bundledTemplateJson = JSON.parse(
  readFileSync(new URL("../../src/claude-code/fingerprint/data.json", import.meta.url), "utf8"),
) as MinimalTemplate;

const detectCliVersionMock = vi.fn(() => "2.3.5");
const loadTemplateMock = vi.fn();

mock.module("../../src/claude-code/cli-version", () => ({
  detectCliVersion: detectCliVersionMock,
}));

mock.module("../../src/claude-code/fingerprint/capture", () => ({
  compareVersions: vi.fn(() => 0),
  loadTemplate: loadTemplateMock,
}));

const {
  getAnthropicVersion,
  getStaticHeaders,
  getPerRequestHeaders,
  getBetaHeader,
  orderHeadersForOutbound,
  filterBillableBetas,
} = await import("../../src/request/headers");

interface MinimalTemplate {
  _version: number;
  _captured: string;
  _source: string;
  agent_identity: string;
  system_prompt: string;
  tools: Array<{ name: string }>;
  tool_names: string[];
  anthropic_beta?: string;
  header_order?: string[];
  header_values?: Record<string, string>;
}

function createMinimalTemplate(overrides?: Partial<MinimalTemplate>): MinimalTemplate {
  return {
    _version: 1,
    _captured: "2026-01-01T00:00:00.000Z",
    _source: "bundled",
    agent_identity: "test",
    system_prompt: "test",
    tools: [{ name: "Bash" }],
    tool_names: ["Bash"],
    ...overrides,
  };
}

function getBundledBetaFallback(): string {
  const bundledTemplate = bundledTemplateJson as MinimalTemplate;
  return bundledTemplate.anthropic_beta ?? bundledTemplate.header_values?.["anthropic-beta"] ?? "";
}

beforeEach(() => {
  detectCliVersionMock.mockReturnValue("2.3.5");
  loadTemplateMock.mockReturnValue(createMinimalTemplate());
});

describe("getStaticHeaders", () => {
  test("includes all required stainless headers", () => {
    const headers = getStaticHeaders();

    expect(headers["x-stainless-arch"]).toBe(process.arch);
    expect(headers["x-stainless-lang"]).toBe("js");
    expect(headers["x-stainless-os"]).toBeDefined();
    expect(headers["x-stainless-runtime"]).toBe("node");
    expect(headers["x-stainless-runtime-version"]).toBe(process.version);
    expect(headers["x-stainless-package-version"]).toBeDefined();
    expect(headers["x-stainless-retry-count"]).toBe("0");
    expect(headers["user-agent"]).toContain("claude-cli/");
    expect(headers["x-app"]).toBe("cli");
  });

  test("uses detected CLI version in user-agent", () => {
    detectCliVersionMock.mockReturnValue("3.0.0");

    const headers = getStaticHeaders();

    expect(headers["user-agent"]).toBe("claude-cli/3.0.0 (external, cli)");
  });

  test("template header_values overlay wins over defaults", () => {
    loadTemplateMock.mockReturnValue(
      createMinimalTemplate({
        header_values: { "user-agent": "custom-ua" },
      }),
    );

    const headers = getStaticHeaders();

    expect(headers["user-agent"]).toBe("custom-ua");
  });

  test("template overlay can add new headers", () => {
    loadTemplateMock.mockReturnValue(
      createMinimalTemplate({
        header_values: { "x-custom-header": "custom-value" },
      }),
    );

    const headers = getStaticHeaders();

    expect(headers["x-custom-header"]).toBe("custom-value");
  });

  test("includes base content headers", () => {
    const headers = getStaticHeaders();

    expect(headers["accept"]).toBe("application/json");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });
});

describe("getPerRequestHeaders", () => {
  test("includes session ID", () => {
    const headers = getPerRequestHeaders("session-123");

    expect(headers["x-claude-code-session-id"]).toBe("session-123");
  });

  test("generates UUID for x-client-request-id", () => {
    const headers = getPerRequestHeaders("session-123");
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    expect(headers["x-client-request-id"]).toMatch(uuidPattern);
  });

  test("includes correct anthropic-version", () => {
    const headers = getPerRequestHeaders("session-123");

    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("uses template anthropic-version when present", () => {
    loadTemplateMock.mockReturnValue(
      createMinimalTemplate({
        header_values: { "anthropic-version": "2024-10-22" },
      }),
    );

    expect(getAnthropicVersion()).toBe("2024-10-22");
    expect(getPerRequestHeaders("session-123")["anthropic-version"]).toBe("2024-10-22");
  });

  test("includes timeout as seconds string", () => {
    const headers = getPerRequestHeaders("session-123");

    expect(headers["x-stainless-timeout"]).toBe("300");
  });

  test("generates unique request IDs per call", () => {
    const first = getPerRequestHeaders("session-123");
    const second = getPerRequestHeaders("session-123");

    expect(first["x-client-request-id"]).not.toBe(second["x-client-request-id"]);
  });
});

describe("getBetaHeader", () => {
  test("uses template beta when available", () => {
    loadTemplateMock.mockReturnValue(
      createMinimalTemplate({
        anthropic_beta: "custom-beta-20250101",
      }),
    );

    expect(getBetaHeader()).toBe("custom-beta-20250101");
  });

  test("falls back when template beta is absent", () => {
    loadTemplateMock.mockReturnValue(createMinimalTemplate());

    const beta = getBetaHeader();

    expect(beta).toBe(getBundledBetaFallback());
    expect(beta.length).toBeGreaterThan(0);
  });

  test("falls back when template beta is empty string", () => {
    loadTemplateMock.mockReturnValue(
      createMinimalTemplate({ anthropic_beta: "" }),
    );

    const beta = getBetaHeader();

    expect(beta).toBe(getBundledBetaFallback());
    expect(beta.length).toBeGreaterThan(0);
  });
});

describe("orderHeadersForOutbound", () => {
  test("returns ordered tuples when order is provided", () => {
    const headers = { b: "2", a: "1" };
    const order = ["a", "b"];

    const result = orderHeadersForOutbound(headers, order);

    expect(result).toEqual([["a", "1"], ["b", "2"]]);
  });

  test("returns original record when no order exists", () => {
    loadTemplateMock.mockReturnValue(createMinimalTemplate());

    const headers = { b: "2", a: "1" };
    const result = orderHeadersForOutbound(headers);

    expect(result).toBe(headers);
  });

  test("appends unordered headers after ordered ones", () => {
    const headers = { c: "3", b: "2", a: "1" };
    const order = ["a"];

    const result = orderHeadersForOutbound(headers, order);

    expect(Array.isArray(result)).toBe(true);
    expect((result as Array<[string, string]>)[0]).toEqual(["a", "1"]);
    expect((result as Array<[string, string]>).length).toBe(3);
  });

  test("matches header names case-insensitively", () => {
    const headers = { "Content-Type": "application/json" };
    const order = ["content-type"];

    const result = orderHeadersForOutbound(headers, order);

    expect(result).toEqual([["content-type", "application/json"]]);
  });

  test("preserves order-source casing in output", () => {
    const headers = { "content-type": "application/json" };
    const order = ["Content-Type"];

    const result = orderHeadersForOutbound(headers, order);

    expect(result).toEqual([["Content-Type", "application/json"]]);
  });

  test("skips duplicate order entries", () => {
    const headers = { a: "1" };
    const order = ["a", "a", "A"];

    const result = orderHeadersForOutbound(headers, order);

    expect(result).toEqual([["a", "1"]]);
  });

  test("uses template header_order as fallback", () => {
    loadTemplateMock.mockReturnValue(
      createMinimalTemplate({ header_order: ["b", "a"] }),
    );

    const headers = { a: "1", b: "2" };
    const result = orderHeadersForOutbound(headers);

    expect(result).toEqual([["b", "2"], ["a", "1"]]);
  });

  test("override order takes precedence over template", () => {
    loadTemplateMock.mockReturnValue(
      createMinimalTemplate({ header_order: ["b", "a"] }),
    );

    const headers = { a: "1", b: "2" };
    const result = orderHeadersForOutbound(headers, ["a", "b"]);

    expect(result).toEqual([["a", "1"], ["b", "2"]]);
  });
});

describe("filterBillableBetas", () => {
  test("removes billable betas", () => {
    const input = "claude-code-20250219,extended-cache-ttl-2025-01-01";

    expect(filterBillableBetas(input)).toBe("claude-code-20250219");
  });

  test("keeps non-billable betas intact", () => {
    const input = "claude-code-20250219,oauth-2025-04-20";

    expect(filterBillableBetas(input)).toBe("claude-code-20250219,oauth-2025-04-20");
  });

  test("handles empty string", () => {
    expect(filterBillableBetas("")).toBe("");
  });

  test("trims whitespace around betas", () => {
    const input = " claude-code-20250219 , extended-cache-ttl-2025-01-01 ";

    expect(filterBillableBetas(input)).toBe("claude-code-20250219");
  });

  test("removes multiple billable betas", () => {
    const input = "claude-code-20250219,extended-cache-ttl-2025-01-01,extended-cache-ttl-2026-02-02";

    expect(filterBillableBetas(input)).toBe("claude-code-20250219");
  });
});
