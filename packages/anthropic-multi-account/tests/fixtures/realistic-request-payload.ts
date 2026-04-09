import { getSystemPrompt } from "../../src/request-transform";

export function createRealisticRequestPayload() {
  return {
    system: [
      getSystemPrompt(),
      "x-anthropic-billing-header: cc_version=1.2.3; cc_entrypoint=cli; cch=00000;",
      [
        "OpenCode should inspect the repository before proposing changes.",
        "See https://opencode.ai/docs for the old tool usage notes.",
        "Keep answers concise and actionable.",
      ].join("\n\n"),
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
          { type: "tool_use", name: "search_docs" },
        ],
      },
    ],
  };
}
