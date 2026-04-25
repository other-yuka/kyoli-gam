import { classifyAuthorizeResponse } from "./_authorize-probe-classifier.mjs";
import {
  AUTHORIZE_PROBE_BASE_SCOPES,
  AUTHORIZE_PROBE_EXPANDED_SCOPES,
  buildAuthorizeProbePayload,
  buildAuthorizeUrl,
} from "./_authorize-probe-contract.mjs";

const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? "15000");

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
  const baseVerdict = await probe(AUTHORIZE_PROBE_BASE_SCOPES);
  const expandedVerdict = await probe(AUTHORIZE_PROBE_EXPANDED_SCOPES);
  const payload = buildAuthorizeProbePayload({ baseVerdict, expandedVerdict });

  console.log(JSON.stringify(payload, null, 2));

  process.exitCode = payload.drifted ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
