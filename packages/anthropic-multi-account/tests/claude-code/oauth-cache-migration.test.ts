import { afterEach, describe, expect, test } from "bun:test";
import { loadCache, resetOAuthConfigDetectionForTest } from "../../src/claude-code/oauth-config/detect";
import { setupTestEnv } from "../helpers";

const DEFAULT_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_BASE_API_URL = "https://api.anthropic.com";
const CANONICAL_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const LEGACY_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

afterEach(() => {
  resetOAuthConfigDetectionForTest();
});

describe("oauth cache migration", () => {
  test("drops legacy 5-scope cache entries while preserving canonical 6-scope entries", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      await Bun.write(`${dir}/anthropic-oauth-config-cache.json`, JSON.stringify({
        entries: {
          legacy: {
            clientId: "11111111-1111-4111-8111-111111111111",
            authorizeUrl: DEFAULT_AUTHORIZE_URL,
            tokenUrl: DEFAULT_TOKEN_URL,
            scopes: LEGACY_SCOPES,
            baseApiUrl: DEFAULT_BASE_API_URL,
          },
          canonical: {
            clientId: "11111111-1111-4111-8111-111111111111",
            authorizeUrl: DEFAULT_AUTHORIZE_URL,
            tokenUrl: DEFAULT_TOKEN_URL,
            scopes: CANONICAL_SCOPES,
            baseApiUrl: DEFAULT_BASE_API_URL,
          },
        },
        savedAt: Date.now(),
      }, null, 2));

      const entries = await loadCache();

      expect(entries.legacy).toBeUndefined();
      expect(entries.canonical?.scopes).toBe(CANONICAL_SCOPES);
    } finally {
      await cleanup();
    }
  });

  test("drops cache entries polluted with Google Cloud scope URLs", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      await Bun.write(`${dir}/anthropic-oauth-config-cache.json`, JSON.stringify({
        entries: {
          polluted: {
            clientId: "11111111-1111-4111-8111-111111111111",
            authorizeUrl: DEFAULT_AUTHORIZE_URL,
            tokenUrl: DEFAULT_TOKEN_URL,
            scopes: "org:create_api_key user:profile https://www.googleapis.com/auth/cloud-platform user:inference",
            baseApiUrl: DEFAULT_BASE_API_URL,
          },
        },
        savedAt: Date.now(),
      }, null, 2));

      const entries = await loadCache();

      expect(entries.polluted).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("drops cache entries missing org:create_api_key even when other OAuth fields are valid", async () => {
    const { dir, cleanup } = await setupTestEnv();

    try {
      await Bun.write(`${dir}/anthropic-oauth-config-cache.json`, JSON.stringify({
        entries: {
          missingScope: {
            clientId: "11111111-1111-4111-8111-111111111111",
            authorizeUrl: DEFAULT_AUTHORIZE_URL,
            tokenUrl: DEFAULT_TOKEN_URL,
            scopes: "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
            baseApiUrl: DEFAULT_BASE_API_URL,
          },
        },
        savedAt: Date.now(),
      }, null, 2));

      const entries = await loadCache();

      expect(entries.missingScope).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
