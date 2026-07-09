import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@kyoli-gam/core": `${root}packages/core/src/index.ts`,
      "@kyoli-gam/gateway": `${root}packages/gateway/src/index.ts`,
      "@kyoli-gam/provider-claude-code/opencode": `${root}packages/providers/claude-code/src/opencode-shared.ts`,
      "@kyoli-gam/provider-claude-code/fingerprint-data": `${root}packages/providers/claude-code/src/fingerprint-data.ts`,
      "@kyoli-gam/provider-claude-code/fingerprint": `${root}packages/providers/claude-code/src/fingerprint-capture.ts`,
      "@kyoli-gam/provider-claude-code/scrub-template": `${root}packages/providers/claude-code/src/scrub-template.ts`,
      "@kyoli-gam/provider-claude-code/cli-version": `${root}packages/providers/claude-code/src/cli-version.ts`,
      "@kyoli-gam/provider-claude-code": `${root}packages/providers/claude-code/src/index.ts`,
      "@kyoli-gam/provider-codex-chatgpt/reset-credits": `${root}packages/providers/codex-chatgpt/src/reset-credits.ts`,
      "@kyoli-gam/provider-codex-chatgpt": `${root}packages/providers/codex-chatgpt/src/index.ts`,
      "opencode-multi-account-core": `${root}packages/multi-account-core/src/index.ts`,
    },
  },
});
