import {
  getConfig,
  initCoreConfig,
  loadConfig,
  resetConfigCache,
  updateConfigField,
} from "opencode-multi-account-core";

initCoreConfig("claude-multiauth.json");

export {
  getConfig,
  loadConfig,
  resetConfigCache,
  updateConfigField,
};
