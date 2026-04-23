import { randomUUID } from "node:crypto";
import { loadCCDerivedRequestProfile } from "../claude-code/derived-profile";

const UPSTREAM_TIMEOUT_MS = 300_000;
const STAINLESS_PACKAGE_VERSION = "0.81.0";

const BILLABLE_BETA_PREFIXES = ["extended-cache-ttl-"];

function getOsName(): string {
  const platform = process.platform;
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "MacOS";
  return "Linux";
}

export function getStaticHeaders(): Record<string, string> {
  const profile = loadCCDerivedRequestProfile();

  const headers: Record<string, string> = {
    "accept": "application/json",
    "content-type": "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": profile.userAgent,
    "x-app": profile.xApp,
    "x-stainless-arch": process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": getOsName(),
    "x-stainless-package-version": STAINLESS_PACKAGE_VERSION,
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
  };

  const { template } = profile;
  if (template.header_values) {
    for (const [key, value] of Object.entries(template.header_values)) {
      headers[key] = value;
    }
  }

  return headers;
}

export function getPerRequestHeaders(sessionId: string): Record<string, string> {
  return {
    "x-claude-code-session-id": sessionId,
    "x-client-request-id": randomUUID(),
    "anthropic-version": getAnthropicVersion(),
    "x-stainless-timeout": String(UPSTREAM_TIMEOUT_MS / 1000),
  };
}

export function getAnthropicVersion(): string {
  return loadCCDerivedRequestProfile().anthropicVersion;
}

export function getBetaHeader(): string {
  return loadCCDerivedRequestProfile().betaHeader;
}

export function orderHeadersForOutbound(
  headers: Record<string, string>,
  overrideHeaderOrder?: string[],
): Record<string, string> | Array<[string, string]> {
  const { template } = loadCCDerivedRequestProfile();
  const order = overrideHeaderOrder ?? template.header_order;

  if (!Array.isArray(order) || order.length === 0) {
    return headers;
  }

  const lowerToValue = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    lowerToValue.set(key.toLowerCase(), value);
  }

  const ordered: Array<[string, string]> = [];
  const seen = new Set<string>();

  for (const name of order) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    const value = lowerToValue.get(key);
    if (value !== undefined) {
      ordered.push([name, value]);
      seen.add(key);
    }
  }

  for (const [key, value] of Object.entries(headers)) {
    if (!seen.has(key.toLowerCase())) {
      ordered.push([key, value]);
    }
  }

  return ordered;
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
