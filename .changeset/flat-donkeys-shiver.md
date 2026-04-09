---
"opencode-multi-account-core": patch
"opencode-anthropic-multi-account": patch
"opencode-codex-multi-account": patch
---

Remove shared plugin state that caused load-order collisions across multi-auth providers.

Provider configs and claims are now isolated by filename, account-manager dependencies are injected per provider, and the Anthropic OAuth flow no longer temporarily overwrites the global fetch handler during login.
