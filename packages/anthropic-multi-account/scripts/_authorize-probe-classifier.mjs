export const REJECT_MARKER = "Invalid request format";

export function classifyAuthorizeResponse(status, location, bodyText) {
  if (typeof location === "string" && location.length > 0) {
    return "accepted";
  }

  if (status >= 400 && typeof bodyText === "string" && bodyText.includes(REJECT_MARKER)) {
    return "rejected";
  }

  return "inconclusive";
}

export function combineVerdicts(baseVerdict, expandedVerdict) {
  if (baseVerdict === "accepted" && expandedVerdict === "rejected") {
    return { drifted: false, message: "authorize scope behavior matches expected policy" };
  }

  if (baseVerdict === "accepted" && expandedVerdict === "accepted") {
    return { drifted: true, message: "expanded OAuth scopes were accepted unexpectedly" };
  }

  return { drifted: false, message: `authorize probe inconclusive (${baseVerdict}/${expandedVerdict})` };
}
