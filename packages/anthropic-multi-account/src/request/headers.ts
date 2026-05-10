import {
  createClaudeCodePerRequestHeaders,
  createClaudeCodeStaticHeaders,
  orderClaudeCodeHeadersForOutbound,
} from "../../../providers/claude-code/src/opencode-shared";
import { claudeCodeIntegration } from "../claude-code";

const STAINLESS_PACKAGE_VERSION = "0.81.0";

const BILLABLE_BETA_PREFIXES = ["extended-cache-ttl-"];

export function getStaticHeaders(): Record<string, string> {
  const profile = claudeCodeIntegration.loadRequestProfile();
  return createClaudeCodeStaticHeaders({
    headerValues: profile.template.header_values,
    packageVersion: STAINLESS_PACKAGE_VERSION,
    userAgent: profile.userAgent,
    xApp: profile.xApp,
  });
}

export function getPerRequestHeaders(sessionId: string): Record<string, string> {
  return createClaudeCodePerRequestHeaders({
    anthropicVersion: getAnthropicVersion(),
    sessionId,
  });
}

export function getAnthropicVersion(): string {
  return claudeCodeIntegration.loadRequestProfile().anthropicVersion;
}

export function getBetaHeader(): string {
  return claudeCodeIntegration.loadRequestProfile().betaHeader;
}

export function orderHeadersForOutbound(
  headers: Record<string, string>,
  overrideHeaderOrder?: string[],
): Record<string, string> | Array<[string, string]> {
  const { template } = claudeCodeIntegration.loadRequestProfile();
  return orderClaudeCodeHeadersForOutbound(headers, overrideHeaderOrder ?? template.header_order);
}

export function filterBillableBetas(betas: string): string {
  return betas
    .split(",")
    .map((beta) => beta.trim())
    .filter(
      (beta) =>
        beta.length > 0
        && !BILLABLE_BETA_PREFIXES.some((prefix) => beta.startsWith(prefix)),
    )
    .join(",");
}
