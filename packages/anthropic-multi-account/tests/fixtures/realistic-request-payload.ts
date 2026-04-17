export function createRealisticRequestPayload() {
  return {
    system: [
      "OpenCode should inspect the repository before proposing changes.",
      "x-anthropic-billing-header: cc_version=1.2.3; cc_entrypoint=cli; cch=00000;",
    ],
    tools: [
      { name: "search_docs" },
      { name: "run_command" },
    ],
    messages: [
      {
        role: "user",
        content: "Please debug the failing request.",
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "internal" },
          { type: "tool_use", name: "search_docs" },
        ],
      },
    ],
  };
}
