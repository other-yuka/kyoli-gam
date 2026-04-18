import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/fingerprint-capture.ts", "src/scrub-template.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: "node",
  target: "node20",
  external: ["@opencode-ai/plugin"],
});
