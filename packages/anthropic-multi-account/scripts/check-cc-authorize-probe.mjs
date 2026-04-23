import { createHash, randomBytes } from "node:crypto";
import { classifyAuthorizeResponse, combineVerdicts } from "./_authorize-probe-classifier.mjs";

const FALLBACK_FOR_DRIFT_CHECK = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  scopes: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
};

const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? "15000");
const BASE_SCOPES = FALLBACK_FOR_DRIFT_CHECK.scopes;
const EXPANDED_SCOPES = `${BASE_SCOPES} org:create_api_key`;

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildCodeChallenge() {
  const verifier = base64url(randomBytes(32));
  return base64url(createHash("sha256").update(verifier).digest());
}

function buildAuthorizeUrl(scopes) {
  const challenge = buildCodeChallenge();
  const url = new URL(FALLBACK_FOR_DRIFT_CHECK.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", FALLBACK_FOR_DRIFT_CHECK.clientId);
  url.searchParams.set("redirect_uri", "http://127.0.0.1:45454/callback");
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", base64url(randomBytes(12)));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

async function fetchOnce(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });

    const location = response.headers.get("location");
    const bodyText = await response.text().catch(() => "");
    return { status: response.status, location, bodyText };
  } finally {
    clearTimeout(timeout);
  }
}

async function probe(scopes) {
  const result = await fetchOnce(buildAuthorizeUrl(scopes));
  return classifyAuthorizeResponse(result.status, result.location, result.bodyText);
}

async function main() {
  const baseVerdict = await probe(BASE_SCOPES);
  const expandedVerdict = await probe(EXPANDED_SCOPES);
  const verdict = combineVerdicts(baseVerdict, expandedVerdict);

  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    baseVerdict,
    expandedVerdict,
    ...verdict,
  }, null, 2));

  process.exitCode = verdict.drifted ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
