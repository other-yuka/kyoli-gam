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

function assertClaudeCodeFingerprint(template, pinnedTemplate) {
  if (!matchesBundledClaudeCodeFingerprint(template, pinnedTemplate)) {
    throw new Error(
      "captured fingerprint does not match bundled Claude Code identity; refusing to overwrite fallback template",
    );
  }
}

async function main() {
  if (process.env.ALLOW_FINGERPRINT_OVERWRITE !== "1") {
    throw new Error(
      "Refusing to overwrite bundled fingerprint without ALLOW_FINGERPRINT_OVERWRITE=1. Run bun run check:fingerprint-drift first and only rebake after validating a real Claude Code capture.",
    );
  }

  const live = await captureLiveTemplateAsync(captureTimeoutMs);
  if (!live) {
    throw new Error("live fingerprint capture failed; verify Claude Code is installed and authenticated");
  }

  const pinnedBundled = await loadBundledFingerprint();
  const scrubbed = scrubTemplate(live, { dropMcpTools: true });
  const bundled = prepareBundledTemplate(scrubbed);
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
