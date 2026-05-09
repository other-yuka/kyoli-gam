export {
  DEFAULT_CLI_VERSION,
  detectCliVersion,
  resetDetectedVersionForTest,
  setCliVersionDetectionOverridesForTest,
} from "./cli-version";
export {
  loadCCDerivedAuthProfile,
  loadCCDerivedRequestProfile,
} from "./derived-profile";
export type {
  CCDerivedAuthProfile,
  CCDerivedRequestProfile,
} from "./derived-profile";
export {
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
export type {
  CapturedRequest,
  CompatResult,
  DriftResult,
  TemplateData,
} from "./fingerprint/capture";
export {
  loadClaudeIdentity,
  resetClaudeIdentityForTest,
  setClaudeIdentityForTest,
} from "./identity";
export type { ClaudeIdentity } from "./identity";
export {
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
export type { DetectedOAuthConfig } from "./oauth-config/detect";
export {
  findUserPathHits,
  removeHostContextSections,
  scrubObjectStrings,
  scrubTemplate,
  scrubText,
} from "./scrub-template";
