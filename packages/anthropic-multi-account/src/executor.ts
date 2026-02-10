import { createExecutorForProvider } from "@other-yuka/multi-account-core";
import { handleRateLimitResponse as handleRateLimitResponseForProvider } from "./rate-limit";
import { formatWaitTime, getAccountLabel, showToast, sleep } from "./utils";

const { executeWithAccountRotation } = createExecutorForProvider("Anthropic", {
  handleRateLimitResponse: async (manager, client, account, response) =>
    handleRateLimitResponseForProvider(
      manager as Parameters<typeof handleRateLimitResponseForProvider>[0],
      client,
      account,
      response,
    ),
  formatWaitTime,
  sleep,
  showToast,
  getAccountLabel,
});

export { executeWithAccountRotation };
