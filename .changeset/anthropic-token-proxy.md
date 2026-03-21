---
"opencode-multi-account-core": patch
"opencode-anthropic-multi-account": patch
"opencode-codex-multi-account": patch
---

Fix Anthropic multi-auth token refresh handling by proxying token endpoint requests through an external Node process, preserving token lifecycle updates for permanent failures and refresh token rotation. This works around Bun request header behavior documented in oven-sh/bun#17012.
