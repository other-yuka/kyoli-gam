import { describe, expect, it } from "vitest";
import type { AccountRecord } from "../src";
import {
  listBlockedAccounts,
  listExpiredRateLimitAccounts,
  listFailedAccounts,
  listRateLimitedAccounts,
  listReadyAccounts,
  summarizeAccountStatus,
} from "../src";

describe("account status", () => {
  it("summarizes provider account states", () => {
    const accounts = [
      account({ id: "ready", provider: "codex" }),
      account({
        id: "limited",
        provider: "codex",
        rateLimitResetAt: new Date(Date.now() + 60_000).toISOString(),
        failureCount: 2,
      }),
      account({ id: "disabled", provider: "codex", enabled: false }),
      account({
        id: "reauth-required",
        provider: "claude-code",
        enabled: false,
        reauthRequiredReason: "bad token",
      }),
    ];

    expect(summarizeAccountStatus(accounts)).toMatchObject([
      {
        provider: "claude-code",
        total: 1,
        ready: 0,
        rateLimited: 0,
        disabled: 0,
        reauthRequired: 1,
        failed: 0,
      },
      {
        provider: "codex",
        total: 3,
        ready: 1,
        rateLimited: 1,
        disabled: 1,
        reauthRequired: 0,
        failed: 1,
      },
    ]);
  });

  it("lists rate-limited accounts by soonest reset", () => {
    const later = new Date(Date.now() + 120_000).toISOString();
    const sooner = new Date(Date.now() + 60_000).toISOString();

    expect(
      listRateLimitedAccounts([
        account({ id: "later", rateLimitResetAt: later }),
        account({ id: "ready" }),
        account({ id: "sooner", rateLimitResetAt: sooner }),
      ]).map((row) => row.id),
    ).toEqual(["sooner", "later"]);
  });

  it("lists ready OAuth accounts by provider and least recent use", () => {
    const older = new Date(Date.now() - 120_000).toISOString();
    const newer = new Date(Date.now() - 60_000).toISOString();

    expect(
      listReadyAccounts([
        account({ id: "newer", lastUsedAt: newer }),
        account({ id: "api", kind: "api-key" }),
        account({ id: "limited", rateLimitResetAt: new Date(Date.now() + 60_000).toISOString() }),
        account({ id: "disabled", enabled: false }),
        account({ id: "older", lastUsedAt: older }),
      ]).map((row) => row.id),
    ).toEqual(["older", "newer"]);
  });

  it("lists blocked accounts with operator-facing reasons", () => {
    expect(
      listBlockedAccounts([
        account({ id: "ready" }),
        account({ id: "disabled", enabled: false, name: "B" }),
        account({ id: "auth", reauthRequiredReason: "401", name: "A" }),
      ]),
    ).toMatchObject([
      { id: "auth", state: "reauth_required", reason: "401" },
      { id: "disabled", state: "disabled", reason: "manually disabled" },
    ]);
  });

  it("lists failed accounts by most recent error", () => {
    const older = new Date(Date.now() - 120_000).toISOString();
    const newer = new Date(Date.now() - 60_000).toISOString();

    expect(
      listFailedAccounts([
        account({ id: "ready" }),
        account({ id: "older", failureCount: 1, lastErrorAt: older }),
        account({ id: "newer", failureCount: 2, lastErrorAt: newer }),
      ]).map((row) => row.id),
    ).toEqual(["newer", "older"]);
  });

  it("lists expired rate-limit accounts without active auth blocks", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    expect(
      listExpiredRateLimitAccounts([
        account({ id: "expired", rateLimitResetAt: past }),
        account({ id: "active", rateLimitResetAt: future }),
        account({ id: "auth", rateLimitResetAt: past, reauthRequiredReason: "401" }),
      ]).map((row) => row.id),
    ).toEqual(["expired"]);
  });
});

function account(overrides: Partial<AccountRecord>): AccountRecord {
  const now = new Date().toISOString();
  return {
    id: "account",
    provider: "codex",
    kind: "oauth",
    name: "Account",
    enabled: true,
    credentials: {},
    metadata: {},
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
