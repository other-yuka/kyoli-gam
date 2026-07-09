const INTERACTIVE_ONLY_TOOL_NAMES = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

function comparableHeadlessToolNames(toolNames) {
  return toolNames.filter((toolName) => !INTERACTIVE_ONLY_TOOL_NAMES.has(toolName));
}

export function summarizeLiveFingerprintDiff(expected, actual) {
  const expectedTools = expected.tool_names ?? [];
  const actualTools = actual.tool_names ?? [];
  const comparableExpectedTools = comparableHeadlessToolNames(expectedTools);
  const comparableActualTools = comparableHeadlessToolNames(actualTools);
  return {
    agentIdentityMatches: expected.agent_identity === actual.agent_identity,
    systemPromptMatches: expected.system_prompt === actual.system_prompt,
    toolNamesMatch: JSON.stringify(comparableExpectedTools) === JSON.stringify(comparableActualTools),
    ccVersionMatches: (expected.cc_version ?? null) === (actual.cc_version ?? null),
    anthropicBetaMatches: (expected.anthropic_beta ?? null) === (actual.anthropic_beta ?? null),
    headerOrderMatches: JSON.stringify(expected.header_order ?? []) === JSON.stringify(actual.header_order ?? []),
    headerValuesMatch: JSON.stringify(expected.header_values ?? {}) === JSON.stringify(actual.header_values ?? {}),
    bodyOrderMatches: JSON.stringify(expected.body_field_order ?? []) === JSON.stringify(actual.body_field_order ?? []),
    expectedToolCount: expectedTools.length,
    actualToolCount: actualTools.length,
    interactiveOnlyExpectedToolCount: expectedTools.length - comparableExpectedTools.length,
    expectedCcVersion: expected.cc_version ?? null,
    actualCcVersion: actual.cc_version ?? null,
    expectedHeaderOrderLength: expected.header_order?.length ?? 0,
    actualHeaderOrderLength: actual.header_order?.length ?? 0,
    expectedBodyOrder: expected.body_field_order ?? null,
    actualBodyOrder: actual.body_field_order ?? null,
  };
}

export function hasLiveFingerprintDrift(summary, residualHits) {
  return residualHits.length > 0
    || !summary.agentIdentityMatches
    || !summary.systemPromptMatches
    || !summary.toolNamesMatch
    || !summary.ccVersionMatches
    || !summary.anthropicBetaMatches
    || !summary.headerOrderMatches
    || !summary.headerValuesMatch
    || !summary.bodyOrderMatches;
}
