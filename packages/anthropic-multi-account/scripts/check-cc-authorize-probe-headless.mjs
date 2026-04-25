#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { classifyAuthorizeResponse } from "./_authorize-probe-classifier.mjs";

let playwright;
try {
  playwright = await import('playwright');
} catch (error) {
  console.error(`[cc-authz-probe-headless] Playwright not installed: ${error?.message ?? String(error)}`);
  process.exit(2);
}

const FALLBACK_FOR_DRIFT_CHECK = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
};

const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? "15000");
const REDIRECT_URI = "http://127.0.0.1:45454/callback";
const PKCE_CHALLENGE_METHOD = "S256";
const EXCLUDED_EXPANDED_SCOPE = "org:create_api_key";
const INCONCLUSIVE_VERDICT = "inconclusive";
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

async function navigateOnce(browser, url) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const targetUrl = url.toString();
    let authorizeResponse;

    page.on("response", (response) => {
      if (!authorizeResponse && response.url() === targetUrl) {
        authorizeResponse = response;
      }
    });

    try {
      const response = await page.goto(targetUrl, {
        timeout: PROBE_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });

      authorizeResponse ??= response;
    } catch (error) {
      const hasRedirectLocation = typeof authorizeResponse?.headers().location === "string";
      if (!hasRedirectLocation) {
        throw error;
      }
    }

    if (!authorizeResponse) {
      throw new Error("authorize navigation produced no response");
    }

    const headers = authorizeResponse.headers();
    return {
      status: authorizeResponse.status(),
      location: headers.location ?? null,
      bodyText: await readResponseBody(authorizeResponse),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function probe(browser, scopes, label) {
  try {
    const result = await navigateOnce(browser, buildAuthorizeUrl(scopes));
    return classifyAuthorizeResponse(result.status, result.location, result.bodyText);
  } catch (error) {
    console.error(`[cc-authz-probe-headless] ${label} probe inconclusive: ${formatError(error)}`);
    return INCONCLUSIVE_VERDICT;
  }
}

function createVerdict(drifted, message) {
  return { drifted, message };
}

function summarizeVerdicts(baseVerdict, expandedVerdict) {
  if (baseVerdict === "accepted" && expandedVerdict === "rejected") {
    return createVerdict(false, "authorize scope behavior matches expected policy");
  }

  if (baseVerdict === "accepted" && expandedVerdict === "accepted") {
    return createVerdict(false, "authorize policy is more permissive than expected but pinned 6-scope remains accepted");
  }

  if (baseVerdict === "rejected") {
    return createVerdict(true, "pinned 6-scope fallback is no longer accepted");
  }

  return createVerdict(false, `authorize probe inconclusive (${baseVerdict}/${expandedVerdict})`);
}

function writeReport(baseVerdict, expandedVerdict) {
  const verdict = summarizeVerdicts(baseVerdict, expandedVerdict);
  const payload = {
    checkedAt: new Date().toISOString(),
    baseVerdict,
    expandedVerdict,
    drifted: verdict.drifted,
    message: verdict.message,
  };

  console.log(JSON.stringify(payload, null, 2));

  process.exitCode = verdict.drifted ? 1 : 0;
}

async function main() {
  let browser;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });
  } catch (error) {
    console.error(`[cc-authz-probe-headless] Chromium launch failed: ${formatError(error)}`);
    writeReport(INCONCLUSIVE_VERDICT, INCONCLUSIVE_VERDICT);
    return;
  }

  try {
    const baseVerdict = await probe(browser, BASE_SCOPES, "base");
    const expandedVerdict = await probe(browser, EXPANDED_SCOPES, "expanded");
    writeReport(baseVerdict, expandedVerdict);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
