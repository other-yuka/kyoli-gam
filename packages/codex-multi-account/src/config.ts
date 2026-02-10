import {
  getConfig,
  initCoreConfig,
  loadConfig,
  resetConfigCache,
  updateConfigField,
} from "@other-yuka/multi-account-core";

initCoreConfig("codex-multiauth.json");

export {
  getConfig,
  loadConfig,
  resetConfigCache,
  updateConfigField,
};
