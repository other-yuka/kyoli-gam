import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import * as anthropicOAuth from "../../src/oauth/anthropic-oauth";
import * as ansiModule from "../../src/auth-ux/menu/ansi";
import * as authMenuModule from "../../src/auth-ux/menu/menu";
import * as childProcess from "node:child_process";
import { handleAuthorize } from "../../src/auth-ux/handler";
import { createMockClient } from "../helpers";

describe("auth-handler", () => {
  let ttySpy: ReturnType<typeof vi.spyOn<typeof ansiModule, "isTTY">>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn<typeof console, "log">>;

  beforeEach(() => {
    ttySpy = vi.spyOn(ansiModule, "isTTY").mockReturnValue(false);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(childProcess, "exec").mockImplementation((() => {}) as unknown as typeof childProcess.exec);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("starts pi-ai flow and returns completed callback result without exposing auth url", async () => {
    const AUTH_URL = "https://pi.ai/oauth/authorize?code=test123";
    let loginSettled = false;
    const loginSpy = vi.spyOn(anthropicOAuth, "loginWithOAuth").mockImplementation(async (callbacks) => {
      callbacks.onAuth({
        url: AUTH_URL,
        instructions: "Open the link in your browser to continue.",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      loginSettled = true;
      return {
        refreshToken: "refresh-token",
        accessToken: "access-token",
        expiresAt: Date.now() + 3_600_000,
      };
    });

    const flow = await handleAuthorize(null, undefined, createMockClient());
    expect(loginSettled).toBe(true);

    expect(flow.url).toBe("");
    expect(flow.instructions).toBe("");
    expect(flow.method).toBe("auto");

    const loggedMessages = consoleLogSpy.mock.calls.map((args) => String(args[0]));
    const urlLogged = loggedMessages.some((msg) => msg.includes(AUTH_URL));
    expect(urlLogged).toBe(true);

    const callbackResult = await flow.callback();
    expect(callbackResult).toEqual({
      type: "success",
      refresh: "refresh-token",
      access: "access-token",
      expires: expect.any(Number),
    });

    const callbackResultAgain = await flow.callback();
    expect(callbackResultAgain).toEqual(callbackResult);
    expect(loginSpy).toHaveBeenCalledTimes(1);

  });

  test("syncs manager by adding account on callback success", async () => {
    const accounts: Array<{ refresh: string }> = [];
    const manager = {
      getAccounts: () => accounts,
      addAccount: vi.fn(async (auth: { refresh: string }) => {
        accounts.push({ refresh: auth.refresh });
      }),
    };

    vi.spyOn(anthropicOAuth, "loginWithOAuth").mockImplementation(async (callbacks) => {
      callbacks.onAuth({ url: "https://pi.ai/oauth/authorize?code=mgr", instructions: "Authorize to continue." });
      return {
        refreshToken: "refresh-added",
        accessToken: "access-added",
        expiresAt: Date.now() + 3_600_000,
      };
    });

    const flow = await handleAuthorize(manager as unknown as null, undefined, createMockClient());
    expect(flow.url).toBe("");
    expect(flow.instructions).toBe("");
    const callbackResult = await flow.callback();

    expect(callbackResult.type).toBe("success");
    expect(manager.addAccount).toHaveBeenCalledTimes(1);
    expect(accounts).toHaveLength(1);

  });

  test("returns failed flow when pi-ai flow cannot start", async () => {
    vi.spyOn(anthropicOAuth, "loginWithOAuth").mockRejectedValue(new Error("oauth init failed"));

    const flow = await handleAuthorize(null, undefined, createMockClient());

    expect(flow.url).toBe("");
    expect(flow.instructions).toBe("Failed to start OAuth flow");
    const callbackResult = await flow.callback();
    expect(callbackResult).toEqual({ type: "failed" });

  });

  test("check quotas persists permanent refresh failures and disables invalid account", async () => {
    ttySpy.mockReturnValue(true);

    const account = {
      index: 0,
      uuid: "dead-uuid",
      email: "dead@example.com",
      accessToken: "expired-access",
      refreshToken: "stale-refresh",
      expiresAt: Date.now() - 1_000,
      enabled: true,
      isAuthDisabled: false,
      authDisabledReason: undefined as string | undefined,
      consecutiveAuthFailures: 0,
      addedAt: Date.now() - 5_000,
      lastUsed: Date.now() - 1_000,
    };

    let accounts = [account];
    const manager = {
      getAccounts: vi.fn(() => accounts),
      setClient: vi.fn(),
      ensureValidToken: vi.fn(async () => ({ ok: false, permanent: true })),
      markAuthFailure: vi.fn(async () => {
        accounts = [{
          ...account,
          isAuthDisabled: true,
          authDisabledReason: "refresh failed permanently",
          consecutiveAuthFailures: 3,
        }];
      }),
      refresh: vi.fn(async () => {}),
    };

    vi.spyOn(authMenuModule, "showAuthMenu")
      .mockResolvedValueOnce({ type: "check-quotas" })
      .mockResolvedValueOnce({ type: "cancel" });
    const printQuotaErrorSpy = vi.spyOn(authMenuModule, "printQuotaError").mockImplementation(() => {});

    const flow = await handleAuthorize(manager as never, {}, createMockClient());

    expect(manager.ensureValidToken).toHaveBeenCalledWith("dead-uuid", expect.anything());
    expect(manager.markAuthFailure).toHaveBeenCalledWith("dead-uuid", { ok: false, permanent: true });
    expect(printQuotaErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ authDisabledReason: "refresh failed permanently" }),
      "refresh failed permanently (refresh failed)",
    );
    expect(flow.instructions).toBe("Authentication cancelled");

  });

  test("check quotas prints updated auth-disabled reason after transient refresh failure", async () => {
    ttySpy.mockReturnValue(true);

    const updatedAccount = {
      index: 0,
      uuid: "disabled-uuid",
      email: "disabled@example.com",
      accessToken: "expired-access",
      refreshToken: "stale-refresh",
      expiresAt: Date.now() - 1_000,
      enabled: true,
      isAuthDisabled: true,
      authDisabledReason: "3 consecutive auth failures",
      consecutiveAuthFailures: 3,
      addedAt: Date.now() - 5_000,
      lastUsed: Date.now() - 1_000,
    };

    const manager = {
      getAccounts: vi.fn(() => [updatedAccount]),
      setClient: vi.fn(),
      ensureValidToken: vi.fn(async () => ({ ok: false, permanent: false })),
      markAuthFailure: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
    };

    vi.spyOn(authMenuModule, "showAuthMenu")
      .mockResolvedValueOnce({ type: "check-quotas" })
      .mockResolvedValueOnce({ type: "cancel" });
    const printQuotaErrorSpy = vi.spyOn(authMenuModule, "printQuotaError").mockImplementation(() => {});

    await handleAuthorize(manager as never, {}, createMockClient());

    expect(manager.markAuthFailure).toHaveBeenCalledWith("disabled-uuid", { ok: false, permanent: false });
    expect(printQuotaErrorSpy).toHaveBeenCalledWith(updatedAccount, "3 consecutive auth failures (refresh failed)");

  });
});
