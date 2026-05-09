import {
  DEFAULT_CLI_VERSION,
  detectCliVersion,
  resetDetectedVersionForTest,
  setCliVersionDetectionOverridesForTest,
} from "./cli-version";
import {
  loadCCDerivedAuthProfile,
  loadCCDerivedRequestProfile,
} from "./derived-profile";
import type {
  CCDerivedAuthProfile,
  CCDerivedRequestProfile,
} from "./derived-profile";
import {
  checkCCCompat,
  captureLiveTemplateAsync,
  compareVersions,
  detectDrift,
  extractTemplate,
  loadTemplate,
  matchesBundledClaudeCodeFingerprint,
  prepareBundledTemplate,
  refreshLiveFingerprintAsync,
  resetFingerprintCaptureForTest,
  setFingerprintCaptureTestOverridesForTest,
} from "./fingerprint/capture";
import type {
  CapturedRequest,
  CompatResult,
  DriftResult,
  TemplateData,
} from "./fingerprint/capture";
import {
  loadClaudeIdentity,
  resetClaudeIdentityForTest,
  setClaudeIdentityForTest,
} from "./identity";
import type { ClaudeIdentity } from "./identity";
import {
  detectOAuthConfig,
  enumerateCCCandidates,
  FALLBACK,
  FALLBACK_FOR_DRIFT_CHECK,
  filterScopesByBinaryPresence,
  findCCBinary,
  fingerprintBinary,
  loadCache,
  normalizeAuthorizeUrl,
  resetOAuthConfigDetectionForTest,
  saveCache,
  scanBinaryForOAuthConfig,
  setOAuthConfigDetectionOverridesForTest,
} from "./oauth-config/detect";
import type { DetectedOAuthConfig } from "./oauth-config/detect";
import {
  findUserPathHits,
  removeHostContextSections,
  scrubObjectStrings,
  scrubTemplate,
  scrubText,
} from "./scrub-template";

export interface ClaudeCodeIntegration {
  loadRequestProfile: typeof loadCCDerivedRequestProfile;
  loadAuthProfile: typeof loadCCDerivedAuthProfile;
  loadIdentity: typeof loadClaudeIdentity;
  loadTemplate: typeof loadTemplate;
  detectCliVersion: typeof detectCliVersion;
  detectOAuthConfig: typeof detectOAuthConfig;
  detectDrift: typeof detectDrift;
  checkCompat: typeof checkCCCompat;
  refreshLiveFingerprint: typeof refreshLiveFingerprintAsync;
}

export const claudeCodeIntegration: ClaudeCodeIntegration = {
  loadRequestProfile: loadCCDerivedRequestProfile,
  loadAuthProfile: loadCCDerivedAuthProfile,
  loadIdentity: loadClaudeIdentity,
  loadTemplate,
  detectCliVersion,
  detectOAuthConfig,
  detectDrift,
  checkCompat: checkCCCompat,
  refreshLiveFingerprint: refreshLiveFingerprintAsync,
};

export {
  DEFAULT_CLI_VERSION,
  detectCliVersion,
  resetDetectedVersionForTest,
  setCliVersionDetectionOverridesForTest,
  loadCCDerivedAuthProfile,
  loadCCDerivedRequestProfile,
  checkCCCompat,
  captureLiveTemplateAsync,
  compareVersions,
  detectDrift,
  extractTemplate,
  loadTemplate,
  matchesBundledClaudeCodeFingerprint,
  prepareBundledTemplate,
  refreshLiveFingerprintAsync,
  resetFingerprintCaptureForTest,
  setFingerprintCaptureTestOverridesForTest,
  loadClaudeIdentity,
  resetClaudeIdentityForTest,
  setClaudeIdentityForTest,
  detectOAuthConfig,
  enumerateCCCandidates,
  FALLBACK,
  FALLBACK_FOR_DRIFT_CHECK,
  filterScopesByBinaryPresence,
  findCCBinary,
  fingerprintBinary,
  loadCache,
  normalizeAuthorizeUrl,
  resetOAuthConfigDetectionForTest,
  saveCache,
  scanBinaryForOAuthConfig,
  setOAuthConfigDetectionOverridesForTest,
  findUserPathHits,
  removeHostContextSections,
  scrubObjectStrings,
  scrubTemplate,
  scrubText,
};

export type {
  CCDerivedAuthProfile,
  CCDerivedRequestProfile,
  CapturedRequest,
  ClaudeIdentity,
  CompatResult,
  DetectedOAuthConfig,
  DriftResult,
  TemplateData,
};
