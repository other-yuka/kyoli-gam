import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import * as piAiAdapter from "../src/pi-ai-adapter";
import * as ansiModule from "../src/ui/ansi";
import * as childProcess from "node:child_process";
import { handleAuthorize } from "../src/auth-handler";
import { createMockClient } from "./helpers";

describe("auth-handler", () => {
  let ttySpy: ReturnType<typeof vi.spyOn<typeof ansiModule, "isTTY">>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn<typeof console, "log">>;
  let execSpy: ReturnType<typeof vi.spyOn<typeof childProcess, "exec">>;

  beforeEach(() => {
    ttySpy = vi.spyOn(ansiModule, "isTTY").mockReturnValue(false);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    execSpy = vi.spyOn(childProcess, "exec").mockImplementation((() => {}) as unknown as typeof childProcess.exec);
  });

  afterEach(() => {
    ttySpy.mockRestore();
    consoleLogSpy.mockRestore();
    execSpy.mockRestore();
  });

  test("starts pi-ai flow and returns completed callback result without exposing auth url", async () => {
    const AUTH_URL = "https://pi.ai/oauth/authorize?code=test123";
    let loginSettled = false;
    const loginSpy = vi.spyOn(piAiAdapter, "loginWithPiAi").mockImplementation(async (callbacks) => {
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

    loginSpy.mockRestore();
  });

  test("syncs manager by adding account on callback success", async () => {
    const accounts: Array<{ refresh: string }> = [];
    const manager = {
      getAccounts: () => accounts,
      addAccount: vi.fn(async (auth: { refresh: string }) => {
        accounts.push({ refresh: auth.refresh });
      }),
    };

    const loginSpy = vi.spyOn(piAiAdapter, "loginWithPiAi").mockImplementation(async (callbacks) => {
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

    loginSpy.mockRestore();
  });

  test("returns failed flow when pi-ai flow cannot start", async () => {
    const loginSpy = vi.spyOn(piAiAdapter, "loginWithPiAi").mockRejectedValue(new Error("oauth init failed"));

    const flow = await handleAuthorize(null, undefined, createMockClient());

    expect(flow.url).toBe("");
    expect(flow.instructions).toBe("Failed to start OAuth flow");
    const callbackResult = await flow.callback();
    expect(callbackResult).toEqual({ type: "failed" });

    loginSpy.mockRestore();
  });
});
