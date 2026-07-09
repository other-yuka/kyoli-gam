import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/opencode-shared.ts", "src/fingerprint-data.ts", "src/fingerprint-capture.ts", "src/scrub-template.ts", "src/cli-version.ts"],
  format: ["esm"],
  dts: {
    compilerOptions: {
      ignoreDeprecations: "6.0",
    },
  },
  sourcemap: true,
  clean: true,
  platform: "node",
  target: "node20",
});
