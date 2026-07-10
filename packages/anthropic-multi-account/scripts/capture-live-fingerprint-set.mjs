import {
  captureLiveTemplateAsync,
} from "../dist/fingerprint-capture.js";

export async function captureLiveFingerprintSetAsync(timeoutMs) {
  const primary = await captureLiveTemplateAsync(timeoutMs);
  if (!primary) {
    throw new Error("primary live fingerprint capture failed");
  }

  const fable = await captureLiveTemplateAsync(timeoutMs, {
    model: process.env.KYOLI_CLAUDE_FABLE_CAPTURE_MODEL || "fable",
  });
  if (!fable) {
    throw new Error("Fable live fingerprint capture failed");
  }
  if (fable.agent_identity !== primary.agent_identity || fable.cc_version !== primary.cc_version) {
    throw new Error("Fable capture identity or Claude Code version differs from the primary capture");
  }

  return {
    ...primary,
    system_prompt_fable: fable.system_prompt,
  };
}
