import { createAccountManagerForProvider } from "opencode-multi-account-core";
import { isTokenExpired, refreshToken } from "./token";

export const AccountManager = createAccountManagerForProvider({
  providerAuthId: "openai",
  isTokenExpired,
  refreshToken,
});

export type AccountManager = InstanceType<typeof AccountManager>;
