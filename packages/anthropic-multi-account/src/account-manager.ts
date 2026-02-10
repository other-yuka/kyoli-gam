import { createAccountManagerForProvider } from "@other-yuka/multi-account-core";
import { isTokenExpired, refreshToken } from "./token";

export const AccountManager = createAccountManagerForProvider({
  providerAuthId: "anthropic",
  isTokenExpired,
  refreshToken,
});

export type AccountManager = InstanceType<typeof AccountManager>;
