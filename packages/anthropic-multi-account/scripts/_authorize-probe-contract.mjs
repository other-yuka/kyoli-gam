import { createHash, randomBytes } from "node:crypto";

export const AUTHORIZE_PROBE_CONFIG = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
};

export const AUTHORIZE_PROBE_REDIRECT_URI = "http://127.0.0.1:45454/callback";
export const AUTHORIZE_PROBE_PKCE_CHALLENGE_METHOD = "S256";
export const AUTHORIZE_PROBE_EXCLUDED_EXPANDED_SCOPE = "org:create_api_key";
export const AUTHORIZE_PROBE_BASE_SCOPES = AUTHORIZE_PROBE_CONFIG.scopes;
export const AUTHORIZE_PROBE_EXPANDED_SCOPES = deriveExpandedScopes(AUTHORIZE_PROBE_BASE_SCOPES);

const MATCHES_EXPECTED_POLICY_MESSAGE = "authorize scope behavior matches expected policy";
const MORE_PERMISSIVE_POLICY_MESSAGE = "authorize policy is more permissive than expected but pinned 6-scope remains accepted";
const PINNED_FALLBACK_REJECTED_MESSAGE = "pinned 6-scope fallback is no longer accepted";

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createPkceChallenge() {
  const verifier = base64url(randomBytes(32));
  return base64url(createHash("sha256").update(verifier).digest());
}

function createVerdict(drifted, message) {
  return { drifted, message };
}

export function deriveExpandedScopes(scopes) {
  return scopes
    .split(" ")
    .filter((scope) => scope !== AUTHORIZE_PROBE_EXCLUDED_EXPANDED_SCOPE)
    .join(" ");
}

export function buildAuthorizeUrl(scopes, options = {}) {
  const url = new URL(AUTHORIZE_PROBE_CONFIG.authorizeUrl);
  const state = options.state ?? base64url(randomBytes(32));
  const codeChallenge = options.codeChallenge ?? createPkceChallenge();

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", AUTHORIZE_PROBE_CONFIG.clientId);
  url.searchParams.set("redirect_uri", AUTHORIZE_PROBE_REDIRECT_URI);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", AUTHORIZE_PROBE_PKCE_CHALLENGE_METHOD);

  return url;
}

export function summarizeAuthorizeProbeVerdicts(baseVerdict, expandedVerdict) {
  if (baseVerdict === "accepted" && expandedVerdict === "rejected") {
    return createVerdict(false, MATCHES_EXPECTED_POLICY_MESSAGE);
  }

  if (baseVerdict === "accepted" && expandedVerdict === "accepted") {
    return createVerdict(false, MORE_PERMISSIVE_POLICY_MESSAGE);
  }

  if (baseVerdict === "rejected") {
    return createVerdict(true, PINNED_FALLBACK_REJECTED_MESSAGE);
  }

  return createVerdict(false, `authorize probe inconclusive (${baseVerdict}/${expandedVerdict})`);
}

export function buildAuthorizeProbePayload({ checkedAt = new Date().toISOString(), baseVerdict, expandedVerdict }) {
  const verdict = summarizeAuthorizeProbeVerdicts(baseVerdict, expandedVerdict);

  return {
    checkedAt,
    baseVerdict,
    expandedVerdict,
    drifted: verdict.drifted,
    message: verdict.message,
  };
}
