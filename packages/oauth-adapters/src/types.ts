export interface OAuthAdapterTransformConfig {
  rewriteOpenCodeBranding: boolean;
  addToolPrefix: boolean;
  stripToolPrefixInResponse: boolean;
  enableMessagesBetaQuery: boolean;
}

export type OAuthAdapterPlanLabels = Record<string, string>;

export interface OAuthAdapter {
  id: string;
  authProviderId: string;
  modelDisplayName: string;
  statusToolName: string;
  authMethodLabel: string;
  serviceLogName: string;
  oauthClientId: string;
  tokenEndpoint: string;
  usageEndpoint: string;
  profileEndpoint: string;
  oauthBetaHeader: string;
  requestBetaHeader: string;
  cliUserAgent: string;
  toolPrefix: string;
  accountStorageFilename: string;
  transform: OAuthAdapterTransformConfig;
  planLabels: OAuthAdapterPlanLabels;
  supported: boolean;
  unsupportedReason?: string;
}
