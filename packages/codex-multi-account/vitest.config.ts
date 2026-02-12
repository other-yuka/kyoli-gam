import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        inline: [
          "@opencode-ai/plugin",
          "opencode-multi-account-core",
        ],
      },
    },
  },
});
