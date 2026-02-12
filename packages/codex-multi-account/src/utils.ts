import { setConfigGetter } from "opencode-multi-account-core";
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
} from "opencode-multi-account-core";
