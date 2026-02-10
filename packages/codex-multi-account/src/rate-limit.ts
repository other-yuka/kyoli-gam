import { createRateLimitHandlers } from "@other-yuka/multi-account-core";
import { getConfig } from "./config";
import { fetchUsage } from "./usage";
import { formatWaitTime, getAccountLabel, showToast } from "./utils";

const {
  fetchUsageLimits,
  getResetMsFromUsage,
  handleRateLimitResponse,
  retryAfterMsFromResponse,
} = createRateLimitHandlers({
  fetchUsage,
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
