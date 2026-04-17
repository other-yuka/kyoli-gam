import derivedDefaultsJson from "./fixtures/defaults/cc-derived-defaults.json";
import bundledTemplateJson from "./fingerprint-data.json";
import { detectCliVersion } from "./cli-version";
import { loadTemplate, type TemplateData } from "./fingerprint-capture";
import { detectOAuthConfig, type DetectedOAuthConfig } from "./oauth-config-detect";

const bundledTemplate = bundledTemplateJson as {
  anthropic_beta?: string;
  header_values?: Record<string, string>;
};
const derivedDefaults = derivedDefaultsJson as {
  request?: {
    baseApiUrl?: string;
    anthropicVersion?: string;
    xApp?: string;
    betaHeader?: string;
  };
};

const DEFAULT_BASE_API_URL = derivedDefaults.request?.baseApiUrl || "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_VERSION = bundledTemplate.header_values?.["anthropic-version"] || derivedDefaults.request?.anthropicVersion || "2023-06-01";
const DEFAULT_X_APP = bundledTemplate.header_values?.["x-app"] || derivedDefaults.request?.xApp || "cli";
const DEFAULT_BETA_HEADER = bundledTemplate.anthropic_beta || bundledTemplate.header_values?.["anthropic-beta"] || derivedDefaults.request?.betaHeader || "oauth-2025-04-20,interleaved-thinking-2025-05-14";

export interface CCDerivedRequestProfile {
  template: TemplateData;
  cliVersion: string;
  userAgent: string;
  anthropicVersion: string;
  betaHeader: string;
  xApp: string;
  baseApiUrl: string;
  apiV1BaseUrl: string;
}

export interface CCDerivedAuthProfile extends CCDerivedRequestProfile {
  oauthConfig: DetectedOAuthConfig;
}

export function loadCCDerivedRequestProfile(): CCDerivedRequestProfile {
  const template = loadTemplate();
  const cliVersion = detectCliVersion();
  const anthropicVersion = template.header_values?.["anthropic-version"] || DEFAULT_ANTHROPIC_VERSION;
  const betaHeader = template.anthropic_beta || template.header_values?.["anthropic-beta"] || DEFAULT_BETA_HEADER;
  const xApp = template.header_values?.["x-app"] || DEFAULT_X_APP;

  return {
    template,
    cliVersion,
    userAgent: `claude-cli/${cliVersion} (external, cli)`,
    anthropicVersion,
    betaHeader,
    xApp,
    baseApiUrl: DEFAULT_BASE_API_URL,
    apiV1BaseUrl: `${DEFAULT_BASE_API_URL}/v1`,
  };
}

export async function loadCCDerivedAuthProfile(): Promise<CCDerivedAuthProfile> {
  const requestProfile = loadCCDerivedRequestProfile();
  const oauthConfig = await detectOAuthConfig();
  const baseApiUrl = oauthConfig.baseApiUrl || requestProfile.baseApiUrl;

  return {
    ...requestProfile,
    oauthConfig,
    baseApiUrl,
    apiV1BaseUrl: `${baseApiUrl}/v1`,
  };
}
