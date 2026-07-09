import { describe, expect, test } from "vitest";
import {
  classifyDriftReport,
} from "../../scripts/auto-draft-static-oauth-drift-fix.mjs";

describe("auto-draft static OAuth drift fix", () => {
  test("keeps compat.range drift manual because range follows rebaked fingerprint data", () => {
    const result = classifyDriftReport({
      drift: true,
      ccVersion: "2.1.162",
      items: [{ category: "compat.range" }],
    });

    expect(result.shouldCreatePr).toBe(false);
    expect(result.shouldOpenIssue).toBe(true);
    expect(result.reason).toContain("rebake");
  });

  test("keeps OAuth drift human-gated", () => {
    const result = classifyDriftReport({
      drift: true,
      ccVersion: "2.1.162",
      items: [{ category: "compat.range" }, { category: "oauth.clientId" }],
    });

    expect(result.shouldCreatePr).toBe(false);
    expect(result.shouldOpenIssue).toBe(true);
    expect(result.reason).toContain("manual drift review");
  });

});
