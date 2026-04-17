import { afterEach, describe, expect, test } from "bun:test";
import {
  loadCCDerivedAuthProfile,
  loadCCDerivedRequestProfile,
} from "../src/cc-derived-profile";
import {
  resetOAuthConfigDetectionForTest,
  setOAuthConfigDetectionOverridesForTest,
} from "../src/oauth-config-detect";
import { setupTestEnv } from "./helpers";

describe("cc-derived-profile", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_CLI_VERSION;
    resetOAuthConfigDetectionForTest();
  });

  test("builds request profile from fingerprint data and detected CLI version", () => {
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9";

    const profile = loadCCDerivedRequestProfile();

    expect(profile.cliVersion).toBe("9.9.9");
    expect(profile.userAgent).toBe("claude-cli/9.9.9 (external, cli)");
    expect(profile.anthropicVersion).toBe("2023-06-01");
    expect(profile.betaHeader).toContain("claude-code-20250219");
    expect(profile.apiV1BaseUrl).toBe("https://api.anthropic.com/v1");
    expect(profile.template.system_prompt.length).toBeGreaterThan(100);
  });

  test("upgrades auth profile with detected OAuth base API url", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      const ccPath = `${dir}/claude-derived-profile-bin`;
      await Bun.write(ccPath, "unique-oauth-profile-test-binary");

      setOAuthConfigDetectionOverridesForTest({
        findCCBinary: () => ccPath,
        readBinaryFile: async () => Buffer.from('BASE_API_URL:"https://api.custom.anthropic.test" CLIENT_ID:"11111111-1111-4111-8111-111111111111" CLAUDE_AI_AUTHORIZE_URL:"https://claude.com/cai/oauth/authorize" TOKEN_URL:"https://platform.claude.com/v1/oauth/token" SCOPES:"scope:a scope:b"'),
      });

      const profile = await loadCCDerivedAuthProfile();

      expect(profile.oauthConfig.baseApiUrl).toBe("https://api.custom.anthropic.test");
      expect(profile.baseApiUrl).toBe("https://api.custom.anthropic.test");
      expect(profile.apiV1BaseUrl).toBe("https://api.custom.anthropic.test/v1");
      expect(profile.oauthConfig.scopes).toBe("scope:a scope:b");
    } finally {
      await cleanup();
    }
  });

  test("request profile falls back to JSON-derived defaults when template lacks optional header defaults", () => {
    process.env.ANTHROPIC_CLI_VERSION = "1.2.3";

    const profile = loadCCDerivedRequestProfile();

    expect(profile.baseApiUrl).toBe("https://api.anthropic.com");
    expect(profile.xApp).toBe("cli");
    expect(profile.betaHeader).toContain("advisor-tool-2026-03-01");
  });
});
