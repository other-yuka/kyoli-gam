export function createRealisticRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-haiku-4-5",
    system: [
      "OpenCode should inspect the repository before proposing changes.",
      "<system-reminder>Remove this orchestration note.</system-reminder>",
      "x-anthropic-billing-header: cc_version=1.2.3; cc_entrypoint=cli; cch=00000;",
    ],
    tool_choice: { type: "tool", name: "run_command" },
    tools: [
      {
        name: "search_docs",
        description: "Search local docs",
        input_schema: { type: "object", properties: { query: { type: "string" } } },
      },
      {
        name: "run_command",
        description: "Run a shell command",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
      {
        name: "project_database_lookup",
        description: "Query project metadata",
        input_schema: { type: "object", properties: { key: { type: "string" } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Please debug the failing OpenCode request using /tmp/kyoli/opencode-state.",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "internal" },
          {
            type: "tool_use",
            id: "toolu_search_1",
            name: "search_docs",
            input: { query: "request failure" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_search_1",
            content: "Found <env>secret</env> retry guidance.",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
    ...overrides,
  };
}
