import { beforeEach, describe, expect, test, vi } from "vitest";

const { captureLiveTemplateAsync } = vi.hoisted(() => ({
  captureLiveTemplateAsync: vi.fn(),
}));

vi.mock("../../dist/fingerprint-capture.js", () => ({
  captureLiveTemplateAsync,
}));

const {
  captureLiveFingerprintSetAsync,
} = await import("../../scripts/capture-live-fingerprint-set.mjs");

function template(prompt: string) {
  return {
    agent_identity: "Claude Code",
    cc_version: "2.1.206",
    system_prompt: prompt,
  };
}

beforeEach(() => {
  captureLiveTemplateAsync.mockReset();
});

describe("capture live fingerprint set", () => {
  test("identifies a primary capture failure", async () => {
    captureLiveTemplateAsync.mockResolvedValueOnce(null);

    await expect(captureLiveFingerprintSetAsync(10_000))
      .rejects.toThrow("primary live fingerprint capture failed");
  });

  test("identifies a Fable capture failure", async () => {
    captureLiveTemplateAsync
      .mockResolvedValueOnce(template("primary"))
      .mockResolvedValueOnce(null);

    await expect(captureLiveFingerprintSetAsync(10_000))
      .rejects.toThrow("Fable live fingerprint capture failed");
  });

  test("combines matching primary and Fable captures", async () => {
    captureLiveTemplateAsync
      .mockResolvedValueOnce(template("primary"))
      .mockResolvedValueOnce(template("fable"));

    await expect(captureLiveFingerprintSetAsync(10_000)).resolves.toMatchObject({
      system_prompt: "primary",
      system_prompt_fable: "fable",
    });
  });
});
