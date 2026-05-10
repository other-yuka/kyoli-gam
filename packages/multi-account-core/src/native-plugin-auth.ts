export interface OpenCodeNativeAuthMethod<TResult = unknown> {
  label: string;
  type: "oauth";
  authorize: (...args: unknown[]) => Promise<TResult>;
}

export interface OpenCodeNativeAuthMethodsOptions<TResult = unknown> {
  oauthLabel: string;
  authorize: (inputs?: Record<string, string>) => Promise<TResult>;
}

function toInputs(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, string>;
}

export function createOpenCodeNativeAuthMethods<TResult>(
  options: OpenCodeNativeAuthMethodsOptions<TResult>,
): OpenCodeNativeAuthMethod<TResult>[] {
  return [
    {
      label: options.oauthLabel,
      type: "oauth",
      authorize: async (...args: unknown[]) => options.authorize(toInputs(args[0])),
    },
  ];
}
