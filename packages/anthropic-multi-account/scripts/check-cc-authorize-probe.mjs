import { createHash, randomBytes } from "node:crypto";
import { classifyAuthorizeResponse, combineVerdicts } from "./_authorize-probe-classifier.mjs";

const FALLBACK_FOR_DRIFT_CHECK = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
};

const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? "15000");
const REDIRECT_URI = "http://127.0.0.1:45454/callback";
const PKCE_CHALLENGE_METHOD = "S256";
const EXCLUDED_EXPANDED_SCOPE = "org:create_api_key";
const BASE_SCOPES = FALLBACK_FOR_DRIFT_CHECK.scopes;
const EXPANDED_SCOPES = BASE_SCOPES
  .split(" ")
  .filter((scope) => scope !== EXCLUDED_EXPANDED_SCOPE)
  .join(" ");

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createPkceChallenge() {
  const verifier = base64url(randomBytes(32));
  return base64url(createHash("sha256").update(verifier).digest());
}

function buildAuthorizeUrl(scopes) {
  const challenge = createPkceChallenge();
  const url = new URL(FALLBACK_FOR_DRIFT_CHECK.authorizeUrl);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", FALLBACK_FOR_DRIFT_CHECK.clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", base64url(randomBytes(12)));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", PKCE_CHALLENGE_METHOD);

  return url;
}

async function readResponseBody(response) {
  return response.text().catch(() => "");
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

    return {
      status: response.status,
      location: response.headers.get("location"),
      bodyText: await readResponseBody(response),
    };
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
  const payload = {
    checkedAt: new Date().toISOString(),
    baseVerdict,
    expandedVerdict,
    ...verdict,
  };

  console.log(JSON.stringify(payload, null, 2));

  process.exitCode = verdict.drifted ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
