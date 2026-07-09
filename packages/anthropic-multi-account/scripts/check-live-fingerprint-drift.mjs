import {
  captureLiveTemplateAsync,
  matchesBundledClaudeCodeFingerprint,
  prepareBundledTemplate,
} from "../dist/fingerprint-capture.js";
import {
  findUserPathHits,
  scrubTemplate,
} from "../dist/scrub-template.js";
import { loadBundledFingerprint } from "./_bundled-fingerprint.mjs";
import {
  hasLiveFingerprintDrift,
  summarizeLiveFingerprintDiff,
} from "./live-fingerprint-drift-utils.mjs";

const captureTimeoutMs = Number(process.env.FINGERPRINT_CAPTURE_TIMEOUT_MS ?? "10000");

async function main() {
  const bundled = await loadBundledFingerprint();
  const live = await captureLiveTemplateAsync(captureTimeoutMs);
  if (!live) {
    throw new Error("live fingerprint capture failed; verify Claude Code is installed and authenticated");
  }

  const scrubbed = scrubTemplate(live, { dropMcpTools: true });
  const normalized = prepareBundledTemplate(scrubbed);
  const residualHits = findUserPathHits(JSON.stringify(normalized));
  const summary = summarizeLiveFingerprintDiff(bundled, normalized);
  const captureMatchesBundledIdentity = matchesBundledClaudeCodeFingerprint(normalized, bundled);
  const drift = hasLiveFingerprintDrift(summary, residualHits);

  console.log(JSON.stringify({
    drift,
    checkedAt: new Date().toISOString(),
    residualUserPathHits: residualHits,
    captureMatchesBundledIdentity,
    summary,
  }, null, 2));

  process.exitCode = drift ? 2 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
