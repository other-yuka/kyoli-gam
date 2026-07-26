export async function captureLiveFingerprintSetAsync(timeoutMs, options = {}) {
  const captureLiveTemplateAsync = options.captureLiveTemplateAsync
    ?? (await import("../dist/fingerprint-capture.js")).captureLiveTemplateAsync;
  const primary = await captureLiveTemplateAsync(timeoutMs, {
    cacheControlEvidencePath: options.cacheControlEvidencePath,
  });
  if (!primary) {
    throw new Error("primary live fingerprint capture failed");
  }

  const variants = {};
  const captures = [
    ["fable", process.env.KYOLI_CLAUDE_FABLE_CAPTURE_MODEL || "fable", "Fable"],
    ["opus-5", "claude-opus-5", "Opus 5"],
    ["sonnet-5", "claude-sonnet-5", "Sonnet 5"],
  ];
  for (const [key, model, label] of captures) {
    const captured = await captureLiveTemplateAsync(timeoutMs, { model });
    if (!captured) {
      throw new Error(`${label} live fingerprint capture failed`);
    }
    if (captured.agent_identity !== primary.agent_identity || captured.cc_version !== primary.cc_version) {
      throw new Error(`${label} capture identity or Claude Code version differs from the primary capture`);
    }
    variants[key] = captured.system_prompt;
  }

  return {
    ...primary,
    system_prompt_variants: variants,
  };
}
