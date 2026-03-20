import { loginAnthropic, refreshAnthropicToken } from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials as PiAiOAuthCredentials, OAuthPrompt } from "@mariozechner/pi-ai/oauth";
import { ANTHROPIC_OAUTH_ADAPTER } from "./constants";
import { fetchProfile } from "./usage";
import type { StoredAccount, CredentialRefreshPatch } from "./types";

// pi-ai `expires` is epoch milliseconds: Date.now() + expires_in * 1000 - 5min buffer
// StoredAccount `expiresAt` is also epoch milliseconds → 1:1 mapping, no unit conversion needed.

export function toPiAiCredentials(
  account: Pick<StoredAccount, "accessToken" | "refreshToken" | "expiresAt">,
): PiAiOAuthCredentials {
  return {
    access: account.accessToken ?? "",
    refresh: account.refreshToken,
    expires: account.expiresAt ?? 0,
  };
}

export function fromPiAiCredentials(
  creds: PiAiOAuthCredentials,
): Pick<StoredAccount, "accessToken" | "refreshToken" | "expiresAt"> {
  return {
    accessToken: creds.access,
    refreshToken: creds.refresh,
    expiresAt: creds.expires,
  };
}

export interface LoginWithPiAiCallbacks {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
}

export async function loginWithPiAi(
  callbacks: LoginWithPiAiCallbacks,
): Promise<Partial<StoredAccount>> {
  const piCreds = await loginAnthropic({
    onAuth: callbacks.onAuth,
    onPrompt: callbacks.onPrompt,
    onProgress: callbacks.onProgress,
    onManualCodeInput: callbacks.onManualCodeInput,
  });

  const base = fromPiAiCredentials(piCreds);

  let profileResult = await fetchProfile(piCreds.access);
  if (!profileResult.ok) {
    await new Promise((r) => setTimeout(r, 1000));
    profileResult = await fetchProfile(piCreds.access);
  }
  const profileData = profileResult.ok ? profileResult.data : undefined;

  return {
    ...base,
    email: profileData?.email,
    planTier: profileData?.planTier ?? "",
    addedAt: Date.now(),
    lastUsed: Date.now(),
  };
}

export async function refreshWithPiAi(
  currentRefreshToken: string,
): Promise<CredentialRefreshPatch> {
  const piCreds = await refreshAnthropicToken(currentRefreshToken);

  return {
    accessToken: piCreds.access,
    refreshToken: piCreds.refresh,
    expiresAt: piCreds.expires,
  };
}

export const PI_AI_ADAPTER_SERVICE = ANTHROPIC_OAUTH_ADAPTER.serviceLogName;
