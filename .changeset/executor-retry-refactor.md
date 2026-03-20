---
"opencode-multi-account-core": patch
"opencode-anthropic-multi-account": patch
"opencode-codex-multi-account": patch
---

- Complete pi.ai auth flow internally and clean up revoked accounts
- Refactor executor retry logic: convert outer loop to bounded `for`, centralize response status dispatch, extract 5xx server retry helper, and fix 401 fresh-retry bug where non-401 responses bypassed normal status handling
