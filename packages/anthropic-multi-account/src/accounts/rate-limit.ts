import { createRateLimitHandlers } from "opencode-multi-account-core";
import { getConfig } from "../shared/config";
import { fetchUsage } from "../usage";
import { formatWaitTime, getAccountLabel, showToast } from "../shared/utils";

const {
  fetchUsageLimits,
  getResetMsFromUsage,
  handleRateLimitResponse,
  retryAfterMsFromResponse,
} = createRateLimitHandlers({
  fetchUsage: async (accessToken: string) => fetchUsage(accessToken),
  getConfig,
  formatWaitTime,
  getAccountLabel,
  showToast,
});

export {
  fetchUsageLimits,
  getResetMsFromUsage,
  handleRateLimitResponse,
  retryAfterMsFromResponse,
};
