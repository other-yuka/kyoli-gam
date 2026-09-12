---
"opencode-anthropic-multi-account": patch
"@kyoli-gam/provider-codex-chatgpt": patch
---

Guard Anthropic request normalization against non-record content entries, discard nested text blocks with invalid text, and remove the unavailable `gpt-5.4-mini` Codex fallback model.
