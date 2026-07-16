import { writeFile } from "node:fs/promises";
import {
  matchesBundledClaudeCodeFingerprint,
  prepareBundledTemplate,
} from "../dist/fingerprint-capture.js";
import {
  findUserPathHits,
  scrubTemplate,
} from "../dist/scrub-template.js";
import { loadBundledFingerprint } from "./_bundled-fingerprint.mjs";
import { captureLiveFingerprintSetAsync } from "./capture-live-fingerprint-set.mjs";
import {
  classifyLiveFingerprintDiff,
} from "./live-fingerprint-drift-utils.mjs";

const captureTimeoutMs = Number(process.env.FINGERPRINT_CAPTURE_TIMEOUT_MS ?? "10000");
const targetVersion = process.env.CLAUDE_CODE_TARGET_VERSION || null;
const captureOutputPath = process.env.KYOLI_LIVE_FINGERPRINT_OUTPUT || null;
const cacheControlEvidencePath = process.env.KYOLI_LIVE_CACHE_CONTROL_OUTPUT || null;

async function main() {
  const bundled = await loadBundledFingerprint();
  const live = await captureLiveFingerprintSetAsync(captureTimeoutMs, {
    cacheControlEvidencePath,
  });
  if (!live) {
    throw new Error("live fingerprint capture failed; verify Claude Code is installed and authenticated");
  }

  const scrubbed = scrubTemplate(live, { dropMcpTools: true });
  const normalized = prepareBundledTemplate(scrubbed);
  const residualHits = findUserPathHits(JSON.stringify(normalized));
  const result = classifyLiveFingerprintDiff(bundled, normalized, residualHits, {
    targetVersion,
  });
  const captureMatchesBundledIdentity = matchesBundledClaudeCodeFingerprint(normalized, bundled);
  const drift = result.classification !== "clean";

  if (captureOutputPath) {
    await writeFile(captureOutputPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    drift,
    classification: result.classification,
    reason: result.reason,
    checkedAt: new Date().toISOString(),
    residualUserPathHits: residualHits,
    captureMatchesBundledIdentity,
    summary: result.summary,
  }, null, 2));

  process.exitCode = result.classification === "clean"
    ? 0
    : result.classification === "shape"
      ? 2
      : result.classification === "label-only"
        ? 3
        : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
