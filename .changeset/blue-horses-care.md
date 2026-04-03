---
"opencode-anthropic-multi-account": patch
"opencode-multi-account-core": patch
---

Fix serve and web provider loading by eagerly initializing Anthropic auth state and using ESM-safe proper-lockfile imports.
