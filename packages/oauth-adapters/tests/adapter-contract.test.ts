import { describe, expect, test } from "vitest";
import { openAIOAuthAdapter } from "../src/openai";
import { anthropicOAuthAdapter } from "../src/anthropic";
import type { OAuthAdapter } from "../src/types";

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
