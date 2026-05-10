import { describe, expect, test } from "vitest";
import type { TemplateData } from "../../src/claude-code/fingerprint/capture";
import bundledData from "../../src/claude-code/fingerprint/data.json";
import {
  findUserPathHits,
  removeHostContextSections,
  scrubObjectStrings,
  scrubTemplate,
  scrubText,
} from "../../src/claude-code/scrub-template";

const RAW_USER = "example-user";
const RAW_MAC_HOME = `/Users/${RAW_USER}`;
const RAW_LINUX_HOME = `/home/${RAW_USER}`;
const RAW_WINDOWS_HOME = `C:\\Users\\${RAW_USER}`;
const SCRUBBED_MAC_HOME = "/Users/user";
const SCRUBBED_LINUX_HOME = "/home/user";
const SCRUBBED_WINDOWS_HOME = "C:\\Users\\user";

function createTemplate(overrides: Partial<TemplateData> = {}): TemplateData {
  return {
    _version: 1,
    _captured: "2026-04-18T00:00:00.000Z",
    _source: "bundled",
    agent_identity: `You are Claude Code. Workspace: ${RAW_MAC_HOME}/project.`,
    system_prompt: [
      "# Environment",
      "OS: darwin",
      "# auto memory",
      `Recent path: ${RAW_MAC_HOME}/.claude.json`,
      "# Remaining",
      `Use ${RAW_MAC_HOME}/project for examples.`,
    ].join("\n"),
    tools: [
      {
        name: "Bash",
        description: `Run commands inside ${RAW_MAC_HOME}/project`,
        input_schema: {
          type: "object",
          properties: {
            cwd: {
              type: "string",
              description: `Path like ${RAW_MAC_HOME}/project`,
            },
          },
          examples: [`${RAW_MAC_HOME}/project`],
        },
      },
      {
        name: "mcp__gmail__send",
        description: `Uses ${RAW_MAC_HOME}/secrets.json`,
      },
    ],
    tool_names: ["Bash", "mcp__gmail__send"],
    header_values: {
      "x-test-path": `${RAW_MAC_HOME}/project`,
    },
    ...overrides,
  };
}

describe("removeHostContextSections", () => {
  test("removes host context sections and keeps unrelated sections", () => {
    const result = removeHostContextSections([
      "# Environment",
      "OS: darwin",
      "# section2",
      "body",
    ].join("\n"));

    expect(result).toBe(["# section2", "body"].join("\n"));
  });

  test("keeps skipping nested headings inside a removed host context section", () => {
    const result = removeHostContextSections([
      "# Environment",
      "OS: darwin",
      "## Details",
      `Path: ${RAW_MAC_HOME}/project`,
      "# Remaining",
      "body",
    ].join("\n"));

    expect(result).toBe(["# Remaining", "body"].join("\n"));
  });

  test("removes all required host context section names after normalization", () => {
    const result = removeHostContextSections([
      "# claudeMd",
      "notes",
      "# userEmail",
      "user@example.com",
      "# currentDate",
      "2026-04-18",
      "# gitStatus",
      "M file.ts",
      "# Kept",
      "body",
    ].join("\n"));

    expect(result).toBe(["# Kept", "body"].join("\n"));
  });

  test("normalizes dynamic plain-text git status blocks", () => {
    const result = removeHostContextSections([
      "Current branch: feature/private-name",
      "",
      "Main branch (you will usually use this for PRs): master",
      "",
      "Git user: Jane Doe",
      "",
      "Status:",
      "M src/index.ts",
      " M package.json",
      "",
      "Recent commits:",
      "abc123 first commit",
    ].join("\n"));

    expect(result).toBe([
      "Current branch: (dynamic)",
      "",
      "Main branch (you will usually use this for PRs): (dynamic)",
      "",
      "Git user: (dynamic)",
      "",
      "Status:",
      "(dynamic)",
      "",
      "Recent commits:",
      "abc123 first commit",
    ].join("\n"));
  });
});

describe("scrubText", () => {
  test("replaces user-specific home paths across supported platforms", () => {
    expect(scrubText(`${RAW_MAC_HOME}/project`)).toBe(`${SCRUBBED_MAC_HOME}/project`);
    expect(scrubText(`${RAW_LINUX_HOME}/project`)).toBe(`${SCRUBBED_LINUX_HOME}/project`);
    expect(scrubText(`${RAW_WINDOWS_HOME}\\project`)).toBe(`${SCRUBBED_WINDOWS_HOME}\\project`);
  });
});

describe("scrubObjectStrings", () => {
  test("scrubs nested string values inside objects and arrays", () => {
    const result = scrubObjectStrings({
      path: `${RAW_MAC_HOME}/project`,
      nested: [`${RAW_MAC_HOME}/.claude.json`, `${RAW_LINUX_HOME}/.config/claude.json`, `${RAW_WINDOWS_HOME}\\claude.json`],
    });

    expect(result).toEqual({
      path: `${SCRUBBED_MAC_HOME}/project`,
      nested: [`${SCRUBBED_MAC_HOME}/.claude.json`, `${SCRUBBED_LINUX_HOME}/.config/claude.json`, `${SCRUBBED_WINDOWS_HOME}\\claude.json`],
    });
  });
});

describe("scrubTemplate", () => {
  test("drops mcp tools, removes host context sections, and scrubs nested tool strings", () => {
    const scrubbed = scrubTemplate(createTemplate());

    expect(scrubbed.system_prompt).toBe(["# Remaining", `Use ${SCRUBBED_MAC_HOME}/project for examples.`].join("\n"));
    expect(scrubbed.tools).toHaveLength(1);
    expect(scrubbed.tools[0]?.name).toBe("Bash");
    expect(scrubbed.tool_names).toEqual(["Bash"]);
    expect(scrubbed.tools[0]).toEqual({
      name: "Bash",
      description: `Run commands inside ${SCRUBBED_MAC_HOME}/project`,
      input_schema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: `Path like ${SCRUBBED_MAC_HOME}/project`,
          },
        },
        examples: [`${SCRUBBED_MAC_HOME}/project`],
      },
    });
    expect(scrubbed.agent_identity).toContain(`${SCRUBBED_MAC_HOME}/project`);
    expect(scrubbed.header_values).toEqual({ "x-test-path": `${SCRUBBED_MAC_HOME}/project` });
  });

  test("is idempotent and leaves no residual user paths", () => {
    const once = scrubTemplate(createTemplate());
    const twice = scrubTemplate(once);

    expect(twice).toEqual(once);
    expect(findUserPathHits(JSON.stringify(twice))).toHaveLength(0);
  });
});

describe("findUserPathHits", () => {
  test("detects unsanitized user paths and ignores the scrubbed placeholder", () => {
    expect(findUserPathHits(`${RAW_MAC_HOME}/project ${SCRUBBED_MAC_HOME}/project ${RAW_LINUX_HOME}/work ${RAW_WINDOWS_HOME}\\repo`)).toEqual([
      `${RAW_MAC_HOME}/project`,
      `${RAW_LINUX_HOME}/work`,
      `${RAW_WINDOWS_HOME}\\repo`,
    ]);
  });
});

describe("bundled fingerprint-data.json", () => {
  test("contains zero residual user path hits", () => {
    const hits = findUserPathHits(JSON.stringify(bundledData));
    expect(hits).toHaveLength(0);
  });
});
