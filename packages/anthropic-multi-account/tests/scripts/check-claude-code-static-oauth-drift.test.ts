import { describe, expect, test } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(packageRoot, "scripts/check-claude-code-static-oauth-drift.mjs");

const {
  buildStaticDriftItems,
  PINNED_OAUTH,
  scanBinaryForOAuthConfig,
} = await import(scriptPath);

describe("check-claude-code-static-oauth-drift contract", () => {
  test("emits compat.range when Claude Code is newer than maxTested", () => {
    const items = buildStaticDriftItems({
      ccVersion: "2.1.140",
      scanned: PINNED_OAUTH,
      maxTested: "2.1.139",
    });

    expect(items).toMatchObject([
      {
        category: "compat.range",
        severity: "medium",
      },
    ]);
  });

  test("alerts instead of treating an npm rollback as clean", () => {
    const items = buildStaticDriftItems({
      ccVersion: "2.1.138",
      scanned: PINNED_OAUTH,
      maxTested: "2.1.139",
    });

    expect(items).toMatchObject([
      {
        category: "compat.rollback",
        severity: "high",
      },
    ]);
  });

  test("emits oauth drift categories for changed OAuth config", () => {
    const items = buildStaticDriftItems({
      ccVersion: "2.1.139",
      maxTested: "2.1.139",
      scanned: {
        clientId: "11111111-1111-4111-8111-111111111111",
        authorizeUrl: "https://claude.example/oauth/authorize",
        tokenUrl: "https://platform.example/v1/oauth/token",
        baseApiUrl: "https://api.anthropic.com",
      },
    });

    expect(items.map((item: { category: string }) => item.category)).toEqual([
      "oauth.clientId",
      "oauth.authorizeUrl",
      "oauth.tokenUrl",
    ]);
  });

  test("emits scanner.layout when no scan target is available", () => {
    const items = buildStaticDriftItems({
      scannerLayoutMessage: "No scannable CC binary found.",
      scannerLayoutExtra: { platform: "linux-x64" },
    });

    expect(items).toEqual([
      {
        category: "scanner.layout",
        severity: "high",
        message: "No scannable CC binary found.",
        platform: "linux-x64",
      },
    ]);
  });

  test("emits scanner when regex extraction fails", () => {
    const items = buildStaticDriftItems({
      scanned: null,
    });

    expect(items).toMatchObject([
      {
        category: "scanner",
        severity: "high",
      },
    ]);
  });

  test("extracts OAuth config from representative binary text", () => {
    const scanned = scanBinaryForOAuthConfig(Buffer.from(`
      BASE_API_URL: "https://api.anthropic.com",
      CLIENT_ID: "${PINNED_OAUTH.clientId}",
      CLAUDE_AI_AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize",
      TOKEN_URL: "${PINNED_OAUTH.tokenUrl}",
    `));

    expect(scanned).toMatchObject({
      ...PINNED_OAUTH,
      baseApiUrl: "https://api.anthropic.com",
    });
  });

  test("extracts OAuth config when binaries use named client-id fields", () => {
    const scanned = scanBinaryForOAuthConfig(Buffer.from(`
      BASE_API_URL: "https://api.anthropic.com",
      CONSOLE_AUTHORIZE_URL: "https://platform.claude.com/oauth/authorize",
      CLAUDE_AI_AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize",
      TOKEN_URL: "${PINNED_OAUTH.tokenUrl}",
      DESIGN_CLIENT_ID: "${PINNED_OAUTH.clientId}",
    `));

    expect(scanned).toMatchObject({
      ...PINNED_OAUTH,
      baseApiUrl: "https://api.anthropic.com",
    });
  });
});
