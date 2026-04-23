import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "fingerprint-capture": "src/claude-code/fingerprint/capture.ts",
    "scrub-template": "src/claude-code/scrub-template.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: "node",
  target: "node20",
  external: ["@opencode-ai/plugin"],
});
