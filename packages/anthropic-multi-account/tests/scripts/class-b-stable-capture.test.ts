import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const packageRoot = join(import.meta.dirname, "../..");
const workflow = readFileSync(
  join(packageRoot, "../../.github/workflows/claude-code-live-template-watch.yml"),
  "utf8",
);
const prepareStep = workflow.slice(
  workflow.indexOf("- name: Prepare Class A or B update"),
  workflow.indexOf("- name: Run stable Server and OpenCode contracts"),
);

describe("Class B stable capture workflow", () => {
  test("prepares Class B from the clean post-rebake capture", () => {
    expect(prepareStep).toContain("capture_path=live-template-capture.json");
    expect(prepareStep).toMatch(
      /if \[ "\$class_name" = "B" \]; then[\s\S]*bake:fingerprint[\s\S]*check-live-fingerprint-drift\.mjs[\s\S]*\.classification[\s\S]*clean[\s\S]*capture_path=post-rebake-capture\.json/,
    );
    expect(prepareStep).toContain('"$capture_path"');
  });
});
