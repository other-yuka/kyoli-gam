import { describe, expect, test } from "bun:test";
import type { TemplateData } from "../src/fingerprint-capture";
import bundledData from "../src/fingerprint-data.json";
import {
  findUserPathHits,
  removeHostContextSections,
  scrubObjectStrings,
  scrubTemplate,
  scrubText,
} from "../src/scrub-template";

function createTemplate(overrides: Partial<TemplateData> = {}): TemplateData {
  return {
    _version: 1,
    _captured: "2026-04-18T00:00:00.000Z",
    _source: "bundled",
    agent_identity: "You are Claude Code. Workspace: /Users/other-yuka/project.",
    system_prompt: [
      "# Environment",
      "OS: darwin",
      "# auto memory",
      "Recent path: /Users/other-yuka/.claude.json",
      "# Remaining",
      "Use /Users/other-yuka/project for examples.",
    ].join("\n"),
    tools: [
      {
        name: "Bash",
        description: "Run commands inside /Users/other-yuka/project",
        input_schema: {
          type: "object",
          properties: {
            cwd: {
              type: "string",
              description: "Path like /Users/other-yuka/project",
            },
          },
          examples: ["/Users/other-yuka/project"],
        },
      },
      {
        name: "mcp__gmail__send",
        description: "Uses /Users/other-yuka/secrets.json",
      },
    ],
    tool_names: ["Bash", "mcp__gmail__send"],
    header_values: {
      "x-test-path": "/Users/other-yuka/project",
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
       "Path: /Users/other-yuka/project",
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
      "Current branch: main",
      "",
      "Status:",
      "M src/index.ts",
      " M package.json",
      "",
      "Recent commits:",
      "abc123 first commit",
    ].join("\n"));

    expect(result).toBe([
      "Current branch: main",
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
    expect(scrubText("/Users/other-yuka/project")).toBe("/Users/user/project");
    expect(scrubText("/home/other-yuka/project")).toBe("/home/user/project");
    expect(scrubText("C:\\Users\\other-yuka\\project")).toBe("C:\\Users\\user\\project");
  });
});

describe("scrubObjectStrings", () => {
  test("scrubs nested string values inside objects and arrays", () => {
    const result = scrubObjectStrings({
      path: "/Users/other-yuka/project",
      nested: ["/Users/other-yuka/.claude.json", "/home/other-yuka/.config/claude.json", "C:\\Users\\other-yuka\\claude.json"],
    });

    expect(result).toEqual({
      path: "/Users/user/project",
      nested: ["/Users/user/.claude.json", "/home/user/.config/claude.json", "C:\\Users\\user\\claude.json"],
    });
  });
});

describe("scrubTemplate", () => {
  test("drops mcp tools, removes host context sections, and scrubs nested tool strings", () => {
    const scrubbed = scrubTemplate(createTemplate());

    expect(scrubbed.system_prompt).toBe(["# Remaining", "Use /Users/user/project for examples."].join("\n"));
    expect(scrubbed.tools).toHaveLength(1);
    expect(scrubbed.tools[0]?.name).toBe("Bash");
    expect(scrubbed.tool_names).toEqual(["Bash"]);
    expect(scrubbed.tools[0]).toEqual({
      name: "Bash",
      description: "Run commands inside /Users/user/project",
      input_schema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Path like /Users/user/project",
          },
        },
        examples: ["/Users/user/project"],
      },
    });
    expect(scrubbed.agent_identity).toContain("/Users/user/project");
    expect(scrubbed.header_values).toEqual({ "x-test-path": "/Users/user/project" });
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
    expect(findUserPathHits("/Users/other-yuka/project /Users/user/project /home/other-yuka/work C:\\Users\\other-yuka\\repo")).toEqual([
      "/Users/other-yuka/project",
      "/home/other-yuka/work",
      "C:\\Users\\other-yuka\\repo",
    ]);
  });
});

describe("bundled fingerprint-data.json", () => {
  test("contains zero residual user path hits", () => {
    const hits = findUserPathHits(JSON.stringify(bundledData));
    expect(hits).toHaveLength(0);
  });
});
