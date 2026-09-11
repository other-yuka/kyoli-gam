---
"opencode-multi-account-core": patch
"opencode-anthropic-multi-account": patch
"opencode-codex-multi-account": patch
"@kyoli-gam/core": patch
"@kyoli-gam/provider-claude-code": patch
"@kyoli-gam/provider-codex-chatgpt": patch
"@kyoli-gam/gateway": patch
"@kyoli-gam/cli": patch
---

Use active quota windows, provider utilization claims, and distinct Retry-After cooldowns for Claude rate limits. Prevent stale success and usage results from restoring cleared limits across shared and gateway account paths.
