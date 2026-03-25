import { describe, expect, test } from "bun:test";
import { openAIOAuthAdapter } from "../src/adapters/openai";
import {
  ANTHROPIC_DEFAULT_BETA_FLAGS,
  ANTHROPIC_DEFAULT_CLI_VERSION,
  ANTHROPIC_DEFAULT_CLIENT_ID,
  ANTHROPIC_DEFAULT_TOKEN_URL,
  ANTHROPIC_DEFAULT_USER_AGENT,
  anthropicOAuthAdapter,
  resolveAnthropicOAuthEnv,
} from "../src/adapters/anthropic";
import type { OAuthAdapter } from "../src/adapters/types";

function assertAdapterContract(adapter: OAuthAdapter) {
  expect(adapter.id.length).toBeGreaterThan(0);
  expect(adapter.authProviderId.length).toBeGreaterThan(0);
  expect(adapter.modelDisplayName.length).toBeGreaterThan(0);
  expect(adapter.statusToolName.length).toBeGreaterThan(0);
  expect(adapter.authMethodLabel.length).toBeGreaterThan(0);
  expect(adapter.serviceLogName.length).toBeGreaterThan(0);
  expect(adapter.accountStorageFilename.length).toBeGreaterThan(0);
  expect(typeof adapter.supported).toBe("boolean");
}

describe("anthropic adapter contract", () => {
  test("satisfies all required fields", () => {
    assertAdapterContract(anthropicOAuthAdapter);
  });

  test("is supported with no unsupported reason", () => {
    expect(anthropicOAuthAdapter.supported).toBe(true);
    expect(anthropicOAuthAdapter.unsupportedReason).toBeUndefined();
  });

  test("tokenEndpoint uses platform.claude.com", () => {
    expect(anthropicOAuthAdapter.tokenEndpoint).toBe(
      "https://platform.claude.com/v1/oauth/token",
    );
  });

  test("requestBetaHeader includes all required flags", () => {
    const flags = anthropicOAuthAdapter.requestBetaHeader.split(",");
    expect(flags).toContain("claude-code-20250219");
    expect(flags).toContain("oauth-2025-04-20");
    expect(flags).toContain("interleaved-thinking-2025-05-14");
    expect(flags).toContain("prompt-caching-scope-2026-01-05");
  });

  test("oauthBetaHeader remains unchanged", () => {
    expect(anthropicOAuthAdapter.oauthBetaHeader).toBe("oauth-2025-04-20");
  });

  test("resolveAnthropicOAuthEnv applies explicit env overrides", () => {
    const resolved = resolveAnthropicOAuthEnv({
      ANTHROPIC_CLIENT_ID: "custom-client",
      ANTHROPIC_CLI_VERSION: "9.9.9",
      ANTHROPIC_USER_AGENT: "custom-agent",
      ANTHROPIC_AUTHORIZE_URL: "https://custom.example.com/authorize",
      ANTHROPIC_TOKEN_URL: "https://custom.example.com/token",
      ANTHROPIC_REDIRECT_URI: "https://custom.example.com/callback",
      ANTHROPIC_SCOPES: "scope:a scope:b",
      ANTHROPIC_BETA_FLAGS: "custom-beta-flag",
    });

    expect(resolved.clientId).toBe("custom-client");
    expect(resolved.cliVersion).toBe("9.9.9");
    expect(resolved.userAgent).toBe("custom-agent");
    expect(resolved.authorizeUrl).toBe("https://custom.example.com/authorize");
    expect(resolved.tokenUrl).toBe("https://custom.example.com/token");
    expect(resolved.redirectUri).toBe("https://custom.example.com/callback");
    expect(resolved.scopes).toBe("scope:a scope:b");
    expect(resolved.betaFlags).toBe("custom-beta-flag");
  });

  test("resolveAnthropicOAuthEnv falls back to defaults for unset or empty env", () => {
    const resolved = resolveAnthropicOAuthEnv({
      ANTHROPIC_CLIENT_ID: "",
      ANTHROPIC_CLI_VERSION: "",
      ANTHROPIC_USER_AGENT: "",
      ANTHROPIC_AUTHORIZE_URL: "",
      ANTHROPIC_TOKEN_URL: "",
      ANTHROPIC_REDIRECT_URI: "",
      ANTHROPIC_SCOPES: "",
      ANTHROPIC_BETA_FLAGS: "",
    });

    expect(resolved.clientId).toBe(ANTHROPIC_DEFAULT_CLIENT_ID);
    expect(resolved.cliVersion).toBe(ANTHROPIC_DEFAULT_CLI_VERSION);
    expect(resolved.userAgent).toBe(ANTHROPIC_DEFAULT_USER_AGENT);
    expect(resolved.tokenUrl).toBe(ANTHROPIC_DEFAULT_TOKEN_URL);
    expect(resolved.betaFlags).toBe(ANTHROPIC_DEFAULT_BETA_FLAGS);
  });

  test("resolveAnthropicOAuthEnv composes user agent from CLI version when user-agent is unset", () => {
    const resolved = resolveAnthropicOAuthEnv({
      ANTHROPIC_CLI_VERSION: "3.2.1",
    });

    expect(resolved.cliVersion).toBe("3.2.1");
    expect(resolved.userAgent).toBe("claude-cli/3.2.1 (external, cli)");
  });

  test("resolveAnthropicOAuthEnv prioritizes ANTHROPIC_USER_AGENT over CLI version composition", () => {
    const resolved = resolveAnthropicOAuthEnv({
      ANTHROPIC_CLI_VERSION: "3.2.1",
      ANTHROPIC_USER_AGENT: "my-ua",
    });

    expect(resolved.userAgent).toBe("my-ua");
  });

  test("resolveAnthropicOAuthEnv replaces default beta flags when ANTHROPIC_BETA_FLAGS is set", () => {
    const resolved = resolveAnthropicOAuthEnv({
      ANTHROPIC_BETA_FLAGS: "beta-only",
    });

    expect(resolved.betaFlags).toBe("beta-only");
    expect(resolved.betaFlags).not.toContain("oauth-2025-04-20");
  });
});

describe("openai adapter contract", () => {
  test("satisfies all required fields", () => {
    assertAdapterContract(openAIOAuthAdapter);
  });

  test("is supported with valid oauth config", () => {
    expect(openAIOAuthAdapter.supported).toBe(true);
    expect(openAIOAuthAdapter.unsupportedReason).toBeUndefined();
    expect(openAIOAuthAdapter.oauthClientId.length).toBeGreaterThan(0);
    expect(openAIOAuthAdapter.tokenEndpoint.length).toBeGreaterThan(0);
  });
});
