# oauth-adapters

Provider-specific OAuth adapter definitions for multi-account OpenCode plugins. Zero runtime dependencies.

## What's inside

Each adapter defines the full set of provider-specific values needed by the core and plugin packages:

| Field | Example (Anthropic) |
|:------|:--------------------|
| `oauthClientId` | Anthropic OAuth client ID |
| `tokenEndpoint` | `https://console.anthropic.com/v1/oauth/token` |
| `usageEndpoint` | Usage stats API endpoint |
| `profileEndpoint` | User profile API endpoint |
| `accountStorageFilename` | `anthropic-multi-account-accounts.json` |
| `planLabels` | `{ pro: "Claude Pro", free: "Claude Free" }` |
| `toolPrefix` | Tool name prefix required by the provider |
| `cliUserAgent` | User-Agent header to mimic the official CLI |
| `requestBetaHeader` | Required beta header for OAuth requests |

## Available adapters

| Export | Provider |
|:-------|:---------|
| `anthropicOAuthAdapter` | Anthropic (Claude) |
| `openAIOAuthAdapter` | OpenAI (ChatGPT Codex) |

## Usage

```ts
import { anthropicOAuthAdapter } from "opencode-oauth-adapters";

const clientId = anthropicOAuthAdapter.oauthClientId;
const tokenUrl = anthropicOAuthAdapter.tokenEndpoint;
```

## Architecture

This is the bottom layer of the package stack. It has no internal dependencies.

```
  anthropic-multi-account / codex-multi-account
                    │
            multi-account-core
                    │
         oauth-adapters  ← you are here
```
