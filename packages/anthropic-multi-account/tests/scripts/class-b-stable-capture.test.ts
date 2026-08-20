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
const postPrepareWorkflow = workflow.slice(
  workflow.indexOf("- name: Run stable Server and OpenCode contracts"),
);

describe("Class B stable capture workflow", () => {
  test("prepares Class B from the clean post-rebake capture", () => {
    expect(workflow).toContain("KYOLI_LIVE_CACHE_CONTROL_OUTPUT: live-cache-control.json");
    expect(prepareStep).toContain("capture_path=live-template-capture.json");
    expect(prepareStep).toMatch(
      /if \[ "\$class_name" = "B" \]; then[\s\S]*bake:fingerprint[\s\S]*check-live-fingerprint-drift\.mjs[\s\S]*\.classification[\s\S]*clean[\s\S]*capture_path=post-rebake-capture\.json/,
    );
    expect(prepareStep).toContain('"$capture_path"');
  });

  test("gates Class B PR work on the committed-to-rebaked result", () => {
    expect(prepareStep).toMatch(
      /committed_path=pre-rebake-fingerprint\.json[\s\S]*cp packages\/providers\/claude-code\/src\/fingerprint\/data\.json "\$committed_path"[\s\S]*bake:fingerprint/,
    );
    expect(prepareStep).toContain('"$committed_path"');
    expect(postPrepareWorkflow).toContain("steps.prepare.outputs.should_update == 'true'");
    expect(postPrepareWorkflow).toContain("steps.prepare.outputs.deferred != 'true'");
  });
});
