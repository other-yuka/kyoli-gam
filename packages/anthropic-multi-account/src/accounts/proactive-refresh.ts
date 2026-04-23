import { createProactiveRefreshQueueForProvider } from "opencode-multi-account-core";
import { getConfig } from "../shared/config";
import { isTokenExpired, refreshToken } from "../oauth/token";
import { debugLog } from "../shared/utils";

export const ProactiveRefreshQueue = createProactiveRefreshQueueForProvider({
  providerAuthId: "anthropic",
  getConfig,
  isTokenExpired,
  refreshToken,
  debugLog,
});

export type ProactiveRefreshQueue = InstanceType<typeof ProactiveRefreshQueue>;
