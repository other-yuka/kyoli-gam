import { describe, expect, test } from "vitest";
import { selectOpenCodeNativeTools } from "../../src/request/tool-adapter";

describe("tool-adapter", () => {
  test("keeps incoming OpenCode tools as the default native plugin policy", () => {
    const incomingTools = [
      { name: "question", input_schema: { type: "object", properties: { questions: { type: "array" } } } },
      { name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } },
      { name: "custom_project_tool", input_schema: { type: "object" } },
    ];

    const selected = selectOpenCodeNativeTools({
      incomingTools,
      templateTools: [
        { name: "AskUserQuestion", input_schema: { type: "object" } },
        { name: "Bash", input_schema: { type: "object" } },
        { name: "Read", input_schema: { type: "object" } },
      ],
    });

    expect(selected.reason).toBe("incoming-tools");
    expect(selected.tools).toEqual(incomingTools);
  });

  test("uses Claude Code template tools only when OpenCode sent none", () => {
    const templateTools = [
      { name: "Bash", input_schema: { type: "object" } },
      { name: "Read", input_schema: { type: "object" } },
    ];

    const selected = selectOpenCodeNativeTools({
      incomingTools: [],
      templateTools,
    });

    expect(selected.reason).toBe("template-tools");
    expect(selected.tools).toEqual(templateTools);
    expect(selected.tools).not.toBe(templateTools);
  });

  test("fills missing incoming schemas from matching template positions", () => {
    const selected = selectOpenCodeNativeTools({
      incomingTools: [
        { name: "question" },
        { name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } },
      ],
      templateTools: [
        { name: "AskUserQuestion", input_schema: { type: "object", properties: { questions: { type: "array" } } } },
        { name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } } } },
      ],
    });

    expect(selected.reason).toBe("incoming-tools");
    expect(selected.tools).toEqual([
      { name: "question", input_schema: { type: "object", properties: { questions: { type: "array" } } } },
      { name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } },
    ]);
  });

  test("does not remap unknown custom tools onto Claude Code fallback tools", () => {
    const incomingTools = [
      { name: "project_database_lookup", input_schema: { type: "object" } },
      { name: "internal_ticket_search", input_schema: { type: "object" } },
    ];

    const selected = selectOpenCodeNativeTools({
      incomingTools,
      templateTools: [
        { name: "Bash", input_schema: { type: "object" } },
        { name: "Read", input_schema: { type: "object" } },
      ],
    });

    expect(selected.reason).toBe("incoming-tools");
    expect(selected.tools.map((tool) => tool.name)).toEqual([
      "project_database_lookup",
      "internal_ticket_search",
    ]);
  });

  test("returns no tools when neither OpenCode nor the template has usable schemas", () => {
    const selected = selectOpenCodeNativeTools({
      incomingTools: [],
      templateTools: [{ name: "Bash" }, { name: "Read" }],
    });

    expect(selected.reason).toBe("no-tools");
    expect(selected.tools).toEqual([]);
  });
});
