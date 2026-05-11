import { execFile } from "node:child_process";

export type OAuthBrowserMode = "browser" | "manual" | "headless";

export interface BrowserCommand {
  command: string;
  args: string[];
}

export function readOAuthBrowserMode(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): OAuthBrowserMode {
  if (argv.includes("--headless")) return "headless";
  if (argv.includes("--manual") || argv.includes("--no-browser")) return "manual";

  const envMode = env.KYOLI_OAUTH_BROWSER?.toLowerCase();
  if (envMode === "headless") return "headless";
  if (envMode === "manual" || envMode === "no" || envMode === "false" || envMode === "0") {
    return "manual";
  }
  return "browser";
}

export function shouldOpenOAuthBrowser(mode: OAuthBrowserMode): boolean {
  return mode === "browser";
}

export function getOpenBrowserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): BrowserCommand {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function openOAuthBrowser(url: string): void {
  try {
    const { command, args } = getOpenBrowserCommand(url);
    execFile(command, args, { windowsHide: true }, () => {});
  } catch {
    // Browser launch is best-effort; callers always print the URL fallback.
  }
}
