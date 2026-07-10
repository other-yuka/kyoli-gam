import {
  CLAUDE_CODE_VERSION_PATTERN,
  compareClaudeCodeVersions,
} from "./claude-code-version-utils.mjs";

const INTERACTIVE_ONLY_TOOL_NAMES = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
]);

const USER_AGENT_VERSION_PATTERN = /^(claude-cli\/)\d+\.\d+\.\d+/;

function comparableHeadlessTools(template) {
  const tools = Array.isArray(template.tools)
    ? template.tools
    : (template.tool_names ?? []).map((name) => ({ name }));
  return tools.filter((tool) => !INTERACTIVE_ONLY_TOOL_NAMES.has(tool?.name));
}

function comparableHeaderValues(template) {
  const values = { ...(template.header_values ?? {}) };
  if (typeof values["user-agent"] === "string") {
    values["user-agent"] = values["user-agent"].replace(USER_AGENT_VERSION_PATTERN, "$1<version>");
  }
  return values;
}

function userAgentVersion(template) {
  const userAgent = template.header_values?.["user-agent"];
  return typeof userAgent === "string"
    ? userAgent.match(/^claude-cli\/(\d+\.\d+\.\d+)/)?.[1] ?? null
    : null;
}

export function summarizeLiveFingerprintDiff(expected, actual) {
  const expectedTools = expected.tool_names ?? [];
  const actualTools = actual.tool_names ?? [];
  const comparableExpectedTools = comparableHeadlessTools(expected);
  const comparableActualTools = comparableHeadlessTools(actual);
  return {
    agentIdentityMatches: expected.agent_identity === actual.agent_identity,
    systemPromptMatches: expected.system_prompt === actual.system_prompt,
    systemPromptFableMatches: (expected.system_prompt_fable ?? null) === (actual.system_prompt_fable ?? null),
    toolDefinitionsMatch: JSON.stringify(comparableExpectedTools) === JSON.stringify(comparableActualTools),
    ccVersionMatches: (expected.cc_version ?? null) === (actual.cc_version ?? null),
    anthropicBetaMatches: (expected.anthropic_beta ?? null) === (actual.anthropic_beta ?? null),
    headerOrderMatches: JSON.stringify(expected.header_order ?? []) === JSON.stringify(actual.header_order ?? []),
    headerValuesMatch: JSON.stringify(comparableHeaderValues(expected)) === JSON.stringify(comparableHeaderValues(actual)),
    bodyOrderMatches: JSON.stringify(expected.body_field_order ?? []) === JSON.stringify(actual.body_field_order ?? []),
    expectedToolCount: expectedTools.length,
    actualToolCount: actualTools.length,
    interactiveOnlyExpectedToolCount: expectedTools.length - comparableExpectedTools.length,
    expectedCcVersion: expected.cc_version ?? null,
    actualCcVersion: actual.cc_version ?? null,
    expectedUserAgentVersion: userAgentVersion(expected),
    actualUserAgentVersion: userAgentVersion(actual),
    expectedHeaderOrderLength: expected.header_order?.length ?? 0,
    actualHeaderOrderLength: actual.header_order?.length ?? 0,
    expectedBodyOrder: expected.body_field_order ?? null,
    actualBodyOrder: actual.body_field_order ?? null,
  };
}

export function classifyLiveFingerprintDiff(expected, actual, residualHits = [], options = {}) {
  const summary = summarizeLiveFingerprintDiff(expected, actual);
  const expectedVersion = summary.expectedCcVersion;
  const actualVersion = summary.actualCcVersion;
  const targetVersion = options.targetVersion ?? null;

  if (residualHits.length > 0) {
    return { classification: "unsafe", reason: "scrubbed capture contains user paths", summary };
  }
  if (!summary.agentIdentityMatches) {
    return { classification: "unsafe", reason: "captured agent identity changed", summary };
  }
  if (!CLAUDE_CODE_VERSION_PATTERN.test(expectedVersion ?? "") || !CLAUDE_CODE_VERSION_PATTERN.test(actualVersion ?? "")) {
    return { classification: "unsafe", reason: "capture is missing a concrete Claude Code version", summary };
  }
  if (targetVersion && actualVersion !== targetVersion) {
    return { classification: "unsafe", reason: `captured ${actualVersion} instead of target ${targetVersion}`, summary };
  }
  if (summary.expectedUserAgentVersion !== expectedVersion) {
    return { classification: "unsafe", reason: "bundled cc_version and user-agent version disagree", summary };
  }
  if (summary.actualUserAgentVersion !== actualVersion) {
    return { classification: "unsafe", reason: "captured cc_version and user-agent version disagree", summary };
  }
  if (compareClaudeCodeVersions(actualVersion, expectedVersion) < 0) {
    return { classification: "unsafe", reason: `captured ${actualVersion} is older than bundled ${expectedVersion}`, summary };
  }

  const shapeMatches = summary.systemPromptMatches
    && summary.systemPromptFableMatches
    && summary.toolDefinitionsMatch
    && summary.anthropicBetaMatches
    && summary.headerOrderMatches
    && summary.headerValuesMatch
    && summary.bodyOrderMatches;

  if (!shapeMatches) {
    return { classification: "shape", reason: "live wire shape changed", summary };
  }
  if (!summary.ccVersionMatches) {
    return { classification: "label-only", reason: "only Claude Code version labels changed", summary };
  }
  return { classification: "clean", reason: "live fingerprint matches the bundle", summary };
}

export function createLabelOnlyFingerprintUpdate(expected, actual) {
  const result = classifyLiveFingerprintDiff(expected, actual, [], {
    targetVersion: actual.cc_version,
  });
  if (result.classification !== "label-only") {
    throw new Error(`Refusing label-only update for ${result.classification} capture: ${result.reason}`);
  }

  return {
    ...expected,
    cc_version: actual.cc_version,
    header_values: {
      ...(expected.header_values ?? {}),
      "user-agent": actual.header_values["user-agent"],
    },
  };
}
