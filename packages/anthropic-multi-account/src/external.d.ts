declare module "opencode-anthropic-auth" {
  import type { Hooks, PluginInput } from "@opencode-ai/plugin";

  export type AnthropicAuthPluginInput = Pick<PluginInput, "client"> & Record<string, unknown>;

  export const AnthropicAuthPlugin: (input: PluginInput) => Promise<Hooks>;
}
