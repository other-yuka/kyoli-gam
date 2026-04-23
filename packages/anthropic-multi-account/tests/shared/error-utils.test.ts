import { describe, expect, test, vi } from "bun:test";
import { enrich429, sanitizeError } from "../../src/shared/error-utils";

describe("error-utils", () => {
  test("sanitizeError redacts sk-ant tokens, JWTs, and bearer tokens", () => {
    const sanitized = sanitizeError(
      "Failed: sk-ant-abc123-xyz eyJheader.eyJpayload.signature Bearer secret-token",
    );

    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).toContain("[REDACTED_JWT]");
    expect(sanitized).toContain("Bearer [REDACTED]");
    expect(sanitized).not.toContain("sk-ant-");
    expect(sanitized).not.toContain("eyJheader.eyJpayload.signature");
    expect(sanitized).not.toContain("secret-token");
  });

  test("enrich429 upgrades generic rate-limit payloads with header details", () => {
    const nowMs = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);

    try {
      const enriched = enrich429(
        JSON.stringify({ error: { message: "Error" } }),
        new Headers({
          "anthropic-ratelimit-unified-representative-claim": "workspace",
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-5h-utilization": "0.85",
          "anthropic-ratelimit-unified-7d-utilization": "0.40",
          "anthropic-ratelimit-unified-reset": String(Math.floor((nowMs + 30 * 60 * 1000) / 1000)),
        }),
      );

      const parsed = JSON.parse(enriched) as { error?: { message?: string } };

      expect(parsed.error?.message).toContain("Rate limited (rejected)");
      expect(parsed.error?.message).toContain("Limiting window: workspace");
      expect(parsed.error?.message).toContain("5h utilization: 85%");
      expect(parsed.error?.message).toContain("7d utilization: 40%");
      expect(parsed.error?.message).toContain("resets in 30m");
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  test("enrich429 leaves non-generic payloads unchanged", () => {
    const original = JSON.stringify({ error: { message: "Already specific" } });

    expect(enrich429(original, new Headers({ "anthropic-ratelimit-unified-status": "rejected" }))).toBe(original);
    expect(enrich429("not-json", new Headers())).toBe("not-json");
  });
});
