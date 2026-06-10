export const bundledModelsDevSnapshot = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
        tool_call: true,
      },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-fable-5": {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        reasoning: true,
        tool_call: true,
        limit: { context: 1000000, output: 128000 },
      },
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        tool_call: true,
      },
    },
  },
} as const;
