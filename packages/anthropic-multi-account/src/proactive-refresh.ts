import { createProactiveRefreshQueueForProvider } from "@other-yuka/multi-account-core";
import { getConfig } from "./config";
import { isTokenExpired, refreshToken } from "./token";
import { debugLog } from "./utils";

export const ProactiveRefreshQueue = createProactiveRefreshQueueForProvider({
  getConfig,
  isTokenExpired,
  refreshToken,
  debugLog,
});

export type ProactiveRefreshQueue = InstanceType<typeof ProactiveRefreshQueue>;
