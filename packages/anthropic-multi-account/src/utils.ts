import { setConfigGetter } from "@other-yuka/multi-account-core";
import { getConfig } from "./config";

setConfigGetter(getConfig);

export {
  createMinimalClient,
  debugLog,
  formatWaitTime,
  getAccountLabel,
  getConfigDir,
  getErrorCode,
  showToast,
  sleep,
} from "@other-yuka/multi-account-core";
