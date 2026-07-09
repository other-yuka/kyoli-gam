import { describe, expect, it } from "vitest";
import {
  getOpenBrowserCommand,
  readOAuthBrowserMode,
  shouldOpenOAuthBrowser,
} from "../src/oauth-browser";

describe("OAuth browser UX", () => {
  it("opens with platform-native commands without shell URL parsing", () => {
    const url = "https://auth.openai.com/oauth/authorize?client_id=a&scope=b";

    expect(getOpenBrowserCommand(url, "darwin")).toEqual({
      command: "open",
      args: [url],
    });
    expect(getOpenBrowserCommand(url, "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    expect(getOpenBrowserCommand(url, "linux")).toEqual({
      command: "xdg-open",
      args: [url],
    });
  });

  it("supports manual and headless modes from flags and env", () => {
    expect(readOAuthBrowserMode(["kyoli", "login", "codex"])).toBe("browser");
    expect(readOAuthBrowserMode(["kyoli", "login", "codex", "--manual"])).toBe("manual");
    expect(readOAuthBrowserMode(["kyoli", "login", "codex", "--no-browser"])).toBe("manual");
    expect(readOAuthBrowserMode(["kyoli", "login", "codex", "--headless"])).toBe("headless");
    expect(readOAuthBrowserMode(["kyoli"], { KYOLI_OAUTH_BROWSER: "0" })).toBe("manual");
    expect(readOAuthBrowserMode(["kyoli"], { KYOLI_OAUTH_BROWSER: "headless" })).toBe("headless");
  });

  it("only auto-opens in browser mode", () => {
    expect(shouldOpenOAuthBrowser("browser")).toBe(true);
    expect(shouldOpenOAuthBrowser("manual")).toBe(false);
    expect(shouldOpenOAuthBrowser("headless")).toBe(false);
  });
});
