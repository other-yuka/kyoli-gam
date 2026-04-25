export const REJECT_MARKER = "Invalid request format";

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
