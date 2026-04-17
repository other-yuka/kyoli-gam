import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { setupTestEnv } from "./helpers";
import {
  captureLiveTemplateAsync,
  checkCCCompat,
  detectDrift,
  extractTemplate,
  loadTemplate,
  refreshLiveFingerprintAsync,
  resetFingerprintCaptureForTest,
  setFingerprintCaptureTestOverridesForTest,
  type CapturedRequest,
  type TemplateData,
} from "../src/fingerprint-capture";

const CACHE_FILE_NAME = "fingerprint-cache.json";

afterEach(() => {
  resetFingerprintCaptureForTest();
});

function createLiveTemplate(overrides?: Partial<TemplateData>): TemplateData {
  return {
    _version: 1,
    _captured: new Date().toISOString(),
    _source: "live",
    agent_identity: "You are Claude Code.",
    system_prompt: "Use the available tools.",
    tools: [{ name: "Read" }, { name: "Bash" }],
    tool_names: ["Read", "Bash"],
    cc_version: "2.1.80",
    header_values: {
      "anthropic-version": "2023-06-01",
      "x-app": "cli",
    },
    ...overrides,
  };
}

function createCapturedRequest(): CapturedRequest {
  return {
    body: {
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.80.bb5; cch=00000;" },
        { type: "text", text: "You are Claude Code, an interactive CLI tool." },
        { type: "text", text: "Inspect the repository before making assumptions." },
      ],
      tools: [
        { name: "Read", description: "Read files" },
        { name: "Bash", description: "Run shell commands" },
      ],
    },
    headers: {
      authorization: "Bearer secret",
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "user-agent": "claude-code/2.1.80",
      "x-app": "cli",
    },
    rawHeaders: [
      "Authorization", "Bearer secret",
      "Anthropic-Version", "2023-06-01",
      "X-App", "cli",
      "User-Agent", "claude-code/2.1.80",
    ],
  };
}

describe("fingerprint-capture", () => {
  test("loadTemplate returns cached template from config dir when present", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      await fs.writeFile(
        join(dir, CACHE_FILE_NAME),
        `${JSON.stringify(createLiveTemplate(), null, 2)}\n`,
        "utf8",
      );

      const template = loadTemplate();

      expect(template._source).toBe("cached");
      expect(template.cc_version).toBe("2.1.80");
      expect(template.tools).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  test("loadTemplate falls back to bundled data when cache is missing", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const template = loadTemplate();

      expect(template._source).toBe("bundled");
      expect(template.tools.length).toBeGreaterThan(0);
      expect(template.tool_names.length).toBe(template.tools.length);
    } finally {
      await cleanup();
    }
  });

  test("loadTemplate quarantines corrupt cache files conservatively", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      await fs.writeFile(join(dir, CACHE_FILE_NAME), "{not-json", "utf8");

      const template = loadTemplate();
      const files = await fs.readdir(dir);

      expect(template._source).toBe("bundled");
      expect(files).not.toContain(CACHE_FILE_NAME);
      expect(files.some((file) => file.startsWith(`${CACHE_FILE_NAME}.corrupt-`))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("extractTemplate parses the captured request body and headers", () => {
    const template = extractTemplate(createCapturedRequest());

    expect(template).not.toBeNull();
    expect(template?.agent_identity).toContain("Claude Code");
    expect(template?.system_prompt).toContain("Inspect the repository");
    expect(template?.tool_names).toEqual(["Read", "Bash"]);
    expect(template?.header_order).toEqual(["Authorization", "Anthropic-Version", "X-App", "User-Agent"]);
    expect(template?.header_values).toEqual({
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "user-agent": "claude-code/2.1.80",
      "x-app": "cli",
    });
    expect(template?.cc_version).toBe("2.1.80");
  });

  test("extractTemplate returns null when the system blocks drift away from the expected three-block shape", () => {
    const twoBlockRequest = createCapturedRequest();
    twoBlockRequest.body.system = [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.80.bb5; cch=00000;" },
      { type: "text", text: "You are Claude Code, an interactive CLI tool." },
    ];

    const fourBlockRequest = createCapturedRequest();
    fourBlockRequest.body.system = [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.80.bb5; cch=00000;" },
      { type: "text", text: "You are Claude Code, an interactive CLI tool." },
      { type: "text", text: "Inspect the repository before making assumptions." },
      { type: "text", text: "Unexpected extra block" },
    ];

    expect(extractTemplate(twoBlockRequest)).toBeNull();
    expect(extractTemplate(fourBlockRequest)).toBeNull();
  });

  test("captureLiveTemplateAsync runs the localhost capture flow and returns extracted template data", async () => {
    setFingerprintCaptureTestOverridesForTest({
      findClaudeBinary: () => "/mock/claude",
      runClaudeCapture: async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            authorization: "Bearer secret",
            "anthropic-beta": "oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "user-agent": "claude-code/2.1.80",
            "x-app": "cli",
          },
          body: JSON.stringify(createCapturedRequest().body),
        });

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(await response.text()).toContain("event: message_stop");
      },
    });

    const template = await captureLiveTemplateAsync(3_000);

    expect(template).not.toBeNull();
    expect(template?._source).toBe("live");
    expect(template?.tool_names).toEqual(["Read", "Bash"]);
  });

  test("captureLiveTemplateAsync returns null when the Claude binary is unavailable", async () => {
    setFingerprintCaptureTestOverridesForTest({
      findClaudeBinary: () => null,
    });

    return expect(captureLiveTemplateAsync()).resolves.toBeNull();
  });

  test("refreshLiveFingerprintAsync short-circuits fresh cache and refreshes stale cache", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      const freshTemplate = createLiveTemplate({ _captured: new Date().toISOString() });
      await fs.writeFile(join(dir, CACHE_FILE_NAME), `${JSON.stringify(freshTemplate, null, 2)}\n`, "utf8");

      setFingerprintCaptureTestOverridesForTest({
        findClaudeBinary: () => "/mock/claude",
        runClaudeCapture: async () => {
          throw new Error("runner should not execute for fresh cache");
        },
      });

      const cached = await refreshLiveFingerprintAsync();
      expect(cached?._source).toBe("cached");

      const staleTemplate = createLiveTemplate({
        _captured: new Date(Date.now() - (26 * 60 * 60 * 1000)).toISOString(),
        cc_version: "2.1.70",
      });
      await fs.writeFile(join(dir, CACHE_FILE_NAME), `${JSON.stringify(staleTemplate, null, 2)}\n`, "utf8");

      setFingerprintCaptureTestOverridesForTest({
        findClaudeBinary: () => "/mock/claude",
        runClaudeCapture: async ({ baseUrl }) => {
          await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
              "user-agent": "claude-code/2.1.90",
              "x-app": "cli",
            },
            body: JSON.stringify({
              system: [
                "x-anthropic-billing-header: cc_version=2.1.90.abc; cch=00000;",
                "You are Claude Code.",
                "Inspect the repo.",
              ],
              tools: [{ name: "Read" }],
            }),
          });
        },
      });

      const refreshed = await refreshLiveFingerprintAsync();
      expect(refreshed?._source).toBe("live");
      expect(refreshed?.cc_version).toBe("2.1.90");

      const loaded = loadTemplate();
      expect(loaded._source).toBe("cached");
      expect(loaded.cc_version).toBe("2.1.90");
    } finally {
      await cleanup();
    }
  });

  test("detectDrift and checkCCCompat follow the expected version invariants", () => {
    const drift = detectDrift(createLiveTemplate({ cc_version: "2.1.80" }), "2.1.90");
    const noDrift = detectDrift(createLiveTemplate({ cc_version: "2.1.80" }), "2.1.80");
    const missingVersionDrift = detectDrift(createLiveTemplate({ cc_version: undefined }), "2.1.90");

    setFingerprintCaptureTestOverridesForTest({
      detectCliVersion: () => {
        throw new Error("probe failed");
      },
    });

    expect(drift).toEqual({
      drifted: true,
      cachedVersion: "2.1.80",
      installedVersion: "2.1.90",
      message: "cache v2.1.80 != installed v2.1.90",
    });
    expect(noDrift).toEqual({
      drifted: false,
      cachedVersion: "2.1.80",
      installedVersion: "2.1.80",
      message: "cache v2.1.80 matches installed v2.1.80",
    });
    expect(missingVersionDrift.drifted).toBe(false);
    expect(missingVersionDrift.cachedVersion).toBeNull();

    expect(checkCCCompat(null).status).toBe("unknown");
    expect(checkCCCompat("dev-build").status).toBe("unknown");
    expect(checkCCCompat("0.9.9").status).toBe("below-min");
    expect(checkCCCompat("2.1.104").status).toBe("ok");
    expect(checkCCCompat("9.0.0").status).toBe("untested-above");
  });

  test("loadTemplate quarantines schema-invalid cache payloads", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      await fs.writeFile(
        join(dir, CACHE_FILE_NAME),
        `${JSON.stringify({ _version: "wrong", _captured: "2026-04-17T00:00:00.000Z" }, null, 2)}\n`,
        "utf8",
      );

      const template = loadTemplate();
      const files = await fs.readdir(dir);

      expect(template._source).toBe("bundled");
      expect(files.some((file) => file.startsWith(`${CACHE_FILE_NAME}.corrupt-`))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
