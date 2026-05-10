import {
  __openCodeNativeBootstrapAuthTestUtils,
  syncOpenCodeNativeBootstrapAuth,
} from "opencode-multi-account-core";
import { ANTHROPIC_OAUTH_ADAPTER } from "../shared/constants";
import type { AccountStore } from "../accounts/store";
import type { PluginClient } from "../shared/types";

export function syncBootstrapAuth(
  client: PluginClient,
  store: AccountStore,
): Promise<boolean> {
  return syncOpenCodeNativeBootstrapAuth({
    client,
    store,
    providerId: ANTHROPIC_OAUTH_ADAPTER.authProviderId,
  });
}

export const __bootstrapAuthTestUtils = __openCodeNativeBootstrapAuthTestUtils;
