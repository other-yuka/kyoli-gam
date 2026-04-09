import {
  createConfigLoader,
} from "opencode-multi-account-core";

const configLoader = createConfigLoader("codex-multiauth.json");

export {
  configLoader,
};

export const { getConfig, loadConfig, resetConfigCache, updateConfigField } = configLoader;
