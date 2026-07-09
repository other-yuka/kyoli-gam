import { writeFile } from "node:fs/promises";
import {
  captureLiveTemplateAsync,
  matchesBundledClaudeCodeFingerprint,
  prepareBundledTemplate,
} from "../dist/fingerprint-capture.js";
import {
  findUserPathHits,
  scrubTemplate,
} from "../dist/scrub-template.js";
import {
  bundledTemplatePath,
  loadBundledFingerprint,
} from "./_bundled-fingerprint.mjs";

const captureTimeoutMs = Number(process.env.FINGERPRINT_CAPTURE_TIMEOUT_MS ?? "10000");
const INTERACTIVE_ONLY_TOOL_NAMES = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

function formatToolDiff(template, pinnedTemplate) {
  const actualToolNames = template.tools.map((tool) => tool.name);
  const expectedToolNames = pinnedTemplate.tool_names;
  const diffs = [];

  for (let index = 0; index < Math.max(actualToolNames.length, expectedToolNames.length); index += 1) {
    if (actualToolNames[index] !== expectedToolNames[index]) {
      diffs.push(`${index}: ${expectedToolNames[index] ?? "(missing)"} -> ${actualToolNames[index] ?? "(missing)"}`);
    }
  }

  return diffs.join("; ");
}

function assertClaudeCodeFingerprint(template, pinnedTemplate) {
  if (matchesBundledClaudeCodeFingerprint(template, pinnedTemplate)) {
    return;
  }

  if (
    process.env.ALLOW_FINGERPRINT_SHAPE_CHANGE === "1"
    && template.agent_identity === pinnedTemplate.agent_identity
  ) {
    console.warn(
      `Allowing Claude Code fingerprint shape change after identity match; tool diff: ${formatToolDiff(template, pinnedTemplate)}`,
    );
    return;
  }

  throw new Error(
    "captured fingerprint does not match bundled Claude Code identity; refusing to overwrite fallback template",
  );
}

function preserveInteractiveOnlyTools(template, pinnedTemplate) {
  const existingToolNames = new Set(template.tools.map((tool) => tool.name));
  const preservedTools = pinnedTemplate.tools.filter(
    (tool) => INTERACTIVE_ONLY_TOOL_NAMES.has(tool.name) && !existingToolNames.has(tool.name),
  );

  if (preservedTools.length === 0) {
    return template;
  }

  const tools = [...template.tools, ...preservedTools]
    .sort((left, right) => left.name.localeCompare(right.name));

  console.warn(
    `Preserved ${preservedTools.length} interactive-only Claude Code tool(s) omitted by headless capture: ${preservedTools.map((tool) => tool.name).join(", ")}`,
  );

  return {
    ...template,
    tools,
    tool_names: tools.map((tool) => tool.name),
  };
}

function preserveBundledFablePrompt(template, pinnedTemplate) {
  const fablePrompt = pinnedTemplate.system_prompt_fable;
  if (template.system_prompt_fable || typeof fablePrompt !== "string" || fablePrompt.length === 0) {
    return template;
  }

  return {
    ...template,
    system_prompt_fable: fablePrompt,
  };
}

async function main() {
  if (process.env.ALLOW_FINGERPRINT_OVERWRITE !== "1") {
    throw new Error(
      "Refusing to overwrite bundled fingerprint without ALLOW_FINGERPRINT_OVERWRITE=1. Run pnpm run check:fingerprint-drift first and only rebake after validating a real Claude Code capture.",
    );
  }

  const live = await captureLiveTemplateAsync(captureTimeoutMs);
  if (!live) {
    throw new Error("live fingerprint capture failed; verify Claude Code is installed and authenticated");
  }

  const pinnedBundled = await loadBundledFingerprint();
  const hydrated = preserveBundledFablePrompt(
    preserveInteractiveOnlyTools(live, pinnedBundled),
    pinnedBundled,
  );
  const bundled = prepareBundledTemplate(scrubTemplate(hydrated, { dropMcpTools: true }));
  assertClaudeCodeFingerprint(bundled, pinnedBundled);
  const residualHits = findUserPathHits(JSON.stringify(bundled));
  if (residualHits.length > 0) {
    throw new Error(`scrubbed fingerprint still contains user paths: ${residualHits.join(", ")}`);
  }

  await writeFile(bundledTemplatePath, `${JSON.stringify(bundled, null, 2)}\n`, "utf8");
  console.log(`Wrote bundled fingerprint to ${bundledTemplatePath}`);
  console.log(`Captured ${bundled.tools.length} tools with ${bundled.header_order?.length ?? 0} ordered headers`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
