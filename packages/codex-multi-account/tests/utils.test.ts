import { describe, test, expect, vi } from "vitest";
import type { ManagedAccount } from "../src/types";
import { createMockClient } from "./helpers";

const { getConfigMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
}));

vi.mock("../src/config", () => ({
  getConfig: getConfigMock,
}));

import { formatWaitTime, getAccountLabel, showToast } from "../src/utils";

function createAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    index: 0,
    uuid: "abcdef1234567890",
    accountId: "account-id-1",
    planTier: "",
    refreshToken: "refresh-token",
    addedAt: Date.now(),
    lastUsed: Date.now(),
    enabled: true,
    consecutiveAuthFailures: 0,
    isAuthDisabled: false,
    ...overrides,
  };
}

describe("utils", () => {
  test("formatWaitTime formats short and long durations", () => {
    expect(formatWaitTime(1)).toBe("1s");
    expect(formatWaitTime(61_000)).toBe("1m 1s");
    expect(formatWaitTime(3_600_000)).toBe("1h");
    expect(formatWaitTime(90_061_000)).toBe("1d 1h 1m");
  });

  test("getAccountLabel uses label, then email, then uuid, then index", () => {
    expect(getAccountLabel(createAccount({ label: "Primary" }))).toBe("Primary");
    expect(getAccountLabel(createAccount({ label: undefined, email: "user@example.com" }))).toBe("user@example.com");
    expect(getAccountLabel(createAccount({ label: undefined, email: undefined, uuid: "1234567890abcd" }))).toBe("Account (12345678)");
    expect(getAccountLabel(createAccount({ label: undefined, email: undefined, uuid: undefined, index: 2 }))).toBe("Account 3");
  });

  test("showToast does not call tui when quiet_mode is enabled", async () => {
    getConfigMock.mockReturnValue({ quiet_mode: true, debug: false });
    const client = createMockClient();
    const toastSpy = vi.spyOn(client.tui, "showToast");

    await showToast(client, "quiet", "info");

    expect(toastSpy).not.toHaveBeenCalled();
  });

  test("showToast calls tui when quiet_mode is disabled", async () => {
    getConfigMock.mockReturnValue({ quiet_mode: false, debug: false });
    const client = createMockClient();
    const toastSpy = vi.spyOn(client.tui, "showToast");

    await showToast(client, "hello", "success");

    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith({ body: { message: "hello", variant: "success" } });
  });

  test("showToast swallows tui errors", async () => {
    getConfigMock.mockReturnValue({ quiet_mode: false, debug: false });
    const client = createMockClient();
    client.tui.showToast = vi.fn(async () => {
      throw new Error("tui unavailable");
    });

    await expect(showToast(client, "hello", "warning")).resolves.toBeUndefined();
  });
});
