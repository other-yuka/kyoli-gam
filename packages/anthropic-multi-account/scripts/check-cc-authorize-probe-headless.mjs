#!/usr/bin/env node
import { classifyAuthorizeResponse } from "./_authorize-probe-classifier.mjs";
import {
  AUTHORIZE_PROBE_BASE_SCOPES,
  AUTHORIZE_PROBE_EXPANDED_SCOPES,
  buildAuthorizeProbePayload,
  buildAuthorizeUrl,
} from "./_authorize-probe-contract.mjs";

let playwright;
try {
  playwright = await import('playwright');
} catch (error) {
  console.error(`[cc-authz-probe-headless] Playwright not installed: ${error?.message ?? String(error)}`);
  process.exit(2);
}

const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? "15000");
const INCONCLUSIVE_VERDICT = "inconclusive";

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

function writeReport(baseVerdict, expandedVerdict) {
  const payload = buildAuthorizeProbePayload({ baseVerdict, expandedVerdict });

  console.log(JSON.stringify(payload, null, 2));

  process.exitCode = payload.drifted ? 1 : 0;
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
    const baseVerdict = await probe(browser, AUTHORIZE_PROBE_BASE_SCOPES, "base");
    const expandedVerdict = await probe(browser, AUTHORIZE_PROBE_EXPANDED_SCOPES, "expanded");
    writeReport(baseVerdict, expandedVerdict);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
