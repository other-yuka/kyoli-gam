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
  matchesBundledClaudeCodeFingerprint,
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
  const bundled = loadTemplate();

  return {
    _version: 1,
    _schemaVersion: 1,
    _captured: new Date().toISOString(),
    _source: "live",
    agent_identity: bundled.agent_identity,
    system_prompt: bundled.system_prompt,
    tools: [
      { name: "Read", input_schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
      { name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    ],
    tool_names: ["Read", "Bash"],
    cc_version: bundled.cc_version,
    header_values: bundled.header_values,
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
      expect(template.cc_version).toBe(createLiveTemplate().cc_version);
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
    expect(template?._schemaVersion).toBe(1);
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
      const bundled = loadTemplate();

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
        detectCliVersion: () => bundled.cc_version ?? "2.1.114",
        runClaudeCapture: async ({ baseUrl }) => {
          await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
              "user-agent": `claude-code/${bundled.cc_version ?? "2.1.114"}`,
              "x-app": "cli",
            },
            body: JSON.stringify({
              system: [
                `x-anthropic-billing-header: cc_version=${bundled.cc_version ?? "2.1.114"}.abc; cch=00000;`,
                bundled.agent_identity,
                bundled.system_prompt,
              ],
              tools: bundled.tools,
            }),
          });
        },
      });

      const refreshed = await refreshLiveFingerprintAsync();
      expect(refreshed?._source).toBe("live");
      expect(refreshed?.cc_version).toBe(bundled.cc_version);

      const loaded = loadTemplate();
      expect(loaded._source).toBe("cached");
      expect(loaded.cc_version).toBe(bundled.cc_version);
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
    expect(checkCCCompat("2.1.114").status).toBe("ok");
    expect(checkCCCompat("9.0.0").status).toBe("untested-above");
  });

  test("loadTemplate rejects cached data with missing _schemaVersion and falls back to bundled", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      const cacheWithoutSchema = createLiveTemplate();
      delete (cacheWithoutSchema as unknown as Record<string, unknown>)._schemaVersion;

      await fs.writeFile(
        join(dir, CACHE_FILE_NAME),
        `${JSON.stringify(cacheWithoutSchema, null, 2)}\n`,
        "utf8",
      );

      const template = loadTemplate();

      expect(template._source).toBe("bundled");
    } finally {
      await cleanup();
    }
  });

  test("loadTemplate rejects cached data with outdated _schemaVersion and falls back to bundled", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      const cacheWithOldSchema = createLiveTemplate({ _schemaVersion: 0 });

      await fs.writeFile(
        join(dir, CACHE_FILE_NAME),
        `${JSON.stringify(cacheWithOldSchema, null, 2)}\n`,
        "utf8",
      );

      const template = loadTemplate();

      expect(template._source).toBe("bundled");
    } finally {
      await cleanup();
    }
  });

  test("loadTemplate keeps cached data even when cached version mismatches bundled version", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      setFingerprintCaptureTestOverridesForTest({
        detectCliVersion: () => "2.1.114",
      });

      await fs.writeFile(
        join(dir, CACHE_FILE_NAME),
        `${JSON.stringify(createLiveTemplate({ cc_version: "2.1.111" }), null, 2)}\n`,
        "utf8",
      );

      const template = loadTemplate();
      expect(template._source).toBe("cached");
      expect(template.cc_version).toBe("2.1.111");
    } finally {
      await cleanup();
    }
  });

  test("loadTemplate keeps cached data even when cached version mismatches installed version", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      setFingerprintCaptureTestOverridesForTest({
        detectCliVersion: () => "2.1.114",
      });

      const bundled = loadTemplate();

      await fs.writeFile(
        join(dir, CACHE_FILE_NAME),
        `${JSON.stringify({ ...bundled, _source: "live", _captured: new Date().toISOString(), cc_version: "2.1.113" }, null, 2)}\n`,
        "utf8",
      );

      const template = loadTemplate();
      expect(template._source).toBe("cached");
      expect(template.cc_version).toBe("2.1.113");
    } finally {
      await cleanup();
    }
  });

  test("extractTemplate captures body_field_order from top-level body keys", () => {
    const captured: CapturedRequest = {
      body: {
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hello" }],
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
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "user-agent": "claude-code/2.1.80",
        "x-app": "cli",
      },
      rawHeaders: [
        "Anthropic-Version", "2023-06-01",
        "Content-Type", "application/json",
      ],
    };

    const template = extractTemplate(captured);

    expect(template).not.toBeNull();
    expect(template?.body_field_order).toEqual(["model", "messages", "system", "tools"]);
  });

  test("extractTemplate omits body_field_order when body has no keys", () => {
    const captured: CapturedRequest = {
      body: {
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.80.bb5; cch=00000;" },
          { type: "text", text: "You are Claude Code." },
          { type: "text", text: "Inspect the repo." },
        ],
        tools: [{ name: "Read" }],
      },
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "user-agent": "claude-code/2.1.80",
        "x-app": "cli",
      },
      rawHeaders: [],
    };

    const template = extractTemplate(captured);

    expect(template).not.toBeNull();
    expect(template?.body_field_order).toEqual(["system", "tools"]);
  });

  test("bundled template tools all have input_schema with properties for Anthropic API compliance", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const template = loadTemplate();

      expect(template._source).toBe("bundled");
      expect(template.tools.length).toBeGreaterThan(0);

      for (const tool of template.tools) {
        expect(tool).toHaveProperty("input_schema");
        const schema = tool.input_schema as Record<string, unknown>;
        expect(typeof schema).toBe("object");
        expect(schema).not.toBeNull();
        expect(schema).toHaveProperty("type");
        expect(schema).toHaveProperty("properties");
      }
    } finally {
      await cleanup();
    }
  });

  test("bundled template preserves header and body ordering metadata", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const template = loadTemplate();

      expect(template._source).toBe("bundled");
      expect(Array.isArray(template.header_order)).toBe(true);
      expect(template.header_order?.length).toBeGreaterThan(0);
      expect(Array.isArray(template.body_field_order)).toBe(true);
      expect(template.body_field_order?.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test("bundled template preserves baked cc_version for billing and drift consumers", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const template = loadTemplate();

      expect(template._source).toBe("bundled");
      expect(typeof template.cc_version).toBe("string");
      expect(template.cc_version?.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  test("bundled template retains the current bundled identity and expected tool set", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const template = loadTemplate();

      expect(template._source).toBe("bundled");
      expect(template.agent_identity).toContain("Claude Agent SDK");
      expect(template.tool_names).toEqual([
        "Agent",
        "AskUserQuestion",
        "Bash",
        "CronCreate",
        "CronDelete",
        "CronList",
        "Edit",
        "EnterPlanMode",
        "EnterWorktree",
        "ExitPlanMode",
        "ExitWorktree",
        "Glob",
        "Grep",
        "Monitor",
        "NotebookEdit",
        "PushNotification",
        "Read",
        "RemoteTrigger",
        "ScheduleWakeup",
        "Skill",
        "TaskOutput",
        "TaskStop",
        "TodoWrite",
        "WebFetch",
        "WebSearch",
        "Write",
      ]);
    } finally {
      await cleanup();
    }
  });

  test("loadTemplate rejects cached data with matching _schemaVersion but missing tool input_schema", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      const cacheWithIncompleteTools = createLiveTemplate({
        _schemaVersion: 1,
        tools: [{ name: "Bash" }, { name: "Read" }],
      });

      await fs.writeFile(
        join(dir, CACHE_FILE_NAME),
        `${JSON.stringify(cacheWithIncompleteTools, null, 2)}\n`,
        "utf8",
      );

      const template = loadTemplate();

      expect(template._source).toBe("bundled");
    } finally {
      await cleanup();
    }
  });

  test("loadTemplate accepts cached MCP tools without input_schema when non-MCP tools are usable", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      const cacheWithMcpTool = createLiveTemplate({
        tools: [
          { name: "Read", input_schema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
          { name: "mcp__secret__tool", description: "Secret tool without schema" },
        ],
        tool_names: ["Read", "mcp__secret__tool"],
      });

      await fs.writeFile(
        join(dir, CACHE_FILE_NAME),
        `${JSON.stringify(cacheWithMcpTool, null, 2)}\n`,
        "utf8",
      );

      const template = loadTemplate();

      expect(template._source).toBe("cached");
      expect(template.tools.some((tool) => tool.name === "mcp__secret__tool")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("refreshLiveFingerprintAsync recaptures when cache is fresh but schema-invalid", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      const bundled = loadTemplate();

      const invalidFreshTemplate = createLiveTemplate({
        _captured: new Date().toISOString(),
        _schemaVersion: 0,
      });

      await fs.writeFile(
        join(dir, CACHE_FILE_NAME),
        `${JSON.stringify(invalidFreshTemplate, null, 2)}\n`,
        "utf8",
      );

      setFingerprintCaptureTestOverridesForTest({
        findClaudeBinary: () => "/mock/claude",
        runClaudeCapture: async ({ baseUrl }) => {
          await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
              "user-agent": "claude-code/2.1.95",
              "x-app": "cli",
            },
            body: JSON.stringify({
              system: [
                "x-anthropic-billing-header: cc_version=2.1.95.abc; cch=00000;",
                bundled.agent_identity,
                bundled.system_prompt,
              ],
              tools: bundled.tools,
            }),
          });
        },
      });

      const refreshed = await refreshLiveFingerprintAsync();

      expect(refreshed?._source).toBe("live");
      expect(refreshed?.cc_version).toBe("2.1.95");
      expect(refreshed?.system_prompt.trim()).toBe(bundled.system_prompt.trim());
    } finally {
      await cleanup();
    }
  });

  test("refreshLiveFingerprintAsync scrubs host context while preserving MCP tools in cache", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      const bundled = loadTemplate();

      const staleTemplate = createLiveTemplate({
        _captured: new Date(Date.now() - (26 * 60 * 60 * 1000)).toISOString(),
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
                bundled.agent_identity,
                `${bundled.system_prompt}\n# Environment\nOS: darwin\n# Remaining\nInspect the repo at /Users/testuser/project.`,
              ],
                tools: [
                ...bundled.tools,
                { name: "mcp__secret__tool", description: "Secret tool" },
              ],
            }),
          });
        },
      });

      const refreshed = await refreshLiveFingerprintAsync({ force: true });

      expect(refreshed).not.toBeNull();
      expect(refreshed?.tools.some((t) => t.name === "mcp__secret__tool")).toBe(true);
      expect(refreshed?.system_prompt).not.toContain("# Environment");
      expect(refreshed?.system_prompt).toContain("# Remaining");

      const cachedJson = JSON.parse(await fs.readFile(join(dir, CACHE_FILE_NAME), "utf8")) as Record<string, unknown>;
      const cachedTools = cachedJson.tools as Array<{ name: string }>;
      expect(cachedTools.some((t) => t.name === "mcp__secret__tool")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("refreshLiveFingerprintAsync rejects Agent SDK-style captures and preserves bundled fallback", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      setFingerprintCaptureTestOverridesForTest({
        findClaudeBinary: () => "/mock/claude",
        runClaudeCapture: async ({ baseUrl }) => {
          await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
              "user-agent": "claude-cli/2.1.114 (external, sdk-cli)",
              "x-app": "cli",
            },
            body: JSON.stringify({
              system: [
                "x-anthropic-billing-header: cc_version=2.1.114.bb5; cch=00000;",
                "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
                "You are an interactive agent that helps users with software engineering tasks.",
              ],
              tools: [
                { name: "Agent", input_schema: { type: "object", properties: {} } },
                { name: "AskUserQuestion", input_schema: { type: "object", properties: {} } },
              ],
            }),
          });
        },
      });

      const refreshed = await refreshLiveFingerprintAsync({ force: true });

      expect(refreshed).toBeNull();
      expect(loadTemplate()._source).toBe("bundled");
      expect(await fs.access(join(dir, CACHE_FILE_NAME)).then(() => true).catch(() => false)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("matchesBundledClaudeCodeFingerprint rejects mismatched identity or tool set", async () => {
    const { cleanup } = await setupTestEnv();

    try {
      const bundled = loadTemplate();

      expect(matchesBundledClaudeCodeFingerprint(bundled)).toBe(true);
      expect(matchesBundledClaudeCodeFingerprint({
        ...bundled,
        agent_identity: "Different agent identity",
      })).toBe(false);
      expect(matchesBundledClaudeCodeFingerprint({
        ...bundled,
        tools: [{ name: "Agent", input_schema: { type: "object", properties: {} } }],
        tool_names: ["Agent"],
      })).toBe(false);
    } finally {
      await cleanup();
    }
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
