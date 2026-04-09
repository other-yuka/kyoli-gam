import {
  createConfigLoader,
} from "opencode-multi-account-core";

const configLoader = createConfigLoader("claude-multiauth.json");

export {
  configLoader,
};

export const { getConfig, loadConfig, resetConfigCache, updateConfigField } = configLoader;
