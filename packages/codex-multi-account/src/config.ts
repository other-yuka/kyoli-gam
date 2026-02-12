import {
  getConfig,
  initCoreConfig,
  loadConfig,
  resetConfigCache,
  updateConfigField,
} from "opencode-multi-account-core";

initCoreConfig("codex-multiauth.json");

export {
  getConfig,
  loadConfig,
  resetConfigCache,
  updateConfigField,
};
