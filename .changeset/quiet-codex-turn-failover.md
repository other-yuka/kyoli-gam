---
"opencode-multi-account-core": patch
"opencode-codex-multi-account": patch
---

Hide pre-output Codex quota failures and replay the same request with the next available account. Treat model-capacity failures as bounded same-account retries without putting the account into cooldown.
