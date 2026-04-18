import {
  captureLiveTemplateAsync,
  prepareBundledTemplate,
} from "../dist/fingerprint-capture.js";
import {
  findUserPathHits,
  scrubTemplate,
} from "../dist/scrub-template.js";
import { loadBundledFingerprint } from "./_bundled-fingerprint.mjs";

const captureTimeoutMs = Number(process.env.FINGERPRINT_CAPTURE_TIMEOUT_MS ?? "10000");

function summarizeDiff(expected, actual) {
  const expectedTools = expected.tool_names ?? [];
  const actualTools = actual.tool_names ?? [];
  return {
    agentIdentityMatches: expected.agent_identity === actual.agent_identity,
    systemPromptMatches: expected.system_prompt === actual.system_prompt,
    toolNamesMatch: JSON.stringify(expectedTools) === JSON.stringify(actualTools),
    expectedToolCount: expectedTools.length,
    actualToolCount: actualTools.length,
    expectedCcVersion: expected.cc_version ?? null,
    actualCcVersion: actual.cc_version ?? null,
    expectedHeaderOrderLength: expected.header_order?.length ?? 0,
    actualHeaderOrderLength: actual.header_order?.length ?? 0,
    expectedBodyOrder: expected.body_field_order ?? null,
    actualBodyOrder: actual.body_field_order ?? null,
  };
}

async function main() {
  const bundled = await loadBundledFingerprint();
  const live = await captureLiveTemplateAsync(captureTimeoutMs);
  if (!live) {
    throw new Error("live fingerprint capture failed; verify Claude Code is installed and authenticated");
  }

  const scrubbed = scrubTemplate(live, { dropMcpTools: true });
  const normalized = prepareBundledTemplate(scrubbed);
  const residualHits = findUserPathHits(JSON.stringify(normalized));
  const summary = summarizeDiff(bundled, normalized);
  const drift = residualHits.length > 0
    || !summary.agentIdentityMatches
    || !summary.systemPromptMatches
    || !summary.toolNamesMatch;

  console.log(JSON.stringify({
    drift,
    checkedAt: new Date().toISOString(),
    residualUserPathHits: residualHits,
    summary,
  }, null, 2));

  process.exitCode = drift ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
