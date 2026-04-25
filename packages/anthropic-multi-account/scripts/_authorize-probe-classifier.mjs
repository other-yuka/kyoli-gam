export const REJECT_MARKER = "Invalid request format";

const MATCHES_EXPECTED_POLICY_MESSAGE = "authorize scope behavior matches expected policy";
const MORE_PERMISSIVE_POLICY_MESSAGE = "authorize policy is more permissive than expected but pinned 6-scope remains accepted";
const PINNED_FALLBACK_REJECTED_MESSAGE = "pinned 6-scope fallback is no longer accepted";

function createVerdict(drifted, message) {
  return { drifted, message };
}

export function classifyAuthorizeResponse(status, location, bodyText) {
  const hasRedirectLocation = typeof location === "string" && location.length > 0;
  if (hasRedirectLocation) {
    return "accepted";
  }

  const hasRejectMarker = typeof bodyText === "string" && bodyText.includes(REJECT_MARKER);
  if (status >= 400 && hasRejectMarker) {
    return "rejected";
  }

  return "inconclusive";
}

export function combineVerdicts(baseVerdict, expandedVerdict) {
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
