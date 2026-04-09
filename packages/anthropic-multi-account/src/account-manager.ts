import { createAccountManagerForProvider } from "opencode-multi-account-core";
import { getConfig } from "./config";
import { isClaimedByOther, readClaims, writeClaim } from "./claims";
import { isTokenExpired, refreshToken } from "./token";

export const AccountManager = createAccountManagerForProvider({
  providerAuthId: "anthropic",
  getConfig,
  isTokenExpired,
  isClaimedByOther,
  readClaims,
  refreshToken,
  writeClaim,
});

export type AccountManager = InstanceType<typeof AccountManager>;
